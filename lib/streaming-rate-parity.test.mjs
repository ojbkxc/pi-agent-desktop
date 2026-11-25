import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 输出速度（TPS）与 DeepSeek Harness 同口径。
 *
 * 用户报：「下面显示的输出速度跟 DeepSeek Harness 的会话统计的输出速度完全不一样」。
 * 核对下来是三处叠加：
 *
 * 1. **`finalRate` 是死代码**（最硬的一条）。`end` 不带消息，而 store 里的
 *    `streamingMessage` 来自 `message_start` 快照——pi-ai 在那一刻把 `usage` 全填 0
 *    （响应头刚到、还没计费）。于是 `usage.output` 恒为 0、`finishedTurnRate` 恒
 *    undefined，屏幕上永远只有 `字符÷4` 估算。
 * 2. **分母含 TTFT**。`startedAt` 起于 `message_start`（一个 token 都没吐），而 dsh 的
 *    分母是「首 token → 消息组装完」的纯解码段。慢模型能差一倍以上。
 * 3. 取整口径不同（dsh：≥10 取整、<10 一位小数）。
 *
 * 修法：`end` 携带完成消息；`firstTokenAt` / `decodeMs` 在首个增量时落点；分母优先
 * 用 `decodeMs`，没有才退回整段墙钟。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const streaming = await jiti.import("./streaming-message.ts");

const { streamReducer, INITIAL_STREAMING_STATE } = streaming;

const assistant = (usage) => ({
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  usage,
});

test("`end` uses the finished message's real usage, not the zeroed start snapshot", () => {
  // message_start 快照：usage 全 0（真实形态）。
  const snapshot = assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  state = streamReducer(state, { type: "snapshot", message: snapshot });
  state = streamReducer(state, { type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "hi" } });
  // 真实一轮至少几百毫秒；这里把 decode 段设成 2 秒（<200ms 会被下限保护拒掉，那是刻意的）。
  state = { ...state, decodeMs: 2_000 };
  // 完成消息：真实 output=100。
  const completed = assistant({ input: 10, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 110 });
  const ended = streamReducer(state, { type: "end", message: completed });
  assert.ok(ended.finalRate, "the real-token branch must fire (it was dead before: usage.output was 0)");
  assert.equal(Math.round(ended.finalRate.tps), 50, "100 tokens over a 2s decode window = 50 tok/s");
});

test("without a finished message the estimate stays off (no fabricated rate)", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  state = streamReducer(state, { type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "hi" } });
  const ended = streamReducer(state, { type: "end" });
  assert.equal(ended.finalRate, undefined, "no usage ⇒ no number, never a guess");
});

test("the denominator is the decode segment (first token → last), not the whole wall clock", () => {
  const snapshot = assistant({ output: 0 });
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  state = streamReducer(state, { type: "snapshot", message: snapshot });
  // 模拟「TTFT 很慢」：把 startedAt 往前推 5 秒，但首 token 时刻是刚刚。
  state = { ...state, startedAt: Date.now() - 5_000 };
  state = streamReducer(state, { type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "a" } });
  assert.ok(typeof state.firstTokenAt === "number", "first token time is recorded on the first delta");
  assert.ok(state.decodeMs !== undefined && state.decodeMs < 1_000, "decodeMs starts at the first token, not at start");
  assert.ok(state.streamingMs >= 5_000, "the wall clock still spans the TTFT");
});

test("an assistant message without usage yields no rate", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  state = streamReducer(state, { type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "a" } });
  const ended = streamReducer(state, { type: "end", message: assistant(undefined) });
  assert.equal(ended.finalRate, undefined);
});

test("a sub-200ms decode window is refused (guards divide-by-near-zero)", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  state = streamReducer(state, { type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "a" } });
  // 手工把 decode 段压到 50ms。
  state = { ...state, decodeMs: 50 };
  const ended = streamReducer(state, { type: "end", message: assistant({ output: 500 }) });
  assert.equal(ended.finalRate, undefined, "a 50ms window would read 10000 tok/s");
});
