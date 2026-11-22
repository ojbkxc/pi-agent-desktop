/**
 * Provider 中断自愈（API 挂几小时后自动续跑）—— 类型、常量与纯判定。
 *
 * 设计文档：`docs/agents/fork-provider-outage-resume.md`。
 *
 * 分工纪律（与 autofix 的 `lib/autofix/types.ts` 同一套口径）：
 * - 本文件**不 import node:fs / pi SDK**：客户端（设置页、组件）可以直接 import；
 * - 一切状态迁移判据做成纯函数，单测直接锁死；
 * - 状态落盘在 `~/.pi/agent/pi-web/outages/<sessionId>.json`（见 store.ts），
 *   进程重启后由 scheduler 扫描接续。
 *
 * 三条硬约束（勿破）：
 * 1. **永不无限重试**：`deadlineAt` + `maxAttempts` 双闸，触顶转 `expired`。
 * 2. **terminal 类绝不挂起**：401/403/模型不存在/malformed 请求一律按失败上报。
 * 3. **Stop 语义不变**：`aborted` 不写记录、不续跑。
 */

// ───────────────────────────── 常量 ─────────────────────────────

/** 挂起记录版本（落盘格式）。 */
export const OUTAGE_RECORD_VERSION = 1;

/**
 * 退避序列（毫秒）：30s / 1m / 2m / 5m / 10m / 20m / 30m 封顶。
 * `quota` 档从第 4 档（5 分钟）起跳——额度类通常按小时/按周期恢复，短探测没意义。
 */
export const OUTAGE_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000];
/** `quota` 档的起始档位下标（= 5 分钟）。 */
export const OUTAGE_QUOTA_BACKOFF_START_INDEX = 3;
/** 抖动比例：实际延迟 ∈ [base × 0.8, base × 1.2]。 */
export const OUTAGE_JITTER_RATIO = 0.2;

/** 前 N 次探测直接重发续跑提示（连接失败不产生 token，成本≈0）；之后改轻量探针。 */
export const OUTAGE_DIRECT_RETRY_ATTEMPTS = 3;

/** 默认等待上限：outage 6 小时，quota 24 小时。触顶转 expired。 */
export const OUTAGE_DEFAULT_MAX_WAIT_MS = 6 * 3_600_000;
export const OUTAGE_QUOTA_DEFAULT_MAX_WAIT_MS = 24 * 3_600_000;

/** 默认尝试次数上限（与 deadline 双闸，谁先到谁是顶）。 */
export const OUTAGE_DEFAULT_MAX_ATTEMPTS = 40;

/** 恢复后保护：连续 N 次非 outage 失败 ⇒ 判失败，不再挂起。 */
export const OUTAGE_MAX_POST_RESUME_FAILURES = 3;

/** 孤儿判定：pid 缺失/已死且超过此时长未更新 ⇒ 可接续（与 autofix / keepalive 同口径）。 */
export const OUTAGE_STALE_MS = 600_000;

/** 调度器默认 tick（秒级枚举，实际等多久由每条记录的 nextAttemptAt 决定）。 */
export const OUTAGE_DEFAULT_TICK_MS = 30_000;

/** `reason` / `lastError` 落盘上限（字符）。 */
export const OUTAGE_REASON_MAX_CHARS = 2_000;

/** 用户可选的「最长等待」档位（小时）；UI 只暴露这几档。 */
export const OUTAGE_MAX_WAIT_HOURS_OPTIONS: readonly number[] = [1, 2, 6, 24];
export const OUTAGE_DEFAULT_MAX_WAIT_HOURS = 6;
export const OUTAGE_DEFAULT_QUOTA_MAX_WAIT_HOURS = 24;

// ───────────────────────────── 故障分类 ─────────────────────────────

