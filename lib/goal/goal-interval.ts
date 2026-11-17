/**
 * 「按计划重复」的**纯解析层**（客户端可安全 import，不含 node:fs）。
 *
 * Alma 的 goal 弹窗里第二栏是「Lead with an interval — 5m, 2h, 1d. Stops after 7 days.」：
 * 间隔写在文本开头，后面跟任意说明。这里只做两件事：
 * 1. 把用户写的那一行解析成 `{ intervalMs, note }`（`不停迭代该项目` 这类没有间隔前缀的
 *    文本视为「连续续跑」，即 `intervalMs = 0`——与旧行为一致）；
 * 2. 提供 7 天上限与若干预设，供弹窗与扩展共用。
 *
 * 语法（刻意保守，避免把目标正文误当间隔）：
 * - `<数字><单位>` 开头，单位 ∈ s|m|h|d|w（大小写不敏感），数字可为小数（`1.5h`）；
 * - 数字与单位之间允许空格（`2 h`）；
 * - 与后文之间必须由空白或结尾分隔（`5min` 里的 `min` 不是单位，整行按无间隔处理）。
 */

/** 重复间隔上限：7 天（Alma 同口径）。到点不再创建下一轮。 */
export const GOAL_MAX_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

/** 最短间隔：30 秒。比这更密只会连续烧 token，没有意义。 */
export const GOAL_MIN_REPEAT_MS = 30 * 1000;

/** 单位 → 毫秒倍数。 */
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** 弹窗里的快捷预设（与文案里的 5m / 2h / 1d 对齐）。 */
export const GOAL_REPEAT_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "5m", label: "5m" },
  { value: "30m", label: "30m" },
  { value: "2h", label: "2h" },
  { value: "1d", label: "1d" },
];

export interface ParsedRepeat {
  /** 间隔毫秒；0 = 没有间隔前缀（连续续跑）。 */
  intervalMs: number;
  /** 去掉间隔前缀后剩下的说明文本（可能为空）。 */
  note: string;
  /** 原文里出现了间隔但解析不出来（例如 `5x`、`999d`）——调用方应提示用户。 */
  invalid: boolean;
}

/** 开头是「数字 + 可选空格 + 单位 + 分隔」的形态。 */
const LEADING_INTERVAL = /^\s*(\d+(?:\.\d+)?)\s*([smhdwSMHDW])(?=\s|$)/;

/**
 * 解析「按计划重复」那一栏。
 *
 * - 空文本 → `{ intervalMs: 0, note: "", invalid: false }`（调用方决定默认值）；
 * - 有合法前缀 → 取其毫秒数并保留剩余说明；
 * - 数字合法但越界（< 30s 或 > 7d）→ `invalid: true`（不静默改写用户的数字）；
 * - 完全没前缀 → 整行都是说明，`intervalMs: 0`。
 */
export function parseGoalRepeat(raw: string): ParsedRepeat {
  const text = (raw ?? "").trim();
  if (!text) return { intervalMs: 0, note: "", invalid: false };

  const match = LEADING_INTERVAL.exec(text);
  if (!match) return { intervalMs: 0, note: text, invalid: false };

  const amount = Number(match[1]);
  const unitMs = UNIT_MS[match[2].toLowerCase()];
  const intervalMs = Number.isFinite(amount) && unitMs ? Math.round(amount * unitMs) : 0;
  const note = text.slice(match[0].length).trim();

  if (intervalMs < GOAL_MIN_REPEAT_MS || intervalMs > GOAL_MAX_REPEAT_MS) {
    return { intervalMs: 0, note: text, invalid: true };
  }
  return { intervalMs, note, invalid: false };
}

/** 毫秒 → 人类可读的间隔（`5m` / `2h` / `1d`），供进度条与回执用。 */
export function formatGoalInterval(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return "";
  if (intervalMs % UNIT_MS.d === 0) return `${intervalMs / UNIT_MS.d}d`;
  if (intervalMs % UNIT_MS.h === 0) return `${intervalMs / UNIT_MS.h}h`;
  if (intervalMs % UNIT_MS.m === 0) return `${intervalMs / UNIT_MS.m}m`;
  return `${Math.round(intervalMs / 1000)}s`;
}

/** 这一轮是否已经到点（无间隔恒 true；无 nextRunAt 恒 true，不卡住旧数据）。 */
export function goalRepeatDue(state: { intervalMs?: number; nextRunAt?: number }, now: number): boolean {
  if (!state.intervalMs || state.intervalMs <= 0) return true;
  if (typeof state.nextRunAt !== "number" || !Number.isFinite(state.nextRunAt)) return true;
  return now >= state.nextRunAt;
}

/** 距下一轮的毫秒数（已到点或没有间隔返回 0）。 */
export function goalRepeatRemainingMs(state: { intervalMs?: number; nextRunAt?: number }, now: number): number {
  if (!state.intervalMs || state.intervalMs <= 0) return 0;
  if (typeof state.nextRunAt !== "number" || !Number.isFinite(state.nextRunAt)) return 0;
  return Math.max(0, state.nextRunAt - now);
}

/** 下次运行时间是否已超出 7 天总时长上限（到点后不再排下一轮）。 */
export function goalRepeatExhausted(state: { intervalMs?: number; startedAt: number }, now: number): boolean {
  return Boolean(state.intervalMs && state.intervalMs > 0) && now - state.startedAt >= GOAL_MAX_REPEAT_MS;
}

/**
 * 一轮跑完后该排的下次时间。**状态机与调度器共用这一份**（两处各写一份必然漂移）。
 *
 * - 无间隔 → undefined（连续续跑，立刻可续）；
 * - 有间隔 → `now + intervalMs`；
 * - 越过 7 天窗 → undefined（不再排下一轮，由 `goalGateExceeded` 把目标转 paused，
 *   而不是永远排不出下一轮、会话吊在那里）。
 *
 * 新建 / 换目标 / 恢复**不调用它**：那三种情况应当立即开跑（用户刚点了 Start/Resume），
 * 间隔只管「跑完一轮之后等多久」。
 */
export function computeNextRunAt(
  intervalMs: number | undefined,
  startedAt: number,
  now: number,
): number | undefined {
  if (!intervalMs || intervalMs <= 0) return undefined;
  const next = now + intervalMs;
  if (next - startedAt > GOAL_MAX_REPEAT_MS) return undefined;
  return next;
}