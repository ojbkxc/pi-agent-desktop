import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 退避序列 / 封顶 / 抖动 / quota 起点 / 触顶（设计文档 §3、§7）。
 */

const jiti = createJiti(import.meta.url);
const backoff = await jiti.import("./backoff.ts");
const types = await jiti.import("./types.ts");

const { backoffDelayMs, advanceOutageBudget, isOutageDue, initialOutageBudget } = backoff;
const { OUTAGE_BACKOFF_MS, OUTAGE_QUOTA_BACKOFF_START_INDEX } = types;

const NOW = 1_800_000_000_000;
const mid = { random: () => 0.5 }; // 抖动因子 1.0

test("序列：30s/1m/2m/5m/10m/20m/30m 单调不减", () => {
  const seq = OUTAGE_BACKOFF_MS;
  assert.deepEqual(seq, [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000]);
  for (let i = 1; i < seq.length; i += 1) assert.ok(seq[i] >= seq[i - 1], `step ${i}`);
});

test("普通档第 n 次等待取对应档位（无抖动）", () => {
  assert.equal(backoffDelayMs(1, "outage", mid), 30_000);
  assert.equal(backoffDelayMs(2, "outage", mid), 60_000);
  assert.equal(backoffDelayMs(3, "outage", mid), 120_000);
  assert.equal(backoffDelayMs(7, "outage", mid), 1_800_000);
});

test("30 分钟封顶：再多次也不超过 30m", () => {
  assert.equal(backoffDelayMs(8, "outage", mid), 1_800_000);
  assert.equal(backoffDelayMs(100, "outage", mid), 1_800_000);
  assert.equal(backoffDelayMs(1000, "quota", mid), 1_800_000);
});

test("quota 从 5 分钟起跳", () => {
  assert.equal(OUTAGE_QUOTA_BACKOFF_START_INDEX, 3);
  assert.equal(backoffDelayMs(1, "quota", mid), 300_000);
  assert.equal(backoffDelayMs(2, "quota", mid), 600_000);
});

test("抖动在 ±20% 内（含边界）", () => {
  const low = backoffDelayMs(4, "outage", { random: () => 0 });   // -20%
  const high = backoffDelayMs(4, "outage", { random: () => 0.999999 }); // ≈ +20%
  const base = 300_000;
  assert.equal(low, Math.round(base * 0.8));
  assert.ok(high <= Math.round(base * 1.2), `${high} <= ${base * 1.2}`);
  assert.ok(high >= Math.round(base * 0.8));
});

test("advanceOutageBudget：次数耗尽 ⇒ expired", () => {
  const record = fakeRecord({ attempts: 39, maxAttempts: 40, deadlineAt: NOW + 3_600_000 });
  const result = advanceOutageBudget(record, NOW, mid);
  assert.equal(result.record.budget.attempts, 40);
  assert.equal(result.expired, true);
  assert.equal(result.delayMs, 0);
});

test("advanceOutageBudget：死线已到 ⇒ expired", () => {
  const record = fakeRecord({ attempts: 1, maxAttempts: 40, deadlineAt: NOW - 1 });
  const result = advanceOutageBudget(record, NOW, mid);
  assert.equal(result.expired, true);
});

test("advanceOutageBudget：正常推进时 nextAttemptAt 前移一个档位", () => {
  const record = fakeRecord({ attempts: 0, maxAttempts: 40, deadlineAt: NOW + 3_600_000 });
  const result = advanceOutageBudget(record, NOW, mid);
  assert.equal(result.record.budget.attempts, 1);
  assert.equal(result.record.budget.nextAttemptAt, NOW + 30_000);
  assert.equal(result.expired, false);
});

test("initialOutageBudget：立即到点（SDK 已重试过，不再等 30s）", () => {
  const budget = initialOutageBudget({ kind: "outage", now: NOW, maxWaitMs: 3_600_000, maxAttempts: 40 });
  assert.equal(budget.attempts, 0);
  assert.equal(budget.nextAttemptAt, NOW);
  assert.equal(budget.deadlineAt, NOW + 3_600_000);
});

test("isOutageDue：只在 waiting 且到点时为真", () => {
  const record = fakeRecord({ attempts: 0, maxAttempts: 40, deadlineAt: NOW + 1000, nextAttemptAt: NOW + 10 });
  assert.equal(isOutageDue(record, NOW), false);
  assert.equal(isOutageDue(record, NOW + 10), true);
  assert.equal(isOutageDue({ ...record, status: "expired" }, NOW + 10), false);
});

function fakeRecord(budget) {
  return {
    version: 1,
    sessionId: "s-1",
    kind: "outage",
    reason: "upstream 503",
    scope: "chat",
    origin: {},
    resume: { mode: "followup", note: "" },
    budget: {
      attempts: budget.attempts,
      maxAttempts: budget.maxAttempts,
      startedAt: NOW,
      deadlineAt: budget.deadlineAt,
      nextAttemptAt: budget.nextAttemptAt ?? NOW,
    },
    guard: {},
    status: "waiting",
    pid: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}