/**
 * 故障四分类：
 * - `transient`：短限流/单次抖动 → 交给 SDK 既有 3 次重试，不挂起；
 * - `outage`：5xx / 连接拒绝 / DNS / 流中断 → **挂起**，长退避探测；
 * - `quota`：额度/欠费类 → **挂起**，但退避更长、文案不同；
 * - `terminal`：401/403、模型不存在、400 参数错 → **不挂起**，按失败上报。
 */
export type OutageKind = "transient" | "outage" | "quota" | "terminal";

/** 挂起的来源作用域（决定恢复时由谁驱动）。 */
export type OutageScope = "chat" | "goal" | "autofix" | "scheduled" | "team" | "campaign";

/** 记录生命周期状态。`waiting` 是唯一会被调度器推进的状态。 */
export type OutageStatus =
  | "waiting"
  | "resumed"
  | "expired"
  | "cancelled"
  | "superseded"
  | "failed";

/** 挂起记录的类型取值（只有这两类会挂起）。 */
export type OutageSuspendKind = Extract<OutageKind, "outage" | "quota">;

export function isOutageSuspendKind(kind: OutageKind): kind is OutageSuspendKind {
  return kind === "outage" || kind === "quota";
}

// ───────────────────────────── 记录 ─────────────────────────────

/**
 * 续跑方式。
 *
 * 实测结论（2026-11-16，`D:/tmp/probe-landing5.mjs`）：用户消息**随当轮首个
 * `message_end` 落盘**，与 assistant 失败条同一批，因此恢复时永远不会缺它——
 * 但**不是 `prompt()` 调用瞬间落盘**：`prompt()` 先跑 before_agent_start（可能
 * 做压缩/注入），期间进程若被杀，原 prompt 会丢。所以记录里**兜底存一份
 * `promptText`**：续跑优先发 followUp 提示（不重发原 prompt）；只有当
 * `guard.lastUserMessageId` 在校验时读不到、但 `promptText` 还在且记录
 * `promptPersisted === false` 时，才按原 prompt 重发。
 */
export type OutageResumeMode = "followup";

export interface OutageOrigin {
  provider?: string | null;
  modelId?: string | null;
}

export interface OutageResumePlan {
  mode: OutageResumeMode;
  /** 续跑提示（由 buildRecoveryNote() + 中断说明拼成；落盘便于重启后原样使用）。 */
  note: string;
  /**
   * 兜底：原用户 prompt 文本。仅当 `promptPersisted !== true` 时恢复逻辑才会
   * 用它重发（理论上提示落下后就不会用到，但实测前不允许假设）。
   */
  promptText?: string;
  /** 挂起时是否已确认该 user 条目落盘（hook 里读到的值）。 */
  promptPersisted?: boolean;
}

export interface OutageBudget {
  /** 已消耗的探测/续跑次数。 */
  attempts: number;
  maxAttempts: number;
  /** 挂起开始的 epoch ms。 */
  startedAt: number;
  /** 硬死线 epoch ms；触顶即 expired。 */
  deadlineAt: number;
  /** 下一次尝试的 epoch ms（调度器只看这个）。 */
  nextAttemptAt: number;
}

export interface OutageGuard {
  /** 挂起时会话里最后一条 user 消息的 entry id：续跑前必须仍是它，否则视为 superseded。 */
  lastUserMessageId?: string | null;
  /** 挂起时会话文件的叶子 entry id（辅助判据）。 */
  leafEntryId?: string | null;
  /** 挂起时 `updatedAt`，用于判定外部改动。 */
  sessionUpdatedAt?: number;
}

