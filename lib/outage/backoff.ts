/**
 * 挂起退避（纯函数，随机源可注入以便确定性测试）。
 *
 * 序列：`30s, 1m, 2m, 5m, 10m, 20m, 30m(封顶)` + ±20% 抖动。
 * `quota` 档从 5 分钟（下标 3）起跳、同一个 30 分钟封顶——额度按小时/周期恢复，
 * 短探测没有意义，长探测又不能无限（有 `deadlineAt` 兜底）。
 *
 * 触顶（次数或死线）转 `expired`；调用方负责落盘。
 */

import {
  isOutageExpired,
  OUTAGE_BACKOFF_MS,
  OUTAGE_JITTER_RATIO,
  OUTAGE_QUOTA_BACKOFF_START_INDEX,
  type OutageRecord,
  type OutageSuspendKind,
} from "./types";

export interface BackoffOptions {
  /** 随机源，返回 [0, 1)；默认 Math.random。测试注入固定值。 */
  random?: () => number;
}

/**
 * 第 `attempt` 次（1 起计）重试前的等待：基础档位 × 抖动。
 * `attempt` 超过序列长度后一直取最后一档（30m 封顶）。
 */
export function backoffDelayMs(
  attempt: number,
  kind: OutageSuspendKind,
  options: BackoffOptions = {},
): number {
  const random = options.random ?? Math.random;
  const startIndex = kind === "quota" ? OUTAGE_QUOTA_BACKOFF_START_INDEX : 0;
  const index = Math.min(
    Math.max(0, startIndex + Math.max(0, Math.floor(attempt) - 1)),
    OUTAGE_BACKOFF_MS.length - 1,
  );
  const base = OUTAGE_BACKOFF_MS[index];
  // 抖动 ∈ [-20%, +20%]；random() 落在 [0,1)，故乘 (2r-1)。
  const factor = 1 + (random() * 2 - 1) * OUTAGE_JITTER_RATIO;
  return Math.round(base * factor);
}

/** 下一次尝试的时间戳（纯函数）。 */
export function nextAttemptAt(
  attempt: number,
  kind: OutageSuspendKind,
  from: number,
  options: BackoffOptions = {},
): number {
  return from + backoffDelayMs(attempt, kind, options);
}

export interface AdvanceResult {
  /** 自增后的预算（attempts + 1、nextAttemptAt 前移）。 */
  record: OutageRecord;
  /** 触顶：本次不应再尝试，状态该转 expired。 */
  expired: boolean;
  /** 本次要等待的毫秒数；expired 时为 0。 */
  delayMs: number;
}

/**
 * 推进一次尝试的预算：attempts+1、算下一次延迟、检查双闸。
 *
 * 语义：调用方在**尝试之后**调用（无论成败）。触顶即返回 `expired: true`，
 * 调用方把状态写 `expired`、停止调度。attempts 计数会不会超过 maxAttempts
 * 由 `isOutageExpired` 判，这里不 clamp，保留真实次数供 UI 显示。
 */
export function advanceOutageBudget(
  record: OutageRecord,
  now: number,
  options: BackoffOptions = {},
): AdvanceResult {
  const attempts = record.budget.attempts + 1;
  // `deadlineAt: 0` = 不限（见 isOutageExpired 的说明），所以判据要显式 `> 0`。
  const deadlineReached = record.budget.deadlineAt > 0 && now >= record.budget.deadlineAt;
  const exhausted = attempts >= record.budget.maxAttempts || deadlineReached;
  const delayMs = exhausted ? 0 : backoffDelayMs(attempts, record.kind, options);
  const nextAt = exhausted ? now : now + delayMs;
  const advanced: OutageRecord = {
    ...record,
    budget: {
      ...record.budget,
      attempts,
      nextAttemptAt: nextAt,
    },
    updatedAt: now,
  };
  return {
    record: advanced,
    expired: exhausted || isOutageExpired(advanced, now),
    delayMs,
  };
}

/** 记录是否该在此刻尝试（调度器 tick 的直接判据）。 */
export function isOutageDue(record: OutageRecord, now: number): boolean {
  if (record.status !== "waiting") return false;
  return now >= record.budget.nextAttemptAt;
}

/**
 * 初次挂起时的预算构造：attempts 从 0 起，`nextAttemptAt` 为首次等待后
 * （第一次续跑马上就做，不隔 30 秒——挂起那一刻的失败已由 SDK 重试耗尽）。
 */
export function initialOutageBudget(input: {
  kind: OutageSuspendKind;
  now: number;
  maxWaitMs: number;
  maxAttempts: number;
}): OutageRecord["budget"] {
  return {
    attempts: 0,
    maxAttempts: input.maxAttempts,
    startedAt: input.now,
    // `maxWaitMs === 0` 是「不限」：落盘成 0 哨兵，`isOutageExpired` 显式判 `> 0`。
    // 写成 `now + 0` 会得到一个立刻过期的 deadline，语义正好相反。
    deadlineAt: input.maxWaitMs === 0 ? 0 : input.now + input.maxWaitMs,
    // 立刻可以尝试：SDK 已经重试过 3 次（约 14s），再等 30s 只会拖慢恢复。
    nextAttemptAt: input.now,
  };
}