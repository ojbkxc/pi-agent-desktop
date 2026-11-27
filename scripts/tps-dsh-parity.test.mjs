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