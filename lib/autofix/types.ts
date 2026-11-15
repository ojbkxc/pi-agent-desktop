/**
 * 「自动修 Bug」的**类型与纯逻辑**。
 *
 * 工作流：用户给一句任务说明（例如「这个 bug 不修好，CI 过不去」），服务端开一个
 * agent 会话带全套编辑工具修代码；每一轮 agent 结束后由**引擎自己**跑验证命令
 * （`verifyCommand`，默认从 package.json 探测，兜底 `npm test`），exit code 0 才算
 * 修好；否则把失败输出尾部喂回下一轮，直到通过或撞 `maxRounds` 上限（默认 20）。
 *
 * 约束（勿破）：
 * - 本文件**不 import node:fs / pi SDK**：客户端（组件、hook）直接 import 它；
 * - 状态迁移判据都做成纯函数（孤儿判定 / 汇总），单测直接锁死；
 * - 进度落盘供「挂机保活」（t4）接续，字段口径与 keepalive-engineer 约定：
 *   任务说明 / 当前轮次 / 最后错误 / 状态 / cwd / sessionId / pid / updatedAt。
 */

// ───────────────────────────── 常量 ─────────────────────────────

/** 默认轮次上限：一轮 = 一次 agent 回合 + 一次验证。 */
export const AUTOFIX_DEFAULT_MAX_ROUNDS = 20;
/** 用户可配置的轮次上限（1..MAX）。 */
export const AUTOFIX_MAX_ROUNDS = 20;
/** 任务说明的最大长度（用户输入）。 */
export const AUTOFIX_TASK_MAX_LENGTH = 4000;
/** 验证命令的最大长度。 */
export const AUTOFIX_VERIFY_MAX_LENGTH = 500;
/** `lastError` 落盘上限（字符）。 */
export const AUTOFIX_ERROR_MAX_CHARS = 2000;
/** 一轮验证输出落盘上限（字符）。 */
export const AUTOFIX_OUTPUT_TAIL_MAX_CHARS = 4000;
/** 每个任务保留的轮次记录上限（更早的丢弃，任务本身还有 round/lastError）。 */
export const AUTOFIX_MAX_ROUND_RECORDS = 50;
/** 同时存在的任务上限（防止目录无限膨胀）。 */
export const AUTOFIX_MAX_TASKS = 50;
/** 孤儿判定：pid 缺失时，多久没更新才视为「无人驱动」（10 分钟，与 keepalive 约定一致）。 */
export const AUTOFIX_STALE_MS = 600_000;
/** 单轮 agent 回合超时（毫秒）：超时即中止该轮，按失败轮记录后继续/结束。 */
export const AUTOFIX_TURN_TIMEOUT_MS = 20 * 60_000;
/** 验证命令超时（毫秒）。 */
export const AUTOFIX_VERIFY_TIMEOUT_MS = 10 * 60_000;
/** 给修复会话钉的工具集：读 / 改 / 写 / 跑命令。 */
export const AUTOFIX_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export const AUTOFIX_STATUSES = [
  "queued",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "exhausted",
  "stopped",
] as const;
export type AutofixStatus = (typeof AUTOFIX_STATUSES)[number];

export const AUTOFIX_ROUND_STATUSES = [
  "agent-done",
  "agent-error",
  "verify-passed",
  "verify-failed",
  "timeout",
] as const;
export type AutofixRoundStatus = (typeof AUTOFIX_ROUND_STATUSES)[number];

// ───────────────────────────── 数据 ─────────────────────────────

/** 一轮的落地记录（供 UI 时间线与排障）。 */
export interface AutofixRound {
  /** 轮次号，从 1 起。 */
  round: number;
  /** 记录时间（epoch ms）。 */
  at: number;
  status: AutofixRoundStatus;
  /** 验证命令的 exit code；agent 阶段失败/超时为 null。 */
  verifyExitCode: number | null;
  /** 失败摘要（agent 报错 / 验证失败尾），capped。 */
  error?: string;
  /** 验证输出尾部（capped），供下一轮 prompt 与 UI 展示。 */
  outputTail?: string;
}

/**
 * 一个自动修 Bug 任务（v1 落盘格式）。
 *
 * 保活接续口径（与 keepalive-engineer 约定）：
 * `status ∈ {queued,running,verifying}` 即活跃；`pid` 是**驱动进程**（Next server
 * 进程，不是 agent 会话进程）。pid 活着 ⇒ 绝不判孤儿；pid 缺失/已死时才看
 * `updatedAt`（见 `isAutofixTaskResumable`）。
 */
