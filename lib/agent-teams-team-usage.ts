/**
 * GET /api/teams 的只读占用统计（v4 §5 / v8 安全降级 B，纯函数可单测）。
 *
 * 硬边界（设计 §0/§5 + lead 实施单）：
 * - **零副作用**：不写文件、不调 getLifecycle（会凭空建实例）、不碰 registry 的键集——
 *   判实例只允许读 Map（`hasLifecycleInstance` 形态的注入）；
 * - **du 独立容错**：逐团队 try/catch，单团队失败 ⇒ 该团队 `bytes:null + usageError`，
 *   绝不拖垮整个名册响应；每团队 5000 条目预算（超出标 truncated，不放大）；
 * - **ended 判定**：全员 parked/aborted 且 probe=false 才算结束。无实例（重启后）时
 *   磁盘旧态（含 running 旧账）不作数、probe=false 即决定；probe 抛错 ⇒ null（无法判定）；
 * - **无定时器、无自动清理**：≥7 天（IDLE_NOTICE_DAYS）由 UI 仅提示，动作只来自用户显式点击。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** 单团队 du 的条目预算：超出即 truncated（不全局放大）。 */
export const TEAM_USAGE_ENTRY_BUDGET = 5000;
// 闲置提示阈值（天）移入 lib/agent-teams-usage-constants.ts（零 Node 依赖的共用
// 常量模块，#66 复核返工）：本文件顶层 node:fs 不能进 "use client" 图，客户端
// 与后端都必须从常量模块引用，阈值同源不变。这里 re-export 保持既有消费方稳定。
export { TEAM_USAGE_IDLE_NOTICE_DAYS } from "./agent-teams-usage-constants";

export interface TeamUsage {
  /** 团队目录总字节数；目录不可读等故障时为 null（usageError 带原因）。 */
  bytes: number | null;
  /** 已统计的文件数（预算截断时是截断前的实际计数）。 */
  files: number;
  /** 条目预算超出标记。 */
  truncated: boolean;
  /** 目录内最新 mtime（epoch ms）；空目录/不可读为 null。 */
  lastActivityAt: number | null;
  /** 团队是否已结束（null=无法判定，usageError 带原因）。 */
  ended: boolean | null;
  /** 距 lastActivityAt 的天数（≥TEAM_USAGE_IDLE_NOTICE_DAYS 时 UI 仅提示）。 */
  idleDays: number | null;
  /** du 或 ended 判定的失败原因（其余字段尽量如实带出）。 */
  usageError?: string;
}

export interface TeamUsageDeps {
  /** 与 lifecycle 路由同款真探：会话不存在 → false；本模块不吞它的抛错（转 null）。 */
  probeRunning: (sessionId: string) => Promise<boolean>;
  /** 读进程级 registry Map（无副作用形态的判定；绝不 getLifecycle）。 */
  hasLifecycleInstance: (rawTeamName: string) => boolean;
}

/** lifecycle.json / config.json 的最小字段（与 team-actions 的读取口径一致）。 */
interface TeamUsageConfig {
  rawName: string;
  members: Array<{ agentId: string; name: string; sessionId?: string }>;
}

interface LifecycleEntry {
  status?: unknown;
  sessionId?: unknown;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * 递归统计一个目录：总字节、文件数、最新 mtime。条目预算截断。
 *
 * 故障分级（lead 收尾判据：失败必须如实，不可静默当空目录）：
 * - **readdir 失败一律上抛**（EACCES/ENOTDIR/EIO…）——目录级故障不是单文件竞态，
 *   静默返回 [] 会把「读不了」谎报成「空目录」；
 * - **单条 stat 仅 ENOENT 降级跳过**（并发删除的半读，有依据区分），其它错误
 *   （EACCES/EPERM/EIO…）上抛——系统性不可读必须如实报 usageError。
 * 顶层 computeTeamUsage 统一 catch：bytes:null + usageError，绝不拖垮名册。
 */
async function measureDir(
  dir: string,
  budget: { entries: number; truncated: boolean },
): Promise<{ bytes: number; files: number; lastActivityAt: number | null }> {
  const names = await readdir(dir);
  let bytes = 0;
  let files = 0;
  let lastActivityAt: number | null = null;
  for (const name of names) {
    if (budget.entries >= TEAM_USAGE_ENTRY_BUDGET) {
      budget.truncated = true;
      break;
    }
    budget.entries += 1;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (info.isDirectory()) {
        const nested = await measureDir(full, budget);
        bytes += nested.bytes;
        files += nested.files;
        if (nested.lastActivityAt && (lastActivityAt === null || nested.lastActivityAt > lastActivityAt)) {
          lastActivityAt = nested.lastActivityAt;
        }
      } else {
        bytes += info.size;
        files += 1;
        const mtime = info.mtimeMs;
        if (lastActivityAt === null || mtime > lastActivityAt) lastActivityAt = mtime;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // 并发删除的半读：条目已消失，跳过有据。
        continue;
      }
      throw error;
    }
  }
  return { bytes, files, lastActivityAt };
}

