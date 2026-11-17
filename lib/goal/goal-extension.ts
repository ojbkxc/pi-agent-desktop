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
import { classifyOutageError } from "../outage/classify";
import { isSessionSuspended } from "../outage/store";
import { formatGoalInterval, goalRepeatDue, parseGoalRepeat } from "./goal-interval";
import {
  applyGoalEvent,
  goalGateExceeded,
  readGoalState,
  shouldContinueGoal,
  writeGoalState,
} from "./goal-store";
import { GOAL_JUDGE_CONTEXT_CHARS, judgeGoalCompletion, type GoalJudge } from "./goal-judge";
import {
  GOAL_DEFAULT_LIMITS,
  goalLimitsFor,
  type GoalEvent,
  type GoalJudgeVerdict,
  type GoalLimits,
  type GoalState,
} from "./goal-types";

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
  const lines = [
    "## Active objective (goal mode)",
    `Objective: ${state.objective}`,
  ];
  if (state.condition) {
    // 有完成条件时，把「判据」讲清楚：由独立模型核对，模型自己不能声称完成。
    lines.push(
      `Completion condition (verified by a separate model after every turn): ${state.condition}`,
      "Keep working until that condition is satisfied. Do not claim completion yourself — the verifier decides. "
      + "Make your progress checkable in the conversation: run the commands, show the output, name the files.",
    );
  } else {
    lines.push("Work autonomously toward this objective across turns. The system continues your work automatically after each turn until the objective is done or a limit is reached — do not ask the user to keep going.");
  }
  if (state.intervalMs && state.intervalMs > 0) {
    lines.push(
      `Schedule: after each turn the system waits about ${formatGoalInterval(state.intervalMs)} before starting the next one; `
      + "between turns keep your report short — the next turn picks up from the conversation.",
    );
  }
  lines.push(
    state.condition
      ? "Only stop when blocked or when the user pauses the goal."
      : "When — and only when — the objective is fully achieved, call the `goal_complete` tool with a one-line summary. Do not call it to end a turn early or when blocked; to stop, the user pauses or clears the goal.",
    `Limits: at most ${limits.maxContinuations} automatic continuations and ${Math.round(limits.maxElapsedMs / 60_000)} minutes; the goal pauses automatically when either is reached.`,
  );
  return lines.join("\n");
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
  const lines = [
    `Goal (${state.status}): ${state.objective}`,
    `Continuations: ${state.continuations}/${state.maxContinuations} · Elapsed: ${minutes}m`,
  ];
  if (state.condition) lines.push(`Condition: ${state.condition}`);
  if (state.intervalMs) {
    const next = state.nextRunAt ? new Date(state.nextRunAt).toISOString() : "next turn";
    lines.push(`Repeats every ${formatGoalInterval(state.intervalMs)} (next: ${next})`);
  }
  if (state.judge) {
    lines.push(
      state.judge.unjudged
        ? `Last verdict: not judged (${state.judge.reason})`
        : `Last verdict: ${state.judge.satisfied ? "satisfied" : "not yet"} — ${state.judge.reason}`,
    );
  }
  return lines.join("\n");
}

/**
 * 解析 `/goal` 的创建参数。形状是「**目标正文在前，flag 在后**」：
 *
 * ```
 * /goal <目标正文> [--every <5m|2h|1d>] [--until <完成条件>]
 * ```
 *
 * 目标正文取「第一个 `--` flag 之前」的全部内容（可能为空——弹窗只用条件时就是这样）；
 * `--until` 吃掉它之后的所有剩余（条件通常是带空格的自然语言，不该被下一个词截断）；
 * 其它 content 出现在 flag 之后视为条件的一部分。flag 顺序可交换。
 */
export function parseGoalCreateArgs(args: string): {
  objective: string;
  intervalMs?: number;
  repeatNote?: string;
  condition?: string;
  invalidRepeat?: string;
} {
  let rest = args.trim();
  let intervalMs: number | undefined;
  let repeatNote: string | undefined;
  let condition: string | undefined;
  let invalidRepeat: string | undefined;

  // 目标正文 = 第一个 flag 之前的内容。
  const flagStart = rest.search(/(^|\s)--(every|until)\b/i);
  let objective = "";
  if (flagStart >= 0) {
    objective = rest.slice(0, flagStart).trim();
    rest = rest.slice(flagStart).trim();
  } else {
    objective = rest;
    rest = "";
  }

  // `--every <值>`：值一定是一个词。
  const everyMatch = /^--every\s+(\S+)\s*/i.exec(rest);
  if (everyMatch) {
    const parsed = parseGoalRepeat(everyMatch[1]);
    rest = rest.slice(everyMatch[0].length);
    if (parsed.invalid || parsed.intervalMs <= 0) invalidRepeat = everyMatch[1];
    else {
      intervalMs = parsed.intervalMs;
      if (parsed.note) repeatNote = parsed.note;
    }
  }

  // `--until <条件>`：吃到行尾。
  const untilMatch = /^--until\s+([\s\S]+)$/i.exec(rest);
  if (untilMatch) {
    condition = untilMatch[1].trim();
    rest = "";
  } else if (rest.trim()) {
    // 剩下的既不是 --until 也不是已知 flag（例如 typo）：当正文处理，别静默丢掉。
    objective = objective ? `${objective} ${rest.trim()}` : rest.trim();
  }

  return {
    objective,
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(repeatNote === undefined ? {} : { repeatNote }),
    ...(condition === undefined ? {} : { condition }),
    ...(invalidRepeat === undefined ? {} : { invalidRepeat }),
  };
}

