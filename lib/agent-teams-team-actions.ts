/**
 * 团队生命周期编排（服务端专用）：停止 / 回收。
 *
 * pi-team 没有团队级的停止/删除编排函数，只有逐成员的生命周期操作，桌面侧在这里补齐。
 * 语义映射（三档，别混）：
 *   - `park`                  只标记、不 stop 会话（2 分钟 TTL）→ 投影里的「已挂起」，**不是**停止团队；
 *   - `release(tombstone:false)` 逐成员 stop 且保留 sessionFile，可复活 → **本模块的 stop**；
 *   - `release(tombstone:true)`  = team_cancel，终止不可复活（本模块不使用）。
 *
 * 两个必须处理的坑：
 *   1. **生命周期 registry 的 key 是 config.json 的 `team.name`（原始团队名），不是 sanitize 后的目录名。**
 *      拿目录名当 key 会新建一个空实例、把真实例晾在一边，表现为「停止成功但什么都没停」。
 *   2. **`getLifecycle()` 在实例不存在时会「创建」一个**，而 `release()` 内部**吞掉** host.stop 的
 *      异常（只有 PI_TEAM_DEBUG 才打印）。所以调用前必须先确认实例已存在，调用后必须**读回执**校验，
 *      不能凭 `release()` 没抛错就报成功。
 *
 * 本模块不 import pi-team：依赖全部由调用方注入（route 负责接真实的 registry / 磁盘），
 * 因此可以纯单测。仅 import 类型与路径助手。
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** 停止团队时逐成员的生命周期操作（对应 release(tombstone:false)）。 */
export type TeamLifecycleAction = "stop" | "reclaim";

export interface TeamActionMemberResult {
  memberId: string;
  name: string;
  /** stopped=本次停成功；already-stopped=本来就已停；failed=失败（含原因）。 */
  status: "stopped" | "already-stopped" | "failed";
  reason?: string;
}

export interface TeamActionResponse {
  /** 目录名（sanitize 后，HTTP 契约里的 [team]）。 */
  team: string;
  action: TeamLifecycleAction;
  /** 全部成员都 stopped / already-stopped 才为 true。 */
  ok: boolean;
  /** 团队目录是否真的被删除（仅 reclaim 且 ok 时才可能为 true）。 */
  removed: boolean;
  results: TeamActionMemberResult[];
  /** ok=false 时的整体原因（如「团队不存在」「生命周期实例不存在」）。 */
  error?: string;
  /**
   * 仅 reclaim 成功后出现：进程内残留实例（lifecycle / bus）的清理结果。
   * best-effort —— 清理失败**不影响** ok / removed（目录已删是既成事实），但要如实带出。
   */
  cleanup?: TeamInstanceCleanup;
}

/** 进程内残留实例的清理结果。 */
export interface TeamInstanceCleanup {
  /** 该团队在 __piTeamLifecycles 里是否命中并被移除。 */
  lifecycle: boolean;
  /** 该团队在 __piTeamBuses 里是否命中并被移除。 */
  bus: boolean;
  /** 清理过程中出现的异常（有值时上面的布尔可能不全）。 */
  error?: string;
}

/** 生命周期条目里本模块需要的字段（不 import pi-team 的类型）。 */
export interface LifecycleSnapshotEntry {
  name: string;
  status: string;
  generation?: number;
  sessionId?: string;
}

export interface TeamActionDeps {
  /**
   * 按**目录名**读 config.json：返回原始团队名（config.name，registry key）与名册成员。
   * 团队不存在返回 null。
   */
  readTeamConfig: (teamDirName: string) => Promise<{
    rawName: string;
    members: Array<{ agentId: string; name: string; sessionId?: string }>;
  } | null>;
  /** 按**目录名**读 lifecycle.json 的成员条目（缺文件返回空表）。 */
  readLifecycle: (teamDirName: string) => Promise<Record<string, LifecycleSnapshotEntry>>;
  /** 按**原始团队名**（config.name）判断本进程是否已有该团队的生命周期实例。 */
  hasLifecycleInstance: (rawTeamName: string) => boolean;
  /** 按原始团队名对某成员执行 release(tombstone:false)，返回操作后的条目。 */
  release: (rawTeamName: string, memberName: string) => Promise<LifecycleSnapshotEntry>;
  /** 删除团队目录（不可逆）。 */
  removeTeamDir: (teamDirName: string) => Promise<void>;
  /**
   * reclaim 成功后 best-effort 清理该团队在本进程的残留实例（lifecycle + bus）。
   *
   * 实现由 route 提供（宿主侧复刻 pi-team 未从根导出的 dropLifecycle / dropBus）。
   * 可选：不注入时跳过清理（stop 路径本就不清）。实现抛错也会被本模块兜住，绝不外泄。
   */
  dropInstances?: (rawTeamName: string) => Promise<TeamInstanceCleanup>;
}

