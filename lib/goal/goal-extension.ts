/**
 * `/goal` 目标模式扩展（与 pi-lsp / pi-team / pi-purge 同插槽的内置扩展）。
 *
 * 用户 `/goal <objective>` 立一个持续目标；每一轮结束后，只要目标仍 active、并有用户
 * pending 消息、且未撞双闸（默认 20 轮 / 10 分钟），扩展就自己 `sendUserMessage(续跑提示,
 * { deliverAs: "followUp" })` 触发下一轮 —— **不需要改 rpc-manager 生命周期**。
 *
 * 完成由模型显式声明：`goal_complete` 工具（唯一能结束目标的正规出口）。触顶时扩展把状态
 * 转 `paused` 并 `ctx.ui.notify` 回执（英文，服务端拿不到 locale），绝不静默继续烧钱。
 *
 * 状态在 `lib/goal/goal-store.ts`（每会话一份 JSON），这里只做事件接线 + 文案；哨点：
 * - `before_agent_start` 把目标段注入 systemPromptOptions.sections["goal"]；
 * - `agent_settled` 判定续跑 / 触顶暂停（aborted 时不动，尊重用户 Esc）；
 * - 每次状态变化 `pi.appendEntry("pi-web:goal", state)` 落一条自定义条目。
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyGoalEvent,
  goalGateExceeded,
  readGoalState,
  shouldContinueGoal,
  writeGoalState,
} from "./goal-store";
import { GOAL_DEFAULT_LIMITS, type GoalEvent, type GoalLimits, type GoalState } from "./goal-types";

/** 落进会话文件的自定义条目类型。 */
export const GOAL_ENTRY_TYPE = "pi-web:goal";
/** 注入 system prompt 的截面名（systemPromptOptions.sections 的键）。 */
export const GOAL_SECTION = "goal";

/** 每轮结束触发下一轮时投递的提示（语言中立英文；目标段会由 before_agent_start 再注入）。 */
export const GOAL_CONTINUE_PROMPT =
  "Continue working toward the active objective. Do not restate the goal — pick up where you left off, "
  + "keep going until it is fully achieved, then call the goal_complete tool with a one-line summary.";

/** 目标段落（注入 system prompt）；语言中立英文。 */
export function buildGoalSection(state: GoalState, limits: GoalLimits = GOAL_DEFAULT_LIMITS): string {
  return [
    "## Active objective (goal mode)",
    `Objective: ${state.objective}`,
    "Work autonomously toward this objective across turns. The system continues your work automatically after each turn until the objective is done or a limit is reached — do not ask the user to keep going.",
    "When — and only when — the objective is fully achieved, call the `goal_complete` tool with a one-line summary. Do not call it to end a turn early or when blocked; to stop, the user pauses or clears the goal.",
    `Limits: at most ${limits.maxContinuations} automatic continuations and ${Math.round(limits.maxElapsedMs / 60_000)} minutes; the goal pauses automatically when either is reached.`,
  ].join("\n");
}

/** 触顶暂停时的回执文案。 */
export function goalGateMessage(gate: "maxContinuations" | "maxElapsedMs", limits: GoalLimits = GOAL_DEFAULT_LIMITS): string {
  return gate === "maxContinuations"
    ? `Goal paused: reached the ${limits.maxContinuations}-continuation limit. Resume with /goal resume, or /goal clear.`
    : `Goal paused: ran for about ${Math.round(limits.maxElapsedMs / 60_000)} minutes. Resume with /goal resume, or /goal clear.`;
}

/** `/goal status` 的回执文案。 */
export function goalStatusLine(state: GoalState | null): string {
  if (!state) return "No goal set. Use /goal <objective> to start one.";
  const minutes = Math.floor(state.elapsedMs / 60_000);
  return [
    `Goal (${state.status}): ${state.objective}`,
    `Continuations: ${state.continuations}/${state.maxContinuations} · Elapsed: ${minutes}m`,
  ].join("\n");
}

/** 存储适配器（默认走磁盘；测试可注入内存实现）。 */
export interface GoalStoreAdapter {
  read(sessionId: string): GoalState | null;
  write(state: GoalState): void;
}

export interface GoalExtensionDeps {
  /** 双闸覆盖（测试用；默认 20 轮 / 10 分钟）。 */
  limits?: Partial<GoalLimits>;
  now?: () => number;
  store?: GoalStoreAdapter;
}

