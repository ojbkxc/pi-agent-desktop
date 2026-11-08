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
  /**
   * 判停证据（v8 安全降级 B，如实透出）：
   * - `receipt`            实例在：release 回执 parked + generation 前进；
   * - `receipt+probe`      实例在：回执之后对会话真探未运行（reclaim 必走）；
   * - `disk`               无实例：磁盘 config/lifecycle 有名无 sessionId（从未派发）；
   * - `disk+probe`         无实例：磁盘旧态 + 会话真探未运行；
   * - `disk+probe+stale-running` 无实例：磁盘残留 running 旧态 + 真探未运行（重启前旧账）。
   */
  evidence?: string;
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
  /**
   * 探测某成员会话是否仍在运行。实现由 route 提供（惰性 import lib/rpc-manager 的
   * `getRpcSession(sessionId)?.isRunning()`，避免把 pi SDK 拖进纯模块）。
   *
   * **为什么必须真探**：`release` 吞掉 `host.stop` 的异常（pi-team teamLifecycle.js:182-199），
   * 所以「回执 = parked + generation 前进」只证明 pi-team **记了账**，**不证明会话真停了**。
   * 对 stop 已够用；但 reclaim 之后要删目录 + 清实例——若会话仍在跑，就会造出一个
   * 没有任何生命周期记录的**孤儿会话**（从配额里隐身）。故 reclaim 的前置条件「全员已停」
   * 必须由「回执」升级为「回执 + 真探」。
   *
   * 约定：会话不存在 / 从未派发（getRpcSession 返回 undefined）→ 返回 false（视为已停）；
   * 探测本身抛错 → 本模块**不当作已停**（见下），由调用方如实记 failed。
   */
  probeRunning: (sessionId: string) => Promise<boolean>;
  /**
   * reclaim 删除前的路径边界验证（v4 §3，最后防线）。实现由 route 注入；
   * 返回 null = 通过，返回字符串 = 拒绝原因（如实透出，绝不 rm）。
   * 可选：不注入时跳过（旧单测兼容），route 必须注入。
   *
   * 四道守卫由实现方保证：config 重读 rawName 非空；realpath 后目录位于 teamsRootDir
   * 直下；目录本体非 symlink/junction（lstat + realpath 双向比对）；只 rm 唯一目录。
   */
  validateTeamDirForRemoval?: (teamDirName: string) => Promise<string | null>;
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

  // 2) 实例分支（v4 §2）：实例在 → 走 release 全链；实例不在 → 磁盘 + probe 双证据，
  //    不再直接 409（否则重启后盘上团队永远无法 reclaim）。两条路径都绝不裸 getLifecycle——
  //    这里的 hasLifecycleInstance 只读 registry Map，无副作用。
  //    hasInstanceAtEntry 是删除前双检的基准（入口快照），见 reclaim 段注释。
  const hasInstanceAtEntry = deps.hasLifecycleInstance(rawTeamName);
  const lifecycle = await deps.readLifecycle(teamDirName);
  const results: TeamActionMemberResult[] = [];

  if (!hasInstanceAtEntry) {
    // ── 无实例分支：跳过 release。判停依据 = 磁盘 lifecycle.json 旧态（任意状态均可，
    //    running 视为重启前旧账）+ 会话真探（probe=false 才判停；抛错/true 拒删）。
    for (const member of members) {
      const entry = lifecycle[member.name];
      const sessionId = entry?.sessionId ?? member.sessionId;
      if (sessionId) {
        let running: boolean;
        try {
          running = await deps.probeRunning(sessionId);
        } catch (error) {
          // 探测抛错不当作已停——不能因为「探不到」就宣称停成功。
          results.push({
            memberId: member.agentId,
            name: member.name,
            status: "failed",
            reason: `无法确认会话是否已停（探测会话运行态出错）：${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        if (running) {
          results.push({
            memberId: member.agentId,
            name: member.name,
            status: "failed",
            reason: `会话仍在运行（sessionId=${sessionId}），不能回收`,
          });
          continue;
        }
        results.push({
          memberId: member.agentId,
          name: member.name,
          status: "already-stopped",
          evidence: entry?.status === "running" ? "disk+probe+stale-running" : "disk+probe",
        });
        continue;
      }
      // 有名册无 sessionId 且无 lifecycle 条目 = 从未派发过，磁盘即全部证据。
      results.push({
        memberId: member.agentId,
        name: member.name,
        status: "already-stopped",
        evidence: "disk",
      });
    }
  } else {
    // ── 实例在：既有全链（release → 回执校验 → reclaim 真探）。逐成员顺序处理。
    // 显式动作的强制语义（v4 §1b + v8 收口）：对**每个**成员都执行 release，
    // 账面 parked/aborted 只是旧账，不证明用户本次「强制停止」已执行——跳过它们
    // 会把「旧账 parked、实际仍 running」的状态谎报成 already-stopped。
    // 可重复性证据（pi-team teamLifecycle.js）：release 先 #apply（对已在表里的
    // parked/aborted 条目照样更新、generation 无条件 +1）再吞异常调 host.stop——
    // 对任何账面状态都正常 resolve，重复 release 安全。
    for (const member of members) {
      const before = lifecycle[member.name];

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

        // 回执只证明「pi-team 记了账（已 parked）」，**不证明会话真停了**：release 吞掉 host.stop
        // 异常。reclaim 之后要删目录 + 清实例，若会话仍在跑就会造出无生命周期记录的孤儿会话。
        // 故回执通过后再真探一次运行态。会话口径与上面一致：lifecycle 条目优先，回退 config 名册。
        const sessionId = after.sessionId ?? before?.sessionId ?? member.sessionId;
        if (sessionId) {
          let running: boolean;
          try {
            running = await deps.probeRunning(sessionId);
          } catch (error) {
            // 探测抛错**不当作已停**——不能因为「探不到」就宣称停成功。
            results.push({
              memberId: member.agentId,
              name: member.name,
              status: "failed",
              reason: `无法确认会话是否已停（探测会话运行态出错）：${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
          }
          if (running) {
            results.push({
              memberId: member.agentId,
              name: member.name,
              status: "failed",
              reason: `release 回执已置 parked，但会话仍在运行（sessionId=${sessionId}）`,
            });
            continue;
          }
        }

        results.push({
          memberId: member.agentId,
          name: member.name,
          status: "stopped",
          ...(sessionId ? { evidence: "receipt+probe" as const } : { evidence: "receipt" as const }),
        });
      } catch (error) {
        results.push({
          memberId: member.agentId,
          name: member.name,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const ok = results.every((result) => result.status !== "failed");

  // 4) 仅 reclaim 且全部成功才删目录——不可逆操作，任一失败都不动它。
  //    删除前两道最后防线（v4 §2 双检 + §3 路径边界），任一未过 ⇒ 拒删、如实报错。
  if (action === "reclaim" && ok) {
    // 删除前双检——**必须与入口快照比较，不可一律拒**：
    // - 入口走 release 分支（实例在）：release 只置 parked、不清 registry，删除前实例
    //   仍然存在是**正常状态**，据此拒删会让有实例的 reclaim 永远失败；
    // - 入口走磁盘+probe 分支（实例不在）：判停至今的窗口内出现实例 = 有人复活/新建了
    //   团队，「全员已停」的结论随新实例作废，必须拒删并如实报错。
    if (!hasInstanceAtEntry && deps.hasLifecycleInstance(rawTeamName)) {
      return {
        ...base,
        ok: false,
        results,
        error: "删除前检测到团队生命周期实例重新出现（入口时不存在，可能已被复活或新建），未删除目录",
      };
    }
    // 路径边界验证：realpath 直下断言、非 symlink/junction、config 重读 rawName 非空。
    if (deps.validateTeamDirForRemoval) {
      const rejection = await deps.validateTeamDirForRemoval(teamDirName);
      if (rejection) {
        return {
          ...base,
          ok: false,
          results,
          error: `路径边界验证未通过，未删除目录：${rejection}`,
        };
      }
    }

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