/** 已停态：parked 与 aborted 都无需再停（aborted 是 tombstone）。 */
function isStoppedStatus(status: string | undefined): boolean {
  return status === "parked" || status === "aborted";
}

/**
 * 停止或回收一个团队。**强顺序 + 回执校验 + 失败即中止**：
 *
 * - 逐成员顺序处理（不并发）：reclaim 的删除依赖「全部成员都已停」；
 * - 每个成员都读回执校验（release 吞异常，不能凭没抛错就认成功）；
 * - 任一成员 failed → 整体 ok=false；**reclaim 绝不删目录**（removed:false）。
 *
 * 已停成员（parked/aborted）计入 already-stopped，不重复 release。
 *
 * ── 关于「idle 成员能否 reclaim」的结论（已核对 pi-team 源码）─────────────────────
 * 曾担心：idle 成员的 host.stop 会抛 `Subagent is not running`（lib/subagent-runtime.ts `abort`），
 * 使 reclaim 被误判 failed。**核对后此担忧不成立**，依据两段 pi-team 代码：
 *   1. teamLifecycle.js `#apply`：成员不在表里 / 已 parked / 从未派发，都会照样建/更新条目并把
 *      `generation` 无条件 +1（`next.generation = current.generation + 1`，expected 为 undefined 时不过滤）；
 *   2. teamLifecycle.js `release`：先 `#apply` 写 `status: 'parked'`，**之后**才
 *      `try { await host.stop(...) } catch (e) { if (PI_TEAM_DEBUG) console.error(...) }`
 *      —— 异常被吞、不外抛。
 * 所以 `release(name,{tombstone:false})` 对 idle / 已死 / 从未派发的成员都正常 resolve，
 * 回执为 parked 且代数前进，本模块判其 `stopped`。abort 抛错只发生在 host 内部，永不到达这里。
 */