export interface AutofixTask {
  version: 1;
  id: string;
  /** 用户任务说明原句。 */
  task: string;
  /** 工作目录（修复与验证都在这里跑）。 */
  cwd: string;
  /** 验证命令；exit code 0 即「修好」。 */
  verifyCommand: string;
  status: AutofixStatus;
  /** 已完成的 agent 轮数（从 1 起计；0 = 还没开始）。 */
  round: number;
  maxRounds: number;
  /** 最近一次失败摘要，修好后保留（UI 用来显示「上一条错误」）。 */
  lastError: string | null;
  /** 修复会话 id：可打开对话查看过程，也可被保活直接 POST 消息唤醒。 */
  sessionId: string | null;
  /** 当前驱动进程 pid（= Next server 进程）；空闲/结束时为 null。 */
  pid: number | null;
  createdAt: number;
  /** 心跳：任何状态推进都刷新。 */
  updatedAt: number;
  finishedAt: number | null;
  /** 轮次记录（capped 到 AUTOFIX_MAX_ROUND_RECORDS）。 */
  rounds: AutofixRound[];
}

/** 列表页 + 保活共用的汇总。 */
export interface AutofixSummary {
  total: number;
  /** 活跃任务（queued / running / verifying）。 */
  active: number;
  /** 活跃但无活着的驱动进程（pid 死/缺失且过期）——保活该接续的数量。 */
  stuck: number;
  succeeded: number;
  /** failed + exhausted。 */
  failed: number;
}

export type AutofixEvent =
  | { type: "task_changed"; taskId: string; status: AutofixStatus }
  | { type: "task_removed"; taskId: string };

/** 纯判定：状态是否活跃（可能还需要驱动）。 */
export function isActiveAutofixStatus(status: AutofixStatus): boolean {
  return status === "queued" || status === "running" || status === "verifying";
}

/** 纯判定：状态是否已终结。 */
export function isTerminalAutofixStatus(status: AutofixStatus): boolean {
  return !isActiveAutofixStatus(status);
}

export interface ResumableOptions {
  now: number;
  staleMs?: number;
  /** 默认不注入 = 视为「无法确认存活」，交给 updatedAt 过期判断。 */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * 纯判定：这个任务是否「该由保活/接续驱动」。
 *
 * - 非活跃状态 → false；
 * - `queued` 且无 owner → true（等一个驱动者立刻接手）；
 * - `pid` 非空：活着 → false（绝不抢）；死了 → true（驱动进程已消失）；
 * - `pid` 缺失：只有 `updatedAt` 超过 `staleMs` 才 true（旧记录没有心跳）。
 */
export function isAutofixTaskResumable(task: AutofixTask, options: ResumableOptions): boolean {
  if (!isActiveAutofixStatus(task.status)) return false;
  if (task.status === "queued" && (task.pid === null || task.pid === undefined)) return true;
  if (typeof task.pid === "number") {
    const alive = options.isPidAlive?.(task.pid);
    return alive === true ? false : true;
  }
  return options.now - task.updatedAt >= (options.staleMs ?? AUTOFIX_STALE_MS);
}

/** 纯汇总：供列表页与保活状态展示。 */
export function summarizeAutofixTaskList(
  tasks: readonly AutofixTask[],
  options: ResumableOptions,
): AutofixSummary {
  let active = 0;
  let stuck = 0;
  let succeeded = 0;
  let failed = 0;
  for (const task of tasks) {
    if (isActiveAutofixStatus(task.status)) {
      active += 1;
      if (isAutofixTaskResumable(task, options)) stuck += 1;
      continue;
    }
    if (task.status === "succeeded") succeeded += 1;
    else if (task.status === "failed" || task.status === "exhausted") failed += 1;
  }
  return { total: tasks.length, active, stuck, succeeded, failed };
}

/** 截断到 `max` 字符（保留尾部，失败输出最有价值的通常是末尾）。 */
export function tailOf(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}

/**
 * 入参校验错误。`key` 是 i18n 键（`autofix.error.*`），`message` 是英文兜底；
 * UI 拿到 `{ code: "validation", key, params }` 后用 `t(key, params)` 显示。
 *
 * 用 `name` 判定而不是 `instanceof`：路由与 store 可能在不同 module graph 里
 * （Next 的 bundling 会各带一份类），`instanceof` 不可靠（同 scheduled-tasks/types.ts）。
 */
export class AutofixValidationError extends Error {
  readonly code = "validation";
  constructor(
    message: string,
    readonly key?: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "AutofixValidationError";
  }
}

export function isAutofixValidationError(error: unknown): error is AutofixValidationError {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AutofixValidationError";
}
