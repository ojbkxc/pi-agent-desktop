/**
 * `/goal` 的**裁判模型**（server-only）。
 *
 * Alma 的 goal 弹窗写着「Checked after every turn by a separate model. Name evidence it
 * can see in the conversation.」——这一层就是那个「separate model」。每轮结束后，
 * 用一个**不属于执行会话**的模型判断条件是否满足；它只读该轮的对话摘要，不产生任何
 * 会话副作用（不发消息、不写会话文件、不进上下文）。
 *
 * 判据与取舍：
 * - **不带工具、不给历史**：只喂「条件 + 最近几条消息的纯文本」，让它在 512 token 内
 *   给出 `{satisfied, reason, evidence[]}`。裁判看到的就是用户在对话里能看到的证据。
 * - **任何失败都是 `unjudged`，绝不等于「满足」**：超时、模型没配、输出不是 JSON、
 *   模型报错 —— 一律 `{satisfied:false, unjudged:true}`。把「没判成」当成「完成」会
 *   静默结束目标；当成「未完成」也只是多跑一轮，代价可控。
 * - **不走 AgentSession**（会污染会话文件、触发工具、拖慢）：复用 `lib/outage/probe.ts`
 *   的同一条裸调用路径 —— `getModelRuntimeWithExtensions()` + `completeSimple`。
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getModelRuntimeWithExtensions } from "../model-runtime";
import type { GoalJudgeVerdict } from "./goal-types";

/** 裁判超时：比执行轮短得多，卡住就放弃这一轮判定。 */
export const GOAL_JUDGE_TIMEOUT_MS = 20_000;
/** 喂给裁判的对话摘要上限（字符）：够它找证据，又不把整份上下文塞过去。 */
export const GOAL_JUDGE_CONTEXT_CHARS = 6000;

const JUDGE_SYSTEM_PROMPT = [
  "You are an independent verifier for an autonomous agent's goal. You do NOT do the work.",
  "You receive (1) the goal condition the user set and (2) the tail of the agent's conversation.",
  "Decide whether the condition is satisfied, using ONLY evidence you can see in that conversation tail.",
  "Reply with a single JSON object and nothing else:",
  '{"satisfied": true|false, "reason": "<one short sentence>", "evidence": ["<verbatim quote from the conversation>", ...]}',
  "Rules: do not assume unseen work happened; if the conversation does not prove the condition, answer false;",
  "keep evidence quotes short and verbatim; never invent commands, output, or file contents.",
].join(" ");

export interface JudgeGoalInput {
  /** 用户写的完成条件（Alma 的第一栏）。 */
  condition: string;
  /** 目标的 objective（条件之外还描述了要做什么时用得上）。 */
  objective: string;
  /** 本轮对话的纯文本摘要（调用方负责裁剪与脱敏）。 */
  conversation: string;
  /** 注入的时钟（测试）。 */
  now?: () => number;
}

/** 解析裁判的文本输出；不合法返回 null（调用方按 unjudged 处理）。 */
export function parseJudgeVerdict(text: string, at: number): GoalJudgeVerdict | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  // 模型常把 JSON 包进 ```json 代码块或前后加解释；只取第一个平衡的大括号块。
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as { satisfied?: unknown; reason?: unknown; evidence?: unknown };
  if (typeof record.satisfied !== "boolean") return null;
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.filter((item): item is string => typeof item === "string").slice(0, 8)
    : [];
  return {
    satisfied: record.satisfied,
    reason: typeof record.reason === "string" ? record.reason.slice(0, 400) : "",
    evidence,
    at,
  };
}

/** 超时 / 没模型 / 输出不合法时的统一结论：这一轮没判成。 */
function unjudged(at: number, reason: string): GoalJudgeVerdict {
  return { satisfied: false, reason, evidence: [], unjudged: true, at };
}

/** 把「条件 + 对话摘要」拼成裁判要读的一条 user 消息。 */
export function buildJudgePrompt(input: { condition: string; objective: string; conversation: string }): string {
  const excerpt = input.conversation.length > GOAL_JUDGE_CONTEXT_CHARS
    ? `…${input.conversation.slice(-GOAL_JUDGE_CONTEXT_CHARS)}`
    : input.conversation;
  return [
    `GOAL CONDITION (must be satisfied to stop): ${input.condition}`,
    input.objective && input.objective !== input.condition ? `GOAL OBJECTIVE: ${input.objective}` : "",
    "CONVERSATION TAIL (the only evidence you may use):",
    "---",
    excerpt || "(no conversation yet)",
    "---",
  ].filter(Boolean).join("\n");
}

/**
 * 跑一次裁判。**绝不抛**：任何异常都折叠成 `unjudged`。
 *
 * 模型选型：用会话默认模型（`SettingsManager` 的 default provider/model）；没配默认就取
 * 第一个有凭据的 chat 模型。刻意**不**复用执行会话的当前模型 —— 自己判自己等于没判。
 */
export async function judgeGoalCompletion(input: JudgeGoalInput): Promise<GoalJudgeVerdict> {
  const at = (input.now ?? Date.now)();
  const condition = input.condition?.trim();
  if (!condition) return unjudged(at, "目标没有设置完成条件");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOAL_JUDGE_TIMEOUT_MS);
  try {
    const modelRuntime = await getModelRuntimeWithExtensions();
    const model = await pickJudgeModel(modelRuntime);
    if (!model) return unjudged(at, "没有可用的裁判模型");

    const auth = await modelRuntime.getAuth(model);
    if (!auth?.auth.apiKey) return unjudged(at, "裁判模型没有凭据");

    const message = await completeSimple(model, {
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildJudgePrompt(input), timestamp: at }],
    }, {
      apiKey: auth.auth.apiKey,
      headers: auth.auth.headers,
      maxTokens: 512,
      // 裁判不该因为上游抖动重试三次：卡住就这一轮不判，下一轮再说。
      maxRetries: 0,
      timeoutMs: GOAL_JUDGE_TIMEOUT_MS,
      cacheRetention: "none",
      signal: controller.signal,
    });

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return unjudged(at, message.errorMessage ?? "裁判请求失败");
    }
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    return parseJudgeVerdict(text, at) ?? unjudged(at, "裁判输出不是合法 JSON");
  } catch (error) {
    return unjudged(at, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

/** 可替换的裁判实现（测试注入；默认走 `judgeGoalCompletion`）。 */
export type GoalJudge = (input: JudgeGoalInput) => Promise<GoalJudgeVerdict>;

/**
 * 挑裁判模型：默认 provider/model 优先（用户在设置里选的就是它），否则回退到第一个
 * 有凭据的模型。两者都没有 → null（裁判不可用，这一轮 unjudged）。
 */
async function pickJudgeModel(runtime: Awaited<ReturnType<typeof getModelRuntimeWithExtensions>>) {
  try {
    const { SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const settings = SettingsManager.create(process.cwd(), getAgentDir());
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (provider && modelId) {
      const model = runtime.getModel(provider, modelId);
      if (model) return model;
    }
  } catch {
    // 设置读不出来不算失败：继续找任意有凭据的模型。
  }
  try {
    // 注意 `getAvailable` 是异步的（要读凭据），别用 `getAvailableSnapshot`：快照可能还没刷。
    const available = await runtime.getAvailable();
    if (Array.isArray(available) && available.length > 0) return available[0];
  } catch {
    // 目录也不可用 ⇒ 裁判不可用。
  }
  return null;
}