export async function runTeamLifecycleAction(
  deps: TeamActionDeps,
  input: { teamDirName: string; action: TeamLifecycleAction },
): Promise<TeamActionResponse> {
  const { teamDirName, action } = input;
  const base = { team: teamDirName, action, removed: false } as const;

  // 1) 磁盘是真相来源：config.json 必须在，且拿到**原始团队名**（registry key）。
  const config = await deps.readTeamConfig(teamDirName);
  if (!config) {
    return { ...base, ok: false, results: [], error: "团队不存在" };
  }
  const members = config.members;
  const rawTeamName = config.rawName;
  if (!rawTeamName) {
    return { ...base, ok: false, results: [], error: "团队配置缺少 name，无法定位生命周期实例" };
  }

  // 2) 实例必须已存在：getLifecycle 会凭空创建，绝不能拿它当探测。
  if (!deps.hasLifecycleInstance(rawTeamName)) {
    return {
      ...base,
      ok: false,
      results: members.map((member) => ({
        memberId: member.agentId,
        name: member.name,
        status: "failed" as const,
        reason: "生命周期实例不存在（团队未被本进程加载）",
      })),
      error: "生命周期实例不存在",
    };
  }

  const lifecycle = await deps.readLifecycle(teamDirName);
  const results: TeamActionMemberResult[] = [];

  // 3) 逐成员顺序停止 + 回执校验。
  for (const member of members) {
    const before = lifecycle[member.name];
    if (isStoppedStatus(before?.status)) {
      results.push({ memberId: member.agentId, name: member.name, status: "already-stopped" });
      continue;
    }

    try {
      const after = await deps.release(rawTeamName, member.name);
      // 回执校验：release(tombstone:false) 必须把成员落到 parked，且代数前进；
      // release 内部吞异常，只看「没抛错」会把静默失败报成成功。
      const advanced = typeof before?.generation !== "number"
        || typeof after.generation !== "number"
        || after.generation > before.generation;
      if (after.status !== "parked" || !advanced) {
        results.push({
          memberId: member.agentId,
          name: member.name,
          status: "failed",
          reason: `停止回执异常（status=${after.status}${advanced ? "" : "，代数未前进"}）`,
        });
        continue;
      }
      results.push({ memberId: member.agentId, name: member.name, status: "stopped" });
    } catch (error) {
      results.push({
        memberId: member.agentId,
        name: member.name,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = results.every((result) => result.status !== "failed");

  // 4) 仅 reclaim 且全部成功才删目录——不可逆操作，任一失败都不动它。
  if (action === "reclaim" && ok) {
    try {
      await deps.removeTeamDir(teamDirName);
    } catch (error) {
      return {
        ...base,
        ok: false,
        removed: false,
        results,
        error: `停止已完成，但删除团队目录失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 目录已删（removed 是既成事实，不受清理影响）。best-effort 清掉进程内残留实例——
    // 不清的话同名团队再建会复用已 dispose、状态陈旧的旧实例。
    const cleanup = await cleanupInstances(deps, rawTeamName);
    return { ...base, ok: true, removed: true, results, ...(cleanup ? { cleanup } : {}) };
  }

  return { ...base, ok, removed: false, results, ...(ok ? {} : { error: "有成员停止失败，未删除团队目录" }) };
}

/**
 * best-effort 清理进程内实例：清理失败**不能**影响「目录已删」这个结论，
 * 但要在响应里如实带出（绝不静默吞掉）。
 */
async function cleanupInstances(
  deps: TeamActionDeps,
  rawTeamName: string,
): Promise<TeamInstanceCleanup | undefined> {
  if (!deps.dropInstances) return undefined;
  try {
    return await deps.dropInstances(rawTeamName);
  } catch (error) {
    return {
      lifecycle: false,
      bus: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 磁盘默认实现（route 用；单测换假实现即可）
// ─────────────────────────────────────────────────────────────────────────────

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 读 config.json：返回名册成员，并原样带出原始团队名。团队不存在返回 null。 */
export async function readTeamConfig(
  teamDirName: string,
  dirFor: (name: string) => string,
): Promise<{ rawName: string; members: Array<{ agentId: string; name: string; sessionId?: string }> } | null> {
  const config = await readJson<{
    name?: unknown;
    members?: Array<{ agentId?: unknown; name?: unknown; sessionId?: unknown }>;
  }>(join(dirFor(teamDirName), "config.json"));
  if (!config || !Array.isArray(config.members)) return null;
  const members = config.members
    .filter((item) => typeof item?.agentId === "string" && typeof item?.name === "string")
    .map((item) => ({
      agentId: item.agentId as string,
      name: item.name as string,
      ...(typeof item.sessionId === "string" && item.sessionId ? { sessionId: item.sessionId } : {}),
    }));
  return { rawName: typeof config.name === "string" ? config.name : "", members };
}

/** 读 lifecycle.json 的成员表（缺文件/损坏返回空表）。 */
export async function readLifecycleSnapshot(
  teamDirName: string,
  dirFor: (name: string) => string,
): Promise<Record<string, LifecycleSnapshotEntry>> {
  const file = await readJson<{ members?: Record<string, LifecycleSnapshotEntry> }>(
    join(dirFor(teamDirName), "lifecycle.json"),
  );
  return file?.members && typeof file.members === "object" ? file.members : {};
}

/** 删除团队目录（递归）。 */
export async function removeTeamDirectory(
  teamDirName: string,
  dirFor: (name: string) => string,
): Promise<void> {
  await rm(dirFor(teamDirName), { recursive: true, force: true });
}

/** 团队目录是否存在（用于 route 的 404 判定之外的诊断）。 */
export async function teamDirExists(
  teamDirName: string,
  dirFor: (name: string) => string,
): Promise<boolean> {
  try {
    await readdir(dirFor(teamDirName));
    return true;
  } catch {
    return false;
  }
}