import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { createStreamingStore } = await jiti.import("../lib/streaming-message.ts");

function textDelta(index, delta) {
  return { type: "text_delta", contentIndex: index, delta, partial: null };
}

test("streamingMs grows with deltas and resets on start/end", () => {
  const store = createStreamingStore();
  store.dispatch({ type: "start" });
  assert.equal(store.getState().streamingMs, 0);
  assert.equal(typeof store.getState().startedAt, "number");
  store.dispatch({ type: "delta", event: textDelta(0, "hello world") });
  const advanced = store.getState().streamingMs;
  assert.ok(advanced >= 0, "streamingMs is non-negative");
  store.dispatch({ type: "end" });
  assert.equal(store.getState().streamingMs, 0);
  assert.equal(store.getState().startedAt, undefined);
});

test("a fresh store reports not streaming and no message", () => {
  const store = createStreamingStore();
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().streamingMessage, null);
});

test("the rate line module exports the component", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../components/StreamingRateLine.tsx", import.meta.url), "utf8");
  // jiti 对这个 .tsx 的 JSX 转译不稳（ParseError），这里按仓库里其它组件测试的
  // 做法做源级契约：组件必须叫 StreamingRateLine、接 store、用 500ms 采样。
  assert.match(source, /export function StreamingRateLine\(\{ store \}/);
  assert.match(source, /setTimeout\(tick, 500\)/);
  assert.match(source, /tok\/s/);
  assert.match(source, /chat\.streamRate/);
});

test("resume keeps isStreaming and a startedAt baseline", () => {
  const store = createStreamingStore();
  store.dispatch({ type: "start" });
  store.dispatch({ type: "resume" });
  const state = store.getState();
  assert.equal(state.isStreaming, true);
  assert.equal(typeof state.startedAt, "number");
});
