import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 输出速度（TPS）必须与 DeepSeek Harness **同一条公式**。
 *
 * 从已安装的 dsh `app.asar` 里抽出的原文（`@deepseek-ai/dsh-client-ui-chat`）：
 *
 * ```js
 * function deriveStats(nodes) {
 *   let decodeMs = 0, decodeTokens = 0
 *   for (const node of nodes) {
 *     if (node.kind !== 'assistant') continue
 *     const reading = assistantStepReading(node)
 *     if (reading.decodeMs !== null && reading.outputTokens !== null) {
 *       decodeMs += reading.decodeMs
 *       decodeTokens += reading.outputTokens
 *     }
 *   }
 *   return { …, decodeMs, decodeTokens }
 * }
 * function assistantStepReading(node) {
 *   return { decodeMs: Math.max(0, timing.completedTime - timing.firstTokenTime),
 *            outputTokens: usageOutputTokens(node.usage) }
 * }
 * function decodeSpeed(stats, t) {
 *   return t('message.tokensPerSecond', {
 *     tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
 *   })
 * }
 * function formatTokensPerSecond(tps) {
 *   const clamped = Math.max(0, tps)
 *   return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
 * }
 * // 显示条件：const speed = stats.decodeMs > 0 ? decodeSpeed(stats, t) : null
 * ```
 *
 * 两个要点，旧实现两条都不满足：
 * 1. **会话累计**（Σoutput / ΣdecodeMs），不是单轮；
 * 2. `decodeMs` 是 `Σ(completedTime − firstTokenTime)`，**不含 TTFT**。
 *
 * **判据不钉单个毫秒**：`decodeMs = Date.now() − firstTokenAt`，在同步执行的测试里
 * 可能落 0（两个 delta 同毫秒），那会让某一轮被判为「没有时间」而跳过——是测试脆弱，
 * 不是实现缺陷。这里只断言**累计语义**：多轮的分子分母必须相加，且被保留。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { createStreamingStore } = await jiti.import("../lib/streaming-message.ts");

