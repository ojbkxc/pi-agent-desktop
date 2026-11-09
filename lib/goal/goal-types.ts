/**
 * `/goal` 目标模式的**纯类型层**（客户端可安全 import，不含 node:fs）。
 *
 * 目标是一个「持续追一个 objective 直到声明完成」的会话级状态。状态机与续跑双闸的纯函数
 * 在 `lib/goal/goal-store.ts`；这里只放类型与默认限额，供扩展、路由、前端进度条共享。
 */

/** active=追；paused=暂停（用户 / 触顶）；completed=已声明完成；cleared=用户清除。 */
export type GoalStatus = "active" | "paused" | "completed" | "cleared";

export interface GoalState {
  sessionId: string;
  /** 用户写下的目标（原样保存）。 */
  objective: string;
  status: GoalStatus;
  /** 可选预算（token），本轮不下闸只保留字段。 */
  budget?: number;
  /** 已经自动续跑过多少轮。 */
  continuations: number;
  /** 轮数上限。 */
  maxContinuations: number;
  /** 本轮目标开始计时的时间戳（resume 会重置）。 */
  startedAt: number;
  /** now - startedAt（每次落库刷新，便于前端不用自己算）。 */
  elapsedMs: number;
  updatedAt: number;
}

/** 状态迁移事件（`applyGoalEvent` 的输入）。 */
export type GoalEvent =
  | { type: "created"; sessionId: string; objective: string; budget?: number; maxContinuations?: number }
  | { type: "replaced"; objective: string; budget?: number }
  | { type: "status"; status: GoalStatus }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "completed"; summary?: string }
  | { type: "cleared" }
  | { type: "message" };

/** 续跑双闸限额。 */
export interface GoalLimits {
  /** 轮数上限。 */
  maxContinuations: number;
  /** 时间上限（毫秒）。 */
  maxElapsedMs: number;
}

/** 双闸默认值：20 轮 / 10 分钟（触顶自动转 paused，绝不静默续跑烧钱）。 */
export const GOAL_DEFAULT_LIMITS: GoalLimits = {
  maxContinuations: 20,
  maxElapsedMs: 10 * 60 * 1000,
};