/**
 * 计算一个团队的占用。dirFor 由调用方注入（store 的 teamDirFor）。
 * 纯读：调它前后的团队目录内容与 registry 键集必须不变（判别测试 T3）。
 */
export async function computeTeamUsage(
  teamDirName: string,
  dirFor: (name: string) => string,
  deps: TeamUsageDeps,
  now: number = Date.now(),
): Promise<TeamUsage> {
  const teamDir = dirFor(teamDirName);
  let bytes: number | null = null;
  let files = 0;
  let truncated = false;
  let lastActivityAt: number | null = null;
  let usageError: string | undefined;

  try {
    const budget = { entries: 0, truncated: false };
    const measured = await measureDir(teamDir, budget);
    bytes = measured.bytes;
    files = measured.files;
    lastActivityAt = measured.lastActivityAt;
    truncated = budget.truncated;
  } catch {
    // 顶层不可读：bytes 如实 null，ended 判定继续（config 可能仍在，只是目录读不了的概率极低）。
    usageError = "团队目录不可读";
  }

  let ended: boolean | null;
  try {
    ended = await computeTeamEnded(teamDir, deps);
  } catch (error) {
    ended = null;
    usageError = usageError
      ? `${usageError}；ended 判定失败：${error instanceof Error ? error.message : String(error)}`
      : `ended 判定失败：${error instanceof Error ? error.message : String(error)}`;
  }

  return {
    bytes,
    files,
    truncated,
    lastActivityAt,
    ended,
    idleDays: lastActivityAt !== null ? Math.floor((now - lastActivityAt) / 86_400_000) : null,
    ...(usageError ? { usageError } : {}),
  };
}

/** config/lifecycle 的最小读取（与 team-actions 的磁盘口径一致；缺文件回 null/空表）。 */
export async function readTeamUsageConfig(
  teamDir: string,
): Promise<TeamUsageConfig | null> {
  const config = await readJson<{
    name?: unknown;
    members?: Array<{ agentId?: unknown; name?: unknown; sessionId?: unknown }>;
  }>(join(teamDir, "config.json"));
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

/**
 * 团队是否已结束：**全员** parked/aborted（账面）且 probe=false（运行体）。
 * - 实例在（本进程跑过）：账面必须是 parked/aborted——idle 在 2 分钟 TTL 窗口内，算活跃；
 * - 实例不在（重启后）：磁盘旧态（含 running 旧账）不作数，probe=false 即决定（v4 §2 同款）；
 * - probe 抛错 ⇒ 抛给上层转 null（无法判定，不是 false）；
 * - 无名册/无 config ⇒ null（无法判定——一个不存在或损坏的团队谈不上「已结束」）。
 */
export async function computeTeamEnded(teamDir: string, deps: TeamUsageDeps): Promise<boolean | null> {
  const config = await readTeamUsageConfig(teamDir);
  if (!config || !config.members.length) return null;
  const rawName = config.rawName;
  if (!rawName) return null;

  const lifecycle = await readJson<{ members?: Record<string, LifecycleEntry> }>(
    join(teamDir, "lifecycle.json"),
  );
  const entries = lifecycle?.members && typeof lifecycle.members === "object" ? lifecycle.members : {};
  const hasInstance = deps.hasLifecycleInstance(rawName);

  for (const member of config.members) {
    const entry = entries[member.name];
    if (hasInstance && entry && typeof entry.status === "string") {
      // 有实例且账面有条目：必须是 parked/aborted（idle 在 2 分钟 TTL 窗口内算活跃）。
      // 无条目 = 从未派发（pi-team 不为未跑成员建账），不阻碍「团队已结束」，
      // 与 config 记的旧 sessionId 一并交给下面的 probe 段。
      if (entry.status !== "parked" && entry.status !== "aborted") return false;
    }
    const sessionId = (typeof entry?.sessionId === "string" ? entry.sessionId : undefined) ?? member.sessionId;
    if (sessionId) {
      const running = await deps.probeRunning(sessionId);
      if (running) return false;
    }
    // 无实例分支：磁盘旧态任意（含 stale running），probe=false 即通过；
    // 无 sessionId 的成员 = 从未派发 = 不阻碍「团队已结束」。
  }
  return true;
}