/** `goalStatusLine` 等工具函数之后、`GoalStoreAdapter` 之前。 */
function lastAssistantFailureIsProviderOutage(ctx: ExtensionContext): boolean {
  try {
    const branch = ctx.sessionManager.getBranch() as Array<{
      type?: unknown;
      message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    }>;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      if (entry.message.stopReason !== "error") return false;
      const errorText = typeof entry.message.errorMessage === "string" ? entry.message.errorMessage : "";
      return classifyOutageError({ errorText }).suspend;
    }
    return false;
  } catch {
    // 读不到会话状态就不做额外抑制（预算双闸仍会兜底）。
    return false;
  }
}

/** 存储适配器（默认走磁盘；测试可注入内存实现）。 */
export interface GoalStoreAdapter {
  read(sessionId: string): GoalState | null;
  write(state: GoalState): void;
}

export interface GoalExtensionDeps {
  /** 双闸覆盖（测试用；默认 20 轮 / 10 分钟，定时重复放宽到 7 天时间闸）。 */
  limits?: Partial<GoalLimits>;
  now?: () => number;
  store?: GoalStoreAdapter;
  /**
   * 裁判实现（测试注入）。默认 `judgeGoalCompletion`（独立模型裸调用）。
   * 只有目标带 `condition` 时才会调用它。
   */
  judge?: GoalJudge;
  /** 喂给裁判的对话摘要上限（字符）；默认 `GOAL_JUDGE_CONTEXT_CHARS`。 */
  judgeContextChars?: number;
}

/** 从会话分支里取「最近几轮」的纯文本，供裁判找证据（去掉工具结果的巨量输出）。 */
export function collectJudgeConversation(
  ctx: ExtensionContext,
  maxChars: number,
): string {
  try {
    const branch = ctx.sessionManager.getBranch() as Array<{
      type?: unknown;
      message?: { role?: unknown; content?: unknown };
    }>;
    const lines: string[] = [];
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = textOfContent(entry.message?.content).trim();
      if (!text) continue;
      lines.push(`${role === "user" ? "USER" : "AGENT"}: ${text}`);
    }
    const joined = lines.join("\n\n");
    return joined.length > maxChars ? joined.slice(-maxChars) : joined;
  } catch {
    return "";
  }
}

/** 消息内容 → 纯文本（assistant 的 text 块；user 的字符串/文本块）。工具块一律丢弃。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") { parts.push(block); continue; }
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/**
 * 扩展工厂。返回 `(pi) => void` 的注册钩子，交给 `builtin(...)` 的 factory 位。
 */
