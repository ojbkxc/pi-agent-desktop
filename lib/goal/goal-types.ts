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
  /**
   * 建目标时的会话工作目录。**只有定时重复用得上**：间隔可能长达 1d，期间会话会被
   * idle 驱逐，调度器要能按它把会话重新打开（`startRpcSession` 需要 cwd）。
   */
  cwd?: string;
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
  /**
   * 「按计划重复」的间隔（毫秒）。0 / 缺省 = 连续续跑（旧行为：一轮结束立刻接下一轮）。
   * 非 0 时只有 `now >= nextRunAt` 才续跑，中间空档让会话真正空闲。
   */
  intervalMs?: number;
  /** 下一轮的计划时间戳；只有 `intervalMs > 0` 时有意义。 */
  nextRunAt?: number;
  /** 间隔栏里除间隔之外的说明（如「不停迭代该项目」），仅作展示。 */
  repeatNote?: string;
  /**
   * 完成判定条件（Alma 式「持续工作直到满足条件」）。缺省 = 不做裁判，由模型自己调
   * `goal_complete` 结束（旧行为）。有值时每轮结束后由**独立模型**判断是否满足。
   */
  condition?: string;
  /** 裁判最近一次的结论（供进度条展示；不参与状态机判定）。 */
  judge?: GoalJudgeVerdict;
}

/** 裁判模型的一次判定。`unjudged` 表示这一轮没判成（超时/模型没配好/输出不合法）。 */
export interface GoalJudgeVerdict {
  /** satisfied=true 表示条件已满足；unjudged=true 时此项无意义。 */
  satisfied: boolean;
  /** 一句话理由。 */
  reason: string;
  /** 判定所依据的对话证据（模型引用的原文片段）。 */
  evidence: string[];
  /** 这一轮没判成的标记（不阻断续跑，只是不结束目标）。 */
  unjudged?: boolean;
  /** 判定时间戳。 */
  at: number;
}

/** 状态迁移事件（`applyGoalEvent` 的输入）。 */
export type GoalEvent =
  | {
    type: "created";
    sessionId: string;
    objective: string;
    cwd?: string;
    budget?: number;
    maxContinuations?: number;
    intervalMs?: number;
    repeatNote?: string;
    condition?: string;
  }
  | { type: "replaced"; objective: string; cwd?: string; budget?: number; intervalMs?: number; repeatNote?: string; condition?: string }
  | { type: "status"; status: GoalStatus }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "completed"; summary?: string }
  | { type: "cleared" }
  | { type: "message" }
  | { type: "judged"; verdict: GoalJudgeVerdict };

/** 续跑双闸限额。 */
export interface GoalLimits {
  /** 轮数上限。 */
  maxContinuations: number;
  /**
   * 时间上限（毫秒）。**定时重复**（intervalMs > 0）的目标按 7 天算（Alma 同口径），
   * 连续续跑仍按 10 分钟——否则间隔 1d 的目标第一轮就撞时间闸。
   */
  maxElapsedMs: number;
}

/** 双闸默认值：20 轮 / 10 分钟（触顶自动转 paused，绝不静默续跑烧钱）。 */
export const GOAL_DEFAULT_LIMITS: GoalLimits = {
  maxContinuations: 20,
  maxElapsedMs: 10 * 60 * 1000,
};

/**
 * 定时重复目标的限额：时间闸放宽到 7 天，轮数上限不变。调度侧另有
 * `GOAL_MAX_REPEAT_MS`（`goal-interval.ts`）作为「不再排下一轮」的硬上限。
 */
export const GOAL_REPEAT_LIMITS: GoalLimits = {
  maxContinuations: GOAL_DEFAULT_LIMITS.maxContinuations,
  maxElapsedMs: 7 * 24 * 60 * 60 * 1000,
};

/** 按目标形态挑限额（时间闸随 intervalMs 切换）。 */
export function goalLimitsFor(state: { intervalMs?: number }, base: GoalLimits = GOAL_DEFAULT_LIMITS): GoalLimits {
  return state.intervalMs && state.intervalMs > 0
    ? { ...base, maxElapsedMs: Math.max(base.maxElapsedMs, GOAL_REPEAT_LIMITS.maxElapsedMs) }
    : base;
}
