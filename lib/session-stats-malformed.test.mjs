import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 持久化审计 P3-1：一条 `type:"message"` 但缺 `message` 的条目让整个详情读取 500。
 *
 * 扫描器对这条形状有守卫（列表照常出），统计侧没有——于是出现最糟的组合：
 * 会话在列表里看得见，点开却 500。修法是在统计的两处入口跳过畸形条目，而不是
 * 让一条坏数据显示不出来整场会话。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { computeSessionStats } = await jiti.import("./session-stats.ts");
const { getUsageCostBreakdown } = await jiti.import("./usage-breakdown.ts");

const malformed = {
  entries: [
    { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
    // The shape that used to throw: typed `message`, no `message` object.
    { type: "message", id: "bad", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" },
    {
      type: "message",
      id: "ok",
      parentId: null,
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    },
  ],
};

test("computeSessionStats skips a message entry with no message instead of throwing", () => {
  const stats = computeSessionStats(malformed.entries);
  assert.equal(stats.userMessages, 1, "the readable message still counts");
  // The malformed entry is not counted as a message (it has no message to count).
  assert.equal(stats.totalMessages, 1);
});

test("getUsageCostBreakdown survives the same malformed entry", () => {
  assert.doesNotThrow(() => getUsageCostBreakdown(malformed.entries));
});