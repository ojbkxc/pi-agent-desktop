/**
 * `/goal` 目标模式的**状态存储 + 纯状态机**。
 *
 * - 每会话一份 JSON：`~/.pi/agent/goals/<sessionId>.json`（走 `userHome()`，绝不用字面
 *   `homedir()`；与 pi-web 其它落盘一致）。tmp+rename 原子写；坏 JSON / 缺字段一律当作
 *   「无目标」返回 null，绝不让一条坏文件把续跑引擎卡死。
 * - 状态迁移与续跑双闸是**纯函数**（`applyGoalEvent` / `shouldContinueGoal` /
 *   `goalGateExceeded`），不碰 fs —— 单测直接锁死状态机，扩展只做 IO 与事件接线。
 *
 * 客户端组件不要 import 本文件（含 node:fs）；类型从 `./goal-types` 取。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileAtomicSync } from "../atomic-file";
import { userHome } from "../user-home";
import {
  GOAL_DEFAULT_LIMITS,
  type GoalEvent,
  type GoalLimits,
  type GoalState,
  type GoalStatus,
} from "./goal-types";

// ───────────────────────────── 路径 ─────────────────────────────

const GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused", "completed", "cleared"];

/** 目标数据根目录：`~/.pi/agent/goals`。 */
export function goalsDir(home: string = userHome()): string {
  return join(home, ".pi", "agent", "goals");
}

/** 会话 id → 安全文件名（去掉路径分隔符等；uuid 本就安全，这里只作兜底）。 */
export function safeGoalFileStem(sessionId: string): string {
  const stem = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return stem || "session";
}

export function goalFilePath(sessionId: string, home: string = userHome()): string {
  return join(goalsDir(home), `${safeGoalFileStem(sessionId)}.json`);
}

// ───────────────────────────── IO ─────────────────────────────

/** 读一个会话的目标；缺文件 / 坏 JSON / 结构不合法一律 null。 */
export function readGoalState(sessionId: string, home?: string): GoalState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(goalFilePath(sessionId, home), "utf8"));
  } catch {
    return null;
  }
  return isGoalState(raw) ? raw : null;
}

/** 原子写一个会话的目标（父目录不存在则创建）。 */
export function writeGoalState(state: GoalState, home?: string): void {
  mkdirSync(goalsDir(home), { recursive: true });
  replaceFileAtomicSync(goalFilePath(state.sessionId, home), JSON.stringify(state, null, 2));
}

// ───────────────────────────── 纯状态机 ─────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** 磁盘 JSON → GoalState 守卫（字段缺失/越界即拒绝）。 */
export function isGoalState(value: unknown): value is GoalState {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && typeof value.objective === "string"
    && typeof value.status === "string"
    && (GOAL_STATUSES as readonly string[]).includes(value.status)
    && isFiniteNumber(value.continuations)
    && isFiniteNumber(value.maxContinuations)
    && isFiniteNumber(value.startedAt)
    && isFiniteNumber(value.elapsedMs)
    && isFiniteNumber(value.updatedAt)
    && (value.budget === undefined || isFiniteNumber(value.budget))
  );
}

/** 从 startedAt 到 now 的耗时（钳到 ≥0，防时钟回拨）。 */
const elapsedOf = (state: GoalState, now: number): number => Math.max(0, now - state.startedAt);

/**
 * 纯状态迁移。`current` 为 null 时只有 `created` 能凭空建态，其余返回 null。
 * 全程不改入参（返回新对象）。
 */
export function applyGoalEvent(
  current: GoalState | null,
  event: GoalEvent,
  now: number,
): GoalState | null {
  if (event.type === "created") {
    return {
      sessionId: event.sessionId,
      objective: event.objective,
      status: "active",
      ...(event.budget === undefined ? {} : { budget: event.budget }),
      continuations: 0,
      maxContinuations: event.maxContinuations ?? current?.maxContinuations ?? GOAL_DEFAULT_LIMITS.maxContinuations,
      startedAt: now,
      elapsedMs: 0,
      updatedAt: now,
    };
  }
  if (!current) return null;

  switch (event.type) {
    case "replaced":
      // 换目标 = 全新一轮：计数与计时都归零（旧目标的预算不再累加）。
      return {
        ...current,
        objective: event.objective,
        status: "active",
        ...(event.budget === undefined ? {} : { budget: event.budget }),
        continuations: 0,
        startedAt: now,
        elapsedMs: 0,
        updatedAt: now,
      };
    case "status":
      return { ...current, status: event.status, elapsedMs: elapsedOf(current, now), updatedAt: now };
    case "paused":
      return { ...current, status: "paused", elapsedMs: elapsedOf(current, now), updatedAt: now };
    case "resumed":
      // 恢复给一轮**全新预算**：计数归零、计时重开，否则刚恢复就立刻再触顶。
      return { ...current, status: "active", continuations: 0, startedAt: now, elapsedMs: 0, updatedAt: now };
    case "completed":
      return { ...current, status: "completed", elapsedMs: elapsedOf(current, now), updatedAt: now };
    case "cleared":
      return { ...current, status: "cleared", elapsedMs: elapsedOf(current, now), updatedAt: now };
    case "message":
      // 一次自动续跑：轮数 +1。
      return { ...current, continuations: current.continuations + 1, elapsedMs: elapsedOf(current, now), updatedAt: now };
    default:
      return current;
  }
}

/**
 * 双闸：**该不该自动续跑**。任一不满足即 false（由扩展决定是否进一步转 paused）：
 * - 无目标 / 非 active（paused/completed/cleared）→ false；
 * - 已有 pending 用户消息（用户自己会驱动下一轮，不该插队）→ false；
 * - 轮数触顶 / 时间触顶 → false。
 */
export function shouldContinueGoal(
  state: GoalState | null,
  now: number,
  hasPendingUserMessage: boolean,
  limits: GoalLimits = GOAL_DEFAULT_LIMITS,
): boolean {
  if (!state || state.status !== "active") return false;
  if (hasPendingUserMessage) return false;
  if (now - state.startedAt >= limits.maxElapsedMs) return false;
  if (state.continuations >= limits.maxContinuations) return false;
  return true;
}

/**
 * 触顶判定：返回撞的是哪道闸（供扩展转 paused 并给出对应 notify 文案）；没撞返回 null。
 * 非 active / 无目标恒 null（不该因为一个已完成的目标去暂停）。
 */
export function goalGateExceeded(
  state: GoalState | null,
  now: number,
  limits: GoalLimits = GOAL_DEFAULT_LIMITS,
): "maxContinuations" | "maxElapsedMs" | null {
  if (!state || state.status !== "active") return null;
  if (now - state.startedAt >= limits.maxElapsedMs) return "maxElapsedMs";
  if (state.continuations >= limits.maxContinuations) return "maxContinuations";
  return null;
}
