import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * tok/s 速度条的时间口径回归测试。
 *
 * 缺陷源（2026-11-23 审计 D1/D2）：
 * - `updateContentBlock` 返回新对象时没展开 `state`，把 `startedAt` 丢掉 → 第二个
 *   增量起 `streamingMs` 冻结，分母不涨、分子一直涨，速率随流时长无界虚涨
 *   （实测 5.2s / 1000 字符：显示 500 tok/s，实际 48）。
 * - 重连 snapshot 带来数千字符，分母却从重连时刻归零 → 首采样直冲 ~2000 tok/s。
 *
 * 两条都必须用**可控 Date.now** 重放多增量序列才测得出；旧的 `>= 0` 断言正是漏检根因。
 *
 * 注：真实事件流在 `message_start` 先派一次 `snapshot` 再收 `*_delta`；`updateContentBlock`
 * 在没有 streamingMessage 时按设计不动（增量无处可落），所以这里的序列也照此铺。
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { createStreamingStore } = await jiti.import("../lib/streaming-message.ts");

const originalNow = Date.now;

function withClock(startAt, run) {
  let now = startAt;
  Date.now = () => now;
  try {
    return run({ advance: (ms) => { now += ms; }, at: () => now });
  } finally {
    Date.now = originalNow;
  }
}

/** 真实事件流的开头：start → snapshot（空回复）→ 各块增量。 */
function openTurn(store, clock, { startAtMs = 0 } = {}) {
  store.dispatch({ type: "start" });
  if (startAtMs > 0) clock.advance(startAtMs);
  store.dispatch({ type: "snapshot", message: { role: "assistant", content: [{ type: "text", text: "" }] } });
}

function textDelta(index, delta) {
  return { type: "text_delta", contentIndex: index, delta, partial: null };
}

test("streamingMs advances with every delta instead of freezing at the first one", () => {
  withClock(1_000_000, (clock) => {
    const store = createStreamingStore();
    openTurn(store, clock, { startAtMs: 200 });
    const observed = [];
    for (let step = 1; step <= 10; step += 1) {
      clock.advance(500);
      store.dispatch({ type: "delta", event: textDelta(0, "x".repeat(100)) });
      observed.push(store.getState().streamingMs);
    }
    assert.deepEqual(observed, [500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000]);
    assert.equal(typeof store.getState().startedAt, "number", "startedAt must survive every delta");
  });
});

test("the reported rate stays near the truth over a long stream", () => {
  withClock(2_000_000, (clock) => {
    const store = createStreamingStore();
    openTurn(store, clock);
    const charsPerTick = 100;
    const ticks = 10; // 5000ms 内 1000 字符
    for (let step = 1; step <= ticks; step += 1) {
      clock.advance(500);
      store.dispatch({ type: "delta", event: textDelta(0, "x".repeat(charsPerTick)) });
    }
    const state = store.getState();
    const shownRate = (charsPerTick * ticks / 4) / Math.max(state.streamingMs / 1000, 0.5);
    const trueRate = (charsPerTick * ticks / 4) / 5; // 1000 字符 / 4 ÷ 5 秒
    assert.ok(Math.abs(shownRate - trueRate) / trueRate < 0.5,
      `shown ${shownRate.toFixed(0)} tok/s vs true ${trueRate.toFixed(0)} tok/s — the denominator is not advancing`);
  });
});

test("a snapshot after reconnect resets the clock and counts only later characters", () => {
  withClock(3_000_000, (clock) => {
    const store = createStreamingStore();
    store.dispatch({ type: "start" });
    clock.advance(1_000);
    store.dispatch({
      type: "snapshot",
      message: { role: "assistant", content: [{ type: "text", text: "y".repeat(4_000) }] },
    });
    const reconnected = store.getState();
    assert.equal(reconnected.streamingMs, 0, "the clock restarts at the snapshot");
    assert.equal(reconnected.baselineChars, 4_000, "the characters already on screen are the baseline");

    clock.advance(1_000);
    store.dispatch({ type: "delta", event: textDelta(0, "z".repeat(100)) });
    const after = store.getState();
    assert.equal(after.streamingMs, 1_000, "the denominator counts from the reconnect");
    const newChars = after.streamingMessage.content[0].text.length - after.baselineChars;
    assert.equal(newChars, 100, "the numerator counts only what arrived after the reconnect");
  });
});

test("a fresh start clears a previous baseline", () => {
  withClock(4_000_000, () => {
    const store = createStreamingStore();
    store.dispatch({
      type: "snapshot",
      message: { role: "assistant", content: [{ type: "text", text: "abc" }] },
    });
    assert.equal(store.getState().baselineChars, 3);
    store.dispatch({ type: "start" });
    assert.equal(store.getState().baselineChars, undefined, "a new turn has no inherited baseline");
    assert.equal(store.getState().streamingMs, 0);
  });
});

test("thinking and tool-call deltas advance the same clock as text", () => {
  withClock(5_000_000, (clock) => {
    const store = createStreamingStore();
    openTurn(store, clock);
    clock.advance(300);
    store.dispatch({ type: "delta", event: { type: "thinking_start", contentIndex: 0, partial: null } });
    clock.advance(700);
    store.dispatch({ type: "delta", event: { type: "thinking_delta", contentIndex: 0, delta: "plan", partial: null } });
    assert.equal(store.getState().streamingMs, 1_000);
    clock.advance(500);
    store.dispatch({ type: "delta", event: { type: "toolcall_start", contentIndex: 1, toolName: "ls", partial: null } });
    assert.equal(store.getState().streamingMs, 1_500);
  });
});

test("a delta before any message is ignored instead of inventing a block", () => {
  withClock(6_000_000, (clock) => {
    const store = createStreamingStore();
    store.dispatch({ type: "start" });
    clock.advance(500);
    // 没有 snapshot 就先来增量：按设计不动（增量无处可落），不是崩溃也不是假进度。
    store.dispatch({ type: "delta", event: textDelta(0, "orphan") });
    assert.equal(store.getState().streamingMessage, null);
    assert.equal(store.getState().streamingMs, 0);
  });
});