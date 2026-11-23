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
}

export type StreamAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "snapshot"; message: AgentMessage }
  | { type: "delta"; event: ClientAssistantMessageEvent }
  | { type: "end" };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
  streamingMs: 0,
};

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
    isStreaming: true,
    streamingMessage: { ...message, content },
    // 每个 delta 事件把时间轴推进它的「到达时刻差」由 store 统一维护太复杂，
    // 这里用「事件发生时刻 − 流开始时刻」：与字符累计完全同基线。
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
      return message.role === "assistant"
        ? {
          isStreaming: true,
          streamingMessage: message,
          streamingMs: state.streamingMs,
          startedAt: state.startedAt ?? Date.now(),
        }
        : state;
    }
    case "delta":
      return applyDelta(state, action.event);
    case "end":
      return INITIAL_STREAMING_STATE;
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
