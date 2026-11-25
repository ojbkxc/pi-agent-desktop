import type { ClientAssistantMessageEvent } from "./agent-event-wire";
import { normalizeStreamingToolCalls } from "./normalize";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
} from "./types";

export type { ClientAssistantMessageEvent } from "./agent-event-wire";

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: AssistantMessage | null;
  /**
   * 本轮流式持续的毫秒数：`start` 时归零、每个 delta 推进到「现在 − 开始」。
   * tok/s 速度条（components/StreamingRateLine.tsx）需要一个不依赖渲染时机的口径。
   */
  streamingMs: number;
  /** `start` 的墙钟时刻；每个 delta 用它把 streamingMs 推到「现在 − 开始」。 */
  startedAt?: number;
  /**
   * 重连时 snapshot 已经带来的字符数。速度条只数这之后的增量，否则分子含重连
   * 之前的内容而分母从零起算，首采样会显示一个几乎全是虚高的数。
   */
  baselineChars?: number;
  /**
   * 首个 token 增量（text / thinking / toolCall 参数）的墙钟时刻。
   *
   * DeepSeek Harness 的输出速度分母是「首 token → 消息组装完」这段**纯解码时间**
   * （`decodeMs`），不含首字节延迟（TTFT）。本仓的 `startedAt` 起于 `message_start`，
   * 那是 HTTP 响应头刚到、一个 token 都还没吐的时刻，直接拿它当分母会系统性地偏低
   * —— 慢模型（TTFT 几秒）能差一倍以上，这正是「两边数字完全不一样」的来源之一。
   */
  firstTokenAt?: number;
  /** `firstTokenAt` → 最后一个增量的毫秒数；单轮口径下等于 dsh 的 `decodeMs`。 */
  decodeMs?: number;
  /**
   * The **finished** turn's output speed, in tokens per second.
   *
   * While text streams the readout can only estimate (characters ÷ 4 ÷ seconds)
   * because no chunk carries a token count. The turn's real number is available the
   * moment it ends — `usage.output` on the assistant message — so the same readout
   * switches to it and keeps showing it briefly, the way DeepSeek Harness prints
   * `{tps} tok/s` under the composer. Computed from real tokens × real stream time,
   * so it is the honest figure for "how fast did this model write".
   */
  finalRate?: { tps: number; at: number };
}

export type StreamAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "snapshot"; message: AgentMessage }
  | { type: "delta"; event: ClientAssistantMessageEvent }
  /**
   * `message` 是 `message_end` 带来的**完整** assistant 消息（含 `usage`）。
   *
   * 必须传：store 里的 `streamingMessage` 来自 `message_start` 的快照，而 pi-ai 在那一刻
   * 把 `usage` 全填 0（响应头刚到，还没计费）。旧实现 `end` 不带消息，于是
   * `finishedTurnRate` 读到的 `usage.output` 恒为 0、`finalRate` 恒 undefined —— 屏幕上
   * 永远只有 `字符÷4` 的估算，那个「真实 token/s」是条死代码。
   */
  | { type: "end"; message?: AgentMessage };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
  streamingMs: 0,
};

/** How long the finished turn's real TPS stays on screen after the stream ends. */
export const FINAL_RATE_TTL_MS = 8_000;

/**
 * The finished turn's real output speed, or undefined when the message carries no
 * usage (a cancelled turn, a provider that reports none).
 *
 * `usage.output` is the token count the provider actually billed, and `streamingMs` is
 * the wall clock the stream took — dividing them gives the same number DeepSeek Harness
 * prints as `{tps} tok/s`. Only produced when both are usable: a zero/absurd duration
 * would otherwise turn into an infinite rate.
 */
function finishedTurnRate(
  state: StreamingState,
  message: AssistantMessage | null,
): { tps: number; at: number } | undefined {
  const output = typeof message?.usage?.output === "number" ? message.usage.output : 0;
  // 分母优先用 decode 段（首 token → 末 token），与 DeepSeek Harness 同口径；
  // 老路径/重连没有首 token 时刻时退回整段墙钟（宁可略低，也不要凭空编）。
  const seconds = ((state.decodeMs ?? 0) > 0 ? state.decodeMs! : state.streamingMs) / 1000;
  if (output <= 0 || !Number.isFinite(seconds) || seconds < 0.2) return undefined;
  const tps = output / seconds;
  if (!Number.isFinite(tps) || tps <= 0) return undefined;
  return { tps, at: Date.now() };
}

function updateContentBlock(
  state: StreamingState,
  contentIndex: number,
  update: (current: AssistantContentBlock | undefined) => AssistantContentBlock | null,
): StreamingState {
  const message = state.streamingMessage;
  if (!message || !Number.isInteger(contentIndex) || contentIndex < 0) return state;

  const content = [...message.content];
  const nextBlock = update(content[contentIndex]);
  if (!nextBlock) return state;
  content[contentIndex] = nextBlock;
  return {
    // `...state` 是必须的：不展开会把 `startedAt` 丢掉，于是从第二个增量起
    // `Date.now() - (undefined ?? Date.now())` 恒为 0，`Math.max` 保留第一个
    // 增量的时刻 —— streamingMs 永久冻结，速度条的分母不再增长，tok/s 随流时长
    // 无界虚涨（实测 5.2s / 1000 字符：显示 500、实际 48）。
    ...state,
    isStreaming: true,
    streamingMessage: { ...message, content },
    streamingMs: Math.max(state.streamingMs, Date.now() - (state.startedAt ?? Date.now())),
  };
}

