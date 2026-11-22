/**
 * `/goal` **定时重复的调度器**（server-only）。
 *
 * 为什么必须有它：`agent_settled` 只在「一轮跑完」时触发一次。间隔 1d 的目标在等待空档里
 * 没有任何事件，会话会被 idle 驱逐 —— 光靠扩展钩子永远等不到下一轮。所以这里按
 * `nextRunAt` 扫一遍磁盘上的目标文件，到点就**向会话投一条续跑提示**。
 *
 * 与 `agent_settled` 的分工（**防双驱动**，本仓踩过多次）：
 * - `agent_settled` 负责「刚跑完、立刻续 / 立刻判」那一侧（间隔为 0 的连续续跑全走它）；
 * - 本调度器**只处理 `intervalMs > 0` 且已到点的目标**，并且投递前把 `nextRunAt` 推到
 *   下一档 —— 这样即使扩展在同一瞬间也判到点，磁盘上已经排过新一轮，不会投两条。
 * - `agent_settled` 的 `shouldContinueGoal` 里有 `goalRepeatDue` 闸，未到点时不续；
 *   调度器到点后推 `nextRunAt` 再投递，扩展这次 `agent_settled` 会看到未到点而不重复。
 *
 * 只做三件事，全部经注入（单测用假时钟/假会话，不碰网络与磁盘的真实副作用）：
 * 1. `listDueGoals` 读目录 → 2. 到点者 `advance` 推下一档 → 3. `deliver` 投续跑提示。
 * 复活会话（被驱逐 / 进程重启）由 `deliver` 的实现负责。
 */
import { readdirSync, readFileSync } from "node:fs";
import { isGoalState, writeGoalState } from "./goal-store";
import { computeNextRunAt, goalRepeatDue, goalRepeatExhausted } from "./goal-interval";
import type { GoalState } from "./goal-types";

/** 默认扫描节奏：1 分钟。间隔最短 30s，一分钟粒度足够（且完全不烧 token）。 */
export const GOAL_REPEAT_TICK_MS = 60_000;

export interface GoalRepeatSchedulerDeps {
  now(): number;
  /** 列出所有目标（默认读 goals 目录）。 */
  listGoals(): GoalState[];
  /** 把这份（已算好新 `nextRunAt` 的）状态写回磁盘。 */
  advance(state: GoalState): void;
  /** 到点投递。`busy` = 会话正在跑（本次空档作废，回滚 nextRunAt）；`failed` = 投不出去。 */
  deliver(state: GoalState): Promise<"delivered" | "busy" | "failed">;
  log(message: string): void;
}

export type GoalRepeatOutcome =
  | "delivered"
  | "skipped-not-due"
  | "skipped-not-active"
  | "skipped-busy"
  | "exhausted"
  | "deliver-failed";

export interface GoalRepeatAction {
  sessionId: string;
  outcome: GoalRepeatOutcome;
  detail?: string;
}

/**
 * 扫一轮。返回每个**被处理过**的目标（未到点的也返回，带 `skipped-not-due`，便于测试断言）。
 * 不启动 timer —— 与 `runOutageTick` 同一形态。
 */