/**
 * 扩展工厂。返回 `(pi) => void` 的注册钩子，交给 `builtin(...)` 的 factory 位。
 */
export function createGoalExtension(deps: GoalExtensionDeps = {}): (pi: ExtensionAPI) => void {
  const limits: GoalLimits = { ...GOAL_DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => Date.now());
  const store: GoalStoreAdapter = deps.store ?? {
    read: (sessionId) => readGoalState(sessionId),
    write: (state) => writeGoalState(state),
  };
  const sessionIdOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
  const commit = (pi: ExtensionAPI, state: GoalState): void => {
    store.write(state);
    pi.appendEntry(GOAL_ENTRY_TYPE, state);
  };

  return (pi) => {
    // ── /goal 命令 ──────────────────────────────────────────────
    pi.registerCommand("goal", {
      description: "Goal mode: keep an objective active and continue automatically until goal_complete",
      getArgumentCompletions: (prefix: string) =>
        ["pause", "resume", "clear", "status"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const current = store.read(sessionId);
        const trimmed = args.trim();
        const head = (trimmed.split(/\s+/, 1)[0] ?? "").toLowerCase();
        const notify = (text: string, level: "info" | "warning" | "error" = "info"): void => ctx.ui.notify(text, level);

        if (!trimmed || head === "status") {
          notify(goalStatusLine(current));
          return;
        }
        if (head === "pause" || head === "resume" || head === "clear") {
          if (!current) {
            notify(`No goal to ${head}.`, "warning");
            return;
          }
          // 命令动词 pause/resume/clear → 事件 paused/resumed/cleared。
          const eventType: GoalEvent["type"] = head === "pause" ? "paused" : head === "resume" ? "resumed" : "cleared";
          const next = applyGoalEvent(current, { type: eventType } as GoalEvent, now());
          if (next) commit(pi, next);
          notify(head === "pause" ? "Goal paused." : head === "resume" ? "Goal resumed with a fresh budget." : "Goal cleared.");
          return;
        }
        // 其余：整段 args 作为 objective（换目标 = replaced，无目标 = created）。
        const objective = trimmed;
        const event = current && current.status !== "cleared"
          ? ({ type: "replaced", objective } as const)
          : ({ type: "created", sessionId, objective } as const);
        const next = applyGoalEvent(current, event, now());
        if (next) commit(pi, next);
        notify(`Goal set: ${objective}`);
      },
    });

    // ── goal_complete 工具（模型声明完成的唯一出口）─────────────
    pi.registerTool({
      name: "goal_complete",
      label: "Complete goal",
      description: "Mark the active /goal objective as completed. Call ONLY when the objective is fully achieved, with a one-line summary.",
      parameters: Type.Object({
        summary: Type.String({ description: "One-line summary of what was accomplished." }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const current = store.read(sessionId);
        if (!current || current.status !== "active") {
          return { content: [{ type: "text", text: "No active goal to complete." }], details: undefined };
        }
        const next = applyGoalEvent(current, { type: "completed", summary: params.summary }, now());
        if (next) commit(pi, next);
        return { content: [{ type: "text", text: `Goal completed: ${params.summary}` }], details: undefined };
      },
    });

    // ── 每轮注入目标段 ──────────────────────────────────────────
    pi.on("before_agent_start", (event, ctx) => {
      const state = store.read(sessionIdOf(ctx));
      if (!state || state.status !== "active") return undefined;
      event.systemPromptOptions.sections[GOAL_SECTION] = buildGoalSection(state, limits);
      return undefined;
    });

    // ── 结束一轮后：续跑 or 触顶暂停 ────────────────────────────
    pi.on("agent_settled", (event, ctx) => {
      if (event.aborted) return; // 用户 Esc 中止：不自动续跑
      const sessionId = sessionIdOf(ctx);
      const state = store.read(sessionId);
      if (!state) return;
      const nowMs = now();
      if (shouldContinueGoal(state, nowMs, ctx.hasPendingMessages(), limits)) {
        const next = applyGoalEvent(state, { type: "message" }, nowMs);
        if (next) commit(pi, next);
        pi.sendUserMessage(GOAL_CONTINUE_PROMPT, { deliverAs: "followUp" });
        return;
      }
      const gate = goalGateExceeded(state, nowMs, limits);
      if (gate) {
        const next = applyGoalEvent(state, { type: "paused" }, nowMs);
        if (next) commit(pi, next);
        ctx.ui.notify(goalGateMessage(gate, limits), "warning");
      }
    });
  };
}