function applyDelta(
  state: StreamingState,
  event: ClientAssistantMessageEvent,
): StreamingState {
  switch (event.type) {
    case "text_start":
      // pi-ai documents `partial` as a shared live response-so-far helper, not
      // an event-time snapshot, and blocks as empty at their `*_start` and
      // grown only by `*_delta` until the authoritative `*_end`. By the time
      // this start is consumed the helper may already carry the block's first
      // delta, so a start must reset the block instead of keeping snapshot
      // text: otherwise that chunk renders twice until `text_end` arrives.
      return updateContentBlock(state, event.contentIndex, () => ({ type: "text", text: "" }));
    case "text_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "text"
          ? { ...current, text: current.text + event.delta }
          : null
      ));
    case "text_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "text" ? current : {}),
        type: "text",
        text: event.content,
      }));
    case "thinking_start":
      // Same snapshot leak as text_start: reset, or the first thinking chunk
      // renders twice until `thinking_end` replaces the block.
      return updateContentBlock(state, event.contentIndex, () => ({ type: "thinking", thinking: "" }));
    case "thinking_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "thinking"
          ? { ...current, thinking: current.thinking + event.delta }
          : null
      ));
    case "thinking_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "thinking" ? current : {}),
        type: "thinking",
        thinking: event.content,
      }));
    case "toolcall_start":
      return updateContentBlock(state, event.contentIndex, (current) => {
        if (current?.type === "toolCall") {
          return {
            ...current,
            toolCallId: event.id ?? current.toolCallId,
            toolName: event.toolName ?? current.toolName,
            // Same snapshot leak as text_start: the deltas rebuild rawInput.
            rawInput: "",
          };
        }
        if (typeof event.toolName !== "string") return null;
        return {
          type: "toolCall",
          toolCallId: event.id ?? "",
          toolName: event.toolName,
          input: {},
          rawInput: "",
        };
      });
    case "toolcall_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "toolCall"
          ? {
            ...current,
            toolCallId: event.id || current.toolCallId,
            toolName: event.toolName || current.toolName,
            rawInput: (current.rawInput ?? "") + event.delta,
          }
          : null
      ));
    case "toolcall_end":
      return updateContentBlock(state, event.contentIndex, () => ({
        type: "toolCall",
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name,
        input: event.toolCall.arguments,
      }));
    default:
      return state;
  }
}

export function streamReducer(
  state: StreamingState,
  action: StreamAction,
): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null, streamingMs: 0, startedAt: Date.now() };
    case "resume":
      return { ...state, isStreaming: true, startedAt: state.startedAt ?? Date.now() };
    case "snapshot": {
      const message = normalizeStreamingToolCalls(action.message);
      if (message.role !== "assistant") return state;
      // 重连时 snapshot 带来的是「已经流了数千字符的部分回复」——分子立刻很大，
      // 分母却是刚归零的时钟（速率条首采样直冲 ~2000 tok/s）。基线改落在这里：
      // 分母从这一刻起算，并把此刻已有的字符记成 baselineChars，速度条只数之后的
      // 新增。首帧与重连两条路径因此共用同一个语义。
      const baseline = message.content.reduce((total, block) => total
        + (block.type === "text" ? block.text.length
          : block.type === "thinking" ? block.thinking.length
            : block.type === "toolCall" ? (block.rawInput ?? "").length : 0), 0);
      return {
        isStreaming: true,
        streamingMessage: message,
        streamingMs: 0,
        startedAt: Date.now(),
        baselineChars: baseline,
      };
    }
    case "delta": {
      const next = applyDelta(state, action.event);
      if (next === state) return state;
      // 首 token 时刻与 decode 段在这里落点：`applyDelta` 的所有分支（text / thinking /
      // toolCall）都产出新状态，任一 个首个增量都算「开始吐 token」——与 DeepSeek Harness
      // 的 `isTokenDelta`（text-delta / reasoning-delta / tool-call-delta）同一判定范围。
      const now = Date.now();
      const firstTokenAt = state.firstTokenAt ?? now;
      return {
        ...next,
        firstTokenAt,
        decodeMs: Math.max(state.decodeMs ?? 0, now - firstTokenAt),
      };
    }
    case "end": {
      // Prefer the turn's real output tokens over the running estimate, so the
      // readout ends on the model's actual TPS rather than on a characters ÷ 4 guess.
      // `action.message` 是 message_end 的完整消息：只有它带真实的 `usage.output`。
      const settled = action.message?.role === "assistant" ? action.message : state.streamingMessage;
      const finished = finishedTurnRate(state, settled);
      return finished ? { ...INITIAL_STREAMING_STATE, finalRate: finished } : INITIAL_STREAMING_STATE;
    }
    default:
      return state;
  }
}

/**
 * The streaming state outside React: a chunk re-renders only the components
 * that subscribe to the part of it they show, not everything around the reply.
 * Listeners run synchronously in `dispatch`, so their state updates batch with
 * the ones the same event makes (message_end appends the reply and ends the
 * stream in one render).
 */
export interface StreamingStore {
  getState(): StreamingState;
  dispatch(action: StreamAction): void;
  subscribe(listener: () => void): () => void;
}

export function createStreamingStore(): StreamingStore {
  let state = INITIAL_STREAMING_STATE;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = streamReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