export async function runGoalRepeatTick(deps: GoalRepeatSchedulerDeps): Promise<GoalRepeatAction[]> {
  const now = deps.now();
  const actions: GoalRepeatAction[] = [];
  let goals: GoalState[];
  try {
    goals = deps.listGoals();
  } catch (error) {
    deps.log(`读取目标目录失败：${error instanceof Error ? error.message : error}`);
    return actions;
  }

  for (const goal of goals) {
    // 只有「有间隔 + active」的目标归调度器管；其余由扩展/用户驱动。
    if (!goal.intervalMs || goal.intervalMs <= 0) continue;
    if (goal.status !== "active") {
      actions.push({ sessionId: goal.sessionId, outcome: "skipped-not-active" });
      continue;
    }
    if (!goalRepeatDue(goal, now)) {
      actions.push({ sessionId: goal.sessionId, outcome: "skipped-not-due" });
      continue;
    }
    // 7 天窗用尽：不再排下一轮，标 exhausted（下一次 agent_settled 会把它转 paused）。
    if (goalRepeatExhausted(goal, now)) {
      actions.push({ sessionId: goal.sessionId, outcome: "exhausted" });
      continue;
    }

    // **先算好并写回下一档，再投递**：投递会立刻开一轮，若这一刻 `agent_settled` 也判到点，
    // 磁盘上的 nextRunAt 已经是下一档，扩展那边就只有一个驱动在跑。
    const advancedState: GoalState = {
      ...goal,
      nextRunAt: computeNextRunAt(goal.intervalMs, goal.startedAt, now),
      updatedAt: now,
    };
    let outcome: "delivered" | "busy" | "failed";
    try {
      deps.advance(advancedState);
      outcome = await deps.deliver(goal);
    } catch (error) {
      actions.push({
        sessionId: goal.sessionId,
        outcome: "deliver-failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (outcome === "busy") {
      // 会话自己在跑（用户刚发了消息）：这一档空档作废，把 nextRunAt 拨回原值，
      // 下一 tick 再看。不回滚的话这一轮就被静默吞掉了。
      try {
        deps.advance({ ...advancedState, nextRunAt: goal.nextRunAt });
      } catch {
        // 回滚失败也不影响正确性：下一轮 agent_settled 会按新间隔重排。
      }
      actions.push({ sessionId: goal.sessionId, outcome: "skipped-busy" });
      continue;
    }
    actions.push({
      sessionId: goal.sessionId,
      outcome: outcome === "delivered" ? "delivered" : "deliver-failed",
      ...(outcome === "delivered" ? {} : { detail: "会话不可用且复活失败" }),
    });
  }
  return actions;
}

// ───────────────────────────── timer 生命周期 ─────────────────────────────

const LOOP_KEY: symbol = Symbol.for("pi-web:goal-repeat-sweep");

interface GoalRepeatLoopHandle {
  timer: ReturnType<typeof setInterval>;
  ticking: { value: boolean };
}

/** 进程级循环（instrumentation 启动）。幂等；`tickMs` 默认 1 分钟。 */
export function startGoalRepeatSchedulerLoop(
  deps: Omit<GoalRepeatSchedulerDeps, "now"> & { now?: () => number; tickMs?: number },
): void {
  const holder = globalThis as unknown as Record<symbol, GoalRepeatLoopHandle | undefined>;
  if (holder[LOOP_KEY]) return;
  const tickMs = deps.tickMs ?? GOAL_REPEAT_TICK_MS;
  const now = deps.now ?? (() => Date.now());
  const ticking = { value: false };
  const tick = (): void => {
    if (ticking.value) return;
    ticking.value = true;
    void runGoalRepeatTick({ ...deps, now })
      .catch((error) => deps.log(`目标重复扫描失败：${error instanceof Error ? error.message : error}`))
      .finally(() => { ticking.value = false; });
  };
  tick();
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  holder[LOOP_KEY] = { timer, ticking };
}

export function stopGoalRepeatSchedulerLoop(): void {
  const holder = globalThis as unknown as Record<symbol, GoalRepeatLoopHandle | undefined>;
  const handle = holder[LOOP_KEY];
  if (!handle) return;
  clearInterval(handle.timer);
  holder[LOOP_KEY] = undefined;
}

// ───────────────────────────── 生产默认实现 ─────────────────────────────

/**
 * 生产接线：读 `~/.pi/agent/goals/*.json`，投递走「活就用、死就重开」的既有缝
 * （`defaultDeliver` 与 outage/autofix 同口径）。
 *
 * 全部惰性 import：instrumentation 的启动路径不能把 rpc-manager / pi-ai 拖进来。
 */
export async function buildDefaultGoalRepeatDeps(): Promise<Omit<GoalRepeatSchedulerDeps, "now">> {
  const { goalsDir } = await import("./goal-store");
  return {
    listGoals: () => {
      const dir = goalsDir();
      let files: string[];
      try {
        files = readdirSync(dir).filter((name) => name.endsWith(".json"));
      } catch {
        return [];
      }
      const goals: GoalState[] = [];
      for (const name of files) {
        try {
          const raw: unknown = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
          if (isGoalState(raw)) goals.push(raw);
        } catch {
          // 坏文件跳过：一条坏目标不能卡住整个调度器。
        }
      }
      return goals;
    },
    advance: (state) => {
      // 新 nextRunAt 已由 tick 算好（与状态机共用 `computeNextRunAt`），这里只管落盘。
      writeGoalState(state);
    },
    deliver: async (state) => {
      const { getRpcSession } = await import("../rpc-manager");
      // 正在跑：`defaultDeliver` 会以 ok:false 返回，但那与「投不出去」是两回事 ——
      // 这里先自己判，把「忙」如实报上去，让 tick 回滚 nextRunAt。
      const live = getRpcSession(state.sessionId);
      if (live?.isAlive() && live.isRunning()) return "busy";
      const { defaultDeliver } = await import("../agent-teams-unattended-runtime");
      const result = await defaultDeliver(state.sessionId, GOAL_CONTINUE_PROMPT_FOR_REPEAT);
      if (result.ok) return "delivered";
      // defaultDeliver 的「正在运行」也走 ok:false；再判一次，避免把忙算成失败。
      const again = getRpcSession(state.sessionId);
      return again?.isAlive() && again.isRunning() ? "busy" : "failed";
    },
    log: (message) => console.log(`[goal-repeat] ${message}`),
  };
}

/**
 * 定时轮次的续跑提示。与 `GOAL_CONTINUE_PROMPT` 分开：这一条要说明「上一轮已经隔了
 * 一段时间」，避免模型以为自己刚刚被打断。
 */
export const GOAL_CONTINUE_PROMPT_FOR_REPEAT =
  "Continue working toward the active objective. Time has passed since your last turn — "
  + "check the current state before assuming your earlier work is still valid, then keep going "
  + "until the objective is fully achieved.";