export function createGoalExtension(deps: GoalExtensionDeps = {}): (pi: ExtensionAPI) => void {
  const baseLimits: GoalLimits = { ...GOAL_DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => Date.now());
  const store: GoalStoreAdapter = deps.store ?? {
    read: (sessionId) => readGoalState(sessionId),
    write: (state) => writeGoalState(state),
  };
  const judge: GoalJudge = deps.judge ?? judgeGoalCompletion;
  const judgeContextChars = deps.judgeContextChars ?? GOAL_JUDGE_CONTEXT_CHARS;
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
        // 其余：目标正文。支持两个可选前缀参数（供创建弹窗使用；手打也认）：
        //   --every <5m|2h|1d|...>   按计划重复
        //   --until <完成条件>        完成判定条件（独立模型每轮核对）
        // 两个参数都必须写在开头，取到第一个不是它们的词开始，剩下的整段都算目标正文。
        const parsed = parseGoalCreateArgs(trimmed);
        if (parsed.invalidRepeat) {
          notify(`无法识别的重复间隔：${parsed.invalidRepeat}（支持 30s–7d，例如 30m / 2h / 1d）`, "warning");
          return;
        }
        if (!parsed.objective && !parsed.condition) {
          notify("目标内容为空：/goal <目标>，或至少给出 --until <完成条件>", "warning");
          return;
        }
        // 只有条件没有正文时（弹窗里「持续工作直到满足条件」那一栏），条件本身就是目标：
        // 进度条的 objective、注入段落的 Objective 都要有东西可显示。
        const objective = parsed.objective || parsed.condition || "";
        const plan = {
          ...(parsed.intervalMs === undefined ? {} : { intervalMs: parsed.intervalMs }),
          ...(parsed.repeatNote === undefined ? {} : { repeatNote: parsed.repeatNote }),
          ...(parsed.condition === undefined ? {} : { condition: parsed.condition }),
        };
        // 换目标 = replaced（旧计划字段由 plan 覆盖）；无目标 = created（带上 cwd，供
        // 定时重复在会话被驱逐后重新打开）。
        const event = current && current.status !== "cleared"
          ? ({ type: "replaced", objective, cwd: ctx.cwd, ...plan } as const)
          : ({ type: "created", sessionId, objective, cwd: ctx.cwd, ...plan } as const);
        const next = applyGoalEvent(current, event, now());
        if (next) commit(pi, next);
        const repeatLine = plan.intervalMs ? `，每 ${formatGoalInterval(plan.intervalMs)} 重复` : "";
        const conditionLine = plan.condition ? `，完成条件：${plan.condition}` : "";
        notify(`Goal set: ${objective}${repeatLine}${conditionLine}`);
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
      event.systemPromptOptions.sections[GOAL_SECTION] = buildGoalSection(state, goalLimitsFor(state, baseLimits));
      return undefined;
    });

    // ── 结束一轮后：裁判 → 续跑 or 触顶暂停 ─────────────────────
    pi.on("agent_settled", async (event, ctx) => {
      if (event.aborted) return; // 用户 Esc 中止：不自动续跑
      const sessionId = sessionIdOf(ctx);
      // Provider 中断：不续跑、不消耗续跑预算，等 outage 调度器恢复后由它续跑。
      // 两层判据：① 已有挂起记录（调度器续跑后的轮次）；② 扩展事件先于 rpc-manager
      // 的公共监听器发出，第一次故障时记录还没落盘，所以直接看最后一条 assistant
      // 的失败原因自己分类（classifyOutageError 是纯函数）。
      if (isSessionSuspended(sessionId)) return;
      if (lastAssistantFailureIsProviderOutage(ctx)) return;
      const state = store.read(sessionId);
      if (!state || state.status !== "active") return;
      const limits = goalLimitsFor(state, baseLimits);

      // 先过闸再花钱：已触顶 / 用户有 pending 消息 ⇒ 不跑裁判也不续跑。
      const nowMs = now();
      const gate = goalGateExceeded(state, nowMs, limits);
      if (gate) {
        const paused = applyGoalEvent(state, { type: "paused" }, nowMs);
        if (paused) commit(pi, paused);
        ctx.ui.notify(goalGateMessage(gate, limits), "warning");
        return;
      }
      const pending = ctx.hasPendingMessages();
      const due = goalRepeatDue(state, nowMs);

      // 有完成条件 ⇒ 由独立模型判一次。**只在本题结束时判**：pending 里已有用户
      // 自己写的下一句时，那条消息会自己开新一轮，裁判结论很快就会过期。
      // 定时目标且未到点：这一轮同样不判（不花裁判钱），等下一次到点。
      if (state.condition && !pending && due) {
        const verdict = await judgeOnce(judge, state, ctx, judgeContextChars, now());
        const judged = applyGoalEvent(store.read(sessionId) ?? state, { type: "judged", verdict }, now());
        if (judged) commit(pi, judged);
        if (verdict.satisfied) {
          const done = applyGoalEvent(store.read(sessionId) ?? judged ?? state, {
            type: "completed",
            summary: verdict.reason,
          }, now());
          if (done) commit(pi, done);
          ctx.ui.notify(`Goal completed — verifier: ${verdict.reason}`, "info");
          return;
        }
      }

      if (shouldContinueGoal(store.read(sessionId) ?? state, now(), pending, limits)) {
        const current = store.read(sessionId) ?? state;
        const next = applyGoalEvent(current, { type: "message" }, now());
        if (next) commit(pi, next);
        pi.sendUserMessage(GOAL_CONTINUE_PROMPT, { deliverAs: "followUp" });
      }
    });
  };
}

/** 跑一次裁判并吞掉一切异常（裁判失败只意味着这一轮不结束，绝不打断续跑）。 */
async function judgeOnce(
  judge: GoalJudge,
  state: GoalState,
  ctx: ExtensionContext,
  maxChars: number,
  at: number,
): Promise<GoalJudgeVerdict> {
  try {
    return await judge({
      condition: state.condition ?? "",
      objective: state.objective,
      conversation: collectJudgeConversation(ctx, maxChars),
      now: () => at,
    });
  } catch (error) {
    return {
      satisfied: false,
      reason: error instanceof Error ? error.message : String(error),
      evidence: [],
      unjudged: true,
      at,
    };
  }
}