export interface OutageRecord {
  version: typeof OUTAGE_RECORD_VERSION;
  sessionId: string;
  kind: OutageSuspendKind;
  /** 失败摘要（capped，供 UI 与注记）。 */
  reason: string;
  scope: OutageScope;
  origin: OutageOrigin;
  resume: OutageResumePlan;
  budget: OutageBudget;
  guard: OutageGuard;
  status: OutageStatus;
  /** 挂起时持有该会话的进程 pid；活着 ⇒ 本进程拥有，不抢。 */
  pid: number | null;
  createdAt: number;
  updatedAt: number;
  /** 恢复后的连续失败计数（非 outage）。达到 OUTAGE_MAX_POST_RESUME_FAILURES 判 failed。 */
  postResumeFailures?: number;
  /** 会话文件路径（重启后重新 startRpcSession 需要它）。 */
  sessionFile?: string | null;
  /** 工作目录（新会话兜底；也可能为空）。 */
  cwd?: string | null;
  /** outlook：调度器最后一次尝试的时间与错误（排障用，UI 不展示原文）。 */
  lastAttemptAt?: number;
  lastError?: string | null;
  /** 结束时间（resumed/expired/cancelled/superseded/failed 时写）。 */
  finishedAt?: number | null;
}

/** 列表接口与设置页用的轻量投影。 */
export interface OutageSnapshot {
  sessionId: string;
  kind: OutageSuspendKind;
  scope: OutageScope;
  status: OutageStatus;
  reason: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  deadlineAt: number;
  updatedAt: number;
}

// ───────────────────────────── 设置 ─────────────────────────────

/**
 * 设置（存在 pi-web settings.json 的 `outage` 键）。
 * 默认：开关**开**、最长等待 6 小时、quota 24 小时。
 */
export interface OutageSettings {
  enabled: boolean;
  /** 普通 outage 的最长等待（小时）；限定在 OUTAGE_MAX_WAIT_HOURS_OPTIONS 内。 */
  maxWaitHours: number;
  /** quota 类的最长等待（小时）；可独立关闭（=0 表示不等待额度恢复）。 */
  quotaMaxWaitHours: number;
}

export const OUTAGE_SETTINGS_DEFAULTS: OutageSettings = {
  enabled: true,
  maxWaitHours: OUTAGE_DEFAULT_MAX_WAIT_HOURS,
  quotaMaxWaitHours: OUTAGE_DEFAULT_QUOTA_MAX_WAIT_HOURS,
};

/** 把任意输入收窄成合法设置；非法值退回默认。 */
export function normalizeOutageSettings(value: unknown): OutageSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...OUTAGE_SETTINGS_DEFAULTS };
  const input = value as Record<string, unknown>;
  const pickHours = (raw: unknown, fallback: number, options: readonly number[]): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
    return options.includes(raw) ? raw : fallback;
  };
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : OUTAGE_SETTINGS_DEFAULTS.enabled,
    maxWaitHours: pickHours(input.maxWaitHours, OUTAGE_SETTINGS_DEFAULTS.maxWaitHours, OUTAGE_MAX_WAIT_HOURS_OPTIONS),
    // 0 = 不等待额度恢复（设计 §10.3 允许用户在设置里关闭额度等待）。
    quotaMaxWaitHours: (() => {
      if (input.quotaMaxWaitHours === 0) return 0;
      return pickHours(input.quotaMaxWaitHours, OUTAGE_SETTINGS_DEFAULTS.quotaMaxWaitHours, OUTAGE_MAX_WAIT_HOURS_OPTIONS);
    })(),
  };
}

/** 某类故障的最大等待毫秒数；0 表示该类不挂起。 */
export function outageMaxWaitMs(kind: OutageSuspendKind, settings: OutageSettings): number {
  return kind === "quota" ? settings.quotaMaxWaitHours * 3_600_000 : settings.maxWaitHours * 3_600_000;
}

// ───────────────────────────── 纯判定 ─────────────────────────────

/** 状态是否还需要调度器推进。 */
export function isWaitingOutage(status: OutageStatus): boolean {
  return status === "waiting";
}