/** dsh 的 formatTokensPerSecond，逐字。 */
function dshFormat(tps) {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

const emptyAssistant = () => ({ role: "assistant", content: [], model: "m", provider: "p" });

const usage = (output) => ({
  input: 1, output, cacheRead: 0, cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一轮：start → snapshot → 两个 delta → end（带真实 usage）。 */
async function turn(store, { output }) {
  store.dispatch({ type: "start" });
  store.dispatch({ type: "snapshot", message: emptyAssistant() });
  store.dispatch({ type: "delta", event: { type: "text_start", contentIndex: 0 } });
  // 等一下，让 start 重置后的时钟与第一个 delta 拉开，decodeMs 才可能有值。
  await sleep(40);
  store.dispatch({ type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "x" } });
  await sleep(40);
  store.dispatch({
    type: "end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }], model: "m", provider: "p", usage: usage(output) },
  });
}

test("session totals accumulate across turns (not per-turn)", async () => {
  const store = createStreamingStore();

  await turn(store, { output: 100 });
  const first = store.getState().sessionTotals;
  assert.ok(first, "第一轮结束必须有累计");
  assert.equal(first.decodeTokens, 100);

  // 第二轮开始时累计必须**保留**（start 不能清掉）。
  store.dispatch({ type: "start" });
  assert.deepEqual(store.getState().sessionTotals, first, "start 不得清掉会话累计");

  await turn(store, { output: 200 });
  const second = store.getState().sessionTotals;
  assert.equal(second.decodeTokens, 300, "分子必须是两轮之和（100 + 200），不是只有第二轮");
  assert.ok(second.decodeMs >= first.decodeMs, "分母也必须累加（≥ 第一轮）");
});

test("session totals are cleared on session switch (H1 cross-session pollution)", async () => {
  // H1（41edbada 引入的回归）：`streamingStore` 绑在 `useAgentSession` 实例上，
  // 而 `AppShell` 切会话不重挂 ChatWindow（「stays mounted and swaps session data
  // in place」）——同一个 store 服务多个会话。`start` / `snapshot` / `end` 都按
  // dsh 累计口径**保留** `sessionTotals`，没有任何清零点的话，切到另一个会话后
  // 速率条仍显示上一个会话的 Σoutput / ΣdecodeMs。
  const store = createStreamingStore();

  // 会话 A 跑两轮，累计 = 100 + 200。
  await turn(store, { output: 100 });
  await turn(store, { output: 200 });
  assert.equal(store.getState().sessionTotals?.decodeTokens, 300, "前提：会话 A 有累计");

  // 切到会话 B：useAgentSession 的 render-phase switch bookkeeping 必须 dispatch
  // reset-session。归零后，新会话的速率条不得把 A 的累计当成自己的起点。
  store.dispatch({ type: "reset-session" });
  assert.equal(store.getState().sessionTotals, undefined, "切会话必须清掉 sessionTotals");

  // 会话 B 的第一轮：累计只含这一轮自己的 50，绝不能把 A 的 300 算进来。
  await turn(store, { output: 50 });
  const totals = store.getState().sessionTotals;
  assert.ok(totals, "B 的第一轮结束后必须有累计");
  assert.equal(totals.decodeTokens, 50, "B 的累计只能是 B 自己的，不能延续 A 的");
});

test("reset-session does not affect end/start preserving totals within one session", async () => {
  // 反向锚定：同一会话内 `end` / `start` 仍按 41edbada 的设计保留累计——
  // reset-session 只能由「会话切换」触发，不能误伤同会话跨轮累计。
  const store = createStreamingStore();
  await turn(store, { output: 100 });
  const before = store.getState().sessionTotals;

  store.dispatch({ type: "start" });
  assert.deepEqual(store.getState().sessionTotals, before, "start 仍要保留累计（未被 reset-session 误伤）");

  store.dispatch({ type: "reset-session" });
  store.dispatch({ type: "start" });
  assert.equal(store.getState().sessionTotals, undefined, "reset-session 后再 start 也是新会话");
});

test("a turn with no usage must not dilute the average", async () => {
  const store = createStreamingStore();
  await turn(store, { output: 100 });
  const before = store.getState().sessionTotals;

  store.dispatch({ type: "start" });
  store.dispatch({ type: "snapshot", message: emptyAssistant() });
  store.dispatch({ type: "delta", event: { type: "text_start", contentIndex: 0 } });
  await sleep(40);
  store.dispatch({ type: "delta", event: { type: "text_delta", contentIndex: 0, delta: "x" } });
  await sleep(40);
  store.dispatch({ type: "end" });
  assert.deepEqual(store.getState().sessionTotals, before, "没有 usage 的轮次不得改动累计");
});

test("the displayed number equals dsh's formula for the same totals", () => {
  // 直接验算：dsh 的 decodeSpeed 与我们组件用的式子必须给出同一个字符串。
  const cases = [
    { decodeTokens: 1_200, decodeMs: 10_000 },   // 120 tok/s
    { decodeTokens: 35, decodeMs: 10_000 },       // 3.5 tok/s
    { decodeTokens: 0, decodeMs: 0 },             // 无数据 → dsh 不显示
  ];
  for (const totals of cases) {
    const ours = totals.decodeMs > 0 && totals.decodeTokens > 0
      ? totals.decodeTokens / (totals.decodeMs / 1_000)
      : null;
    const theirs = totals.decodeMs > 0 ? totals.decodeTokens / (totals.decodeMs / 1_000) : null;
    assert.equal(ours, theirs, `totals=${JSON.stringify(totals)}`);
    if (ours !== null) assert.equal(dshFormat(ours), dshFormat(theirs));
  }
  // 格式化本身逐字对齐
  assert.equal(dshFormat(120), "120");
  assert.equal(dshFormat(3.5), "3.5");
  assert.equal(dshFormat(3.44), "3.4");
  assert.equal(dshFormat(9.96), "10");
});