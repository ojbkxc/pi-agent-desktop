/**
 * 常驻会话（pin）与 Router 角色 —— A 能力的**持久层 + 纯逻辑**。
 *
 * 来自 DeepSeek Super-agent 设计的第一层：「常驻的 Router，接住所有人类交互、汇总跨任务
 * 的信息和决策，充当全局记忆。它不直接执行任务，甚至可以不给它 Bash 工具，只管分派。」
 *
 * 落地口径（务实版，避免与既有 agent-teams 重复造轮子）：
 * - **常驻 = 不被 idle 驱逐**。这是调研认定的唯一硬障碍：`lib/rpc-manager.ts` 的
 *   `resetIdleTimer()` 与 `idleCapCandidate()` 都会在
 *   `hasActiveSessionLivenessProvider()` 为真时放过会话。所以 pin 的实现就是
 *   「在会话启动时注册一个恒真的 liveness provider」，不需要改 rpc-manager。
 * - **角色**只影响注入给模型的提示，不改变工具集：`router` 会话收到一段「你是分派者，
 *   用 Agent(run_in_background) 派 Worker、不要自己动手」的 system prompt 截面。
 *   Worker 复用既有 subagent；跨代理通信复用既有 team_message/mailbox。
 * - **持久化**：pin 名单与角色存在 `<agent dir>/pi-web/pinned-sessions.json`。
 *   重启后由 `lib/pinned-sessions-runtime.ts` 在会话恢复时重新注册 provider，
 *   否则「重启就掉 pin」会让这个功能毫无意义。
 *
 * 本文件**不 import node:fs / pi SDK**：UI 与单测可直接 import，读写落在 store。
 */

export const PINNED_SESSIONS_VERSION = 1;

/** 会话角色。`router` 是分派者（常驻），`worker` 是执行者（由 Router 派出）。 */
export type SessionRole = "router" | "worker";

export interface PinnedSession {
  sessionId: string;
  role: SessionRole;
  /** 人类可读的用途说明（如「需求拆解与分派」），用于侧栏与设置页展示。 */
  note?: string;
  /** ISO-8601 (UTC)。 */
  pinnedAt: string;
}

export interface PinnedSessionsFile {
  version: typeof PINNED_SESSIONS_VERSION;
  sessions: PinnedSession[];
}

/** 空文件形态。 */
export function emptyPinnedSessions(): PinnedSessionsFile {
  return { version: PINNED_SESSIONS_VERSION, sessions: [] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isSessionRole(value: unknown): value is SessionRole {
  return value === "router" || value === "worker";
}

/** 磁盘 JSON → PinnedSessionsFile 守卫。坏结构抛错，绝不静默当成空表（否则 pin 全丢）。 */
export function asPinnedSessionsFile(value: unknown, source = "pinned-sessions.json"): PinnedSessionsFile {
  if (!isRecord(value)) throw new Error(`Invalid ${source}: expected an object`);
  if (value.version !== PINNED_SESSIONS_VERSION) {
    throw new Error(`Invalid ${source}: unsupported version ${JSON.stringify(value.version)}`);
  }
  if (!Array.isArray(value.sessions)) throw new Error(`Invalid ${source}: sessions must be an array`);
  const seen = new Set<string>();
  const sessions = value.sessions.map((entry, index): PinnedSession => {
    if (!isRecord(entry)
      || typeof entry.sessionId !== "string" || !entry.sessionId
      || !isSessionRole(entry.role)
      || typeof entry.pinnedAt !== "string"
      || (entry.note !== undefined && typeof entry.note !== "string")) {
      throw new Error(`Invalid ${source}: session ${index} is malformed`);
    }
    if (seen.has(entry.sessionId)) {
      throw new Error(`Invalid ${source}: duplicate sessionId ${entry.sessionId}`);
    }
    seen.add(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      role: entry.role,
      pinnedAt: entry.pinnedAt,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    };
  });
  return { version: PINNED_SESSIONS_VERSION, sessions };
}

/** 纯函数：加/改一条 pin（同 id 覆盖角色与备注，保留原 pinnedAt）。 */
export function upsertPin(
  file: PinnedSessionsFile,
  sessionId: string,
  role: SessionRole,
  note: string | undefined,
  now: string,
): PinnedSessionsFile {
  const existing = file.sessions.find((session) => session.sessionId === sessionId);
  const next: PinnedSession = {
    sessionId,
    role,
    pinnedAt: existing?.pinnedAt ?? now,
    ...(note === undefined ? {} : { note }),
  };
  return {
    version: PINNED_SESSIONS_VERSION,
    sessions: existing
      ? file.sessions.map((session) => (session.sessionId === sessionId ? next : session))
      : [...file.sessions, next],
  };
}

/** 纯函数：取消 pin；不存在时原样返回（幂等）。 */
export function removePin(file: PinnedSessionsFile, sessionId: string): PinnedSessionsFile {
  return {
    version: PINNED_SESSIONS_VERSION,
    sessions: file.sessions.filter((session) => session.sessionId !== sessionId),
  };
}

export function findPin(file: PinnedSessionsFile, sessionId: string): PinnedSession | undefined {
  return file.sessions.find((session) => session.sessionId === sessionId);
}

// ───────────────────────── Router 提示 ─────────────────────────

/** system prompt 截面名：只对 router 角色注入。 */
export const ROUTER_SECTION = "pinned-router";

/**
 * Router 的系统提示。用英文（与 TEAM_NAMING_GUIDE 同理）：服务端拿不到 locale，
 * i18n 只在浏览器 localStorage 里。
 *
 * 三条要点缺一不可：
 * 1. 不要自己动手 —— 否则「常驻分派者」退化成又一个普通会话；
 * 2. 必须 run_in_background —— 前台 Agent 会把 Router 的循环卡住，用户接下来
 *    说的任何话都进不来，正好抵消常驻的意义；
 * 3. 结果会自己回来 —— 告诉它别轮询、别重复派活。
 */
export const ROUTER_GUIDE = `You are the user's long-running dispatcher (a router), not a worker.

How you operate:
1. Keep the overview. The user talks to you across many tasks over time; your job is to hold the whole picture — what is in flight, what finished, what is blocked — and to answer for it in one place.
2. Delegate the actual work. Start workers with the Agent tool, one per independent task, and give each a complete, self-contained brief. Do not do the implementation yourself: do not edit files, do not run builds. If you find yourself reaching for bash or edit, delegate instead.
3. Always use run_in_background: true. A foreground Agent call blocks your own turn, so the user cannot reach you while the worker runs — which defeats the point of being always available. Background workers return immediately.
4. Do not poll. Each background worker reports back here automatically when it finishes. Start independent workers in the same response, then wait for their reports instead of repeatedly calling get_subagent_result.
5. Summarize, do not relay. When a worker reports, give the user the decision-relevant summary: what changed, what it means, what you recommend next. Keep the raw detail out unless the user asks for it.`;

// ───────────────────────── 存储路径 ─────────────────────────

/** `<agent dir>/pi-web/pinned-sessions.json`。路径拼接在 store 里做，这里只给文件名常量。 */
export const PINNED_SESSIONS_FILE_NAME = "pinned-sessions.json";