/**
 * 孤儿/归属判据（照 `lib/keepalive/resume.ts:67-94` 的口径，逐字对齐）：
 * 1. `pid` 非空且进程存活 ⇒ `owned`（本进程拥有，不抢；长 agent 轮可能超过任何心跳阈值）；
 * 2. pid 缺失/已死，`now - updatedAt >= staleMs`（默认 10 分钟）⇒ `resumable`；
 * 3. pid 缺失/已死但记录新鲜 ⇒ `waiting`（可能正被本进程的调度器接手）。
 * 非 waiting 状态的记录一律 `finished`。
 */
export type OutageDisposition = "owned" | "resumable" | "waiting" | "finished" | "unknown";

export function classifyOutageRecord(
  record: unknown,
  options: {
    now?: number;
    staleMs?: number;
    alive?: (pid: number) => boolean;
  } = {},
): OutageDisposition {
  if (!isOutageRecord(record)) return "unknown";
  if (!isWaitingOutage(record.status)) return "finished";

  const alive = options.alive ?? defaultIsPidAlive;
  const pid = record.pid;
  if (typeof pid === "number" && pid > 0 && alive(pid)) return "owned";

  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? OUTAGE_STALE_MS;
  const updatedAt = record.updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return "resumable";
  return now - updatedAt >= staleMs ? "resumable" : "waiting";
}

/** 本进程内由调度器接管的条件：没有活着的别的 owner，且没到死的是 stale 判据。 */
export function isOutageResumable(
  record: OutageRecord,
  options: { now?: number; staleMs?: number; alive?: (pid: number) => boolean; selfPid?: number } = {},
): boolean {
  if (!isWaitingOutage(record.status)) return false;
  const disposition = classifyOutageRecord(record, options);
  if (disposition === "resumable") return true;
  const selfPid = options.selfPid ?? process.pid;
  // pid 是本进程：重启后重新扫到的记录也归本进程（旧 pid 已死，上面的 resumable 命中；
  // 这条分支覆盖「同一进程内 scheduler 重启/多实例」的情况）。
  return disposition === "owned" && record.pid === selfPid;
}

/** 记录是否已过期（死线或尝试次数），与 store 的 expire 判定一致。 */
export function isOutageExpired(record: Pick<OutageRecord, "budget">, now: number): boolean {
  return now >= record.budget.deadlineAt || record.budget.attempts >= record.budget.maxAttempts;
}

/** 剩余等待毫秒（不为负）。 */
export function outageRemainingMs(record: Pick<OutageRecord, "budget">, now: number): number {
  return Math.max(0, record.budget.deadlineAt - now);
}

/** 收窄一份未知形状的落盘记录；关键字段缺失返回 null（坏 JSON 降级用）。 */
export function isOutageRecord(value: unknown): value is OutageRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== OUTAGE_RECORD_VERSION) return false;
  if (typeof record.sessionId !== "string" || !record.sessionId) return false;
  if (record.kind !== "outage" && record.kind !== "quota") return false;
  if (typeof record.status !== "string") return false;
  if (!["waiting", "resumed", "expired", "cancelled", "superseded", "failed"].includes(record.status)) return false;
  const budget = record.budget;
  if (typeof budget !== "object" || budget === null) return false;
  const b = budget as Record<string, unknown>;
  if (typeof b.attempts !== "number" || typeof b.maxAttempts !== "number") return false;
  if (typeof b.startedAt !== "number" || typeof b.deadlineAt !== "number") return false;
  if (typeof b.nextAttemptAt !== "number") return false;
  if (typeof record.updatedAt !== "number") return false;
  return true;
}

/**
 * 默认存活判定。本文件也会进客户端 bundle（设置页 import 纯逻辑），所以
 * `process.kill` 不可用时一律按「无法确认」返回 false —— 服务端调用方
 * （scheduler / store）都显式注入自己的 `alive`，不依赖这个兜底。
 */
function defaultIsPidAlive(pid: number): boolean {
  if (typeof process === "undefined" || typeof process.kill !== "function") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 截断到 `max` 字符（保留头部；错误摘要保留原文开头更可读）。 */
export function capOutageText(text: string, max = OUTAGE_REASON_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}