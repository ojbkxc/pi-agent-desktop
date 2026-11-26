import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * workflow 报告必须**有界**。
 *
 * 这份文本会被塞进下一轮 worker 的 prompt（ralph）或工具结果里，脚本可以 `return` 一整段
 * 代码、也可以 `log()` 一整段输出。审计实测：单节点 5000 字结果 → 报告 5481 字——节点结果
 * 截了 400 字，**`script result` 与 `logs` 一点没截**。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { formatWorkflowReport } = await jiti.import("./report.ts");

const base = {
  agents: 2,
  elapsedMs: 1_500,
  phases: [],
  results: [],
  logs: [],
  aborted: false,
};

test("a huge script return value is clipped", () => {
  const report = formatWorkflowReport({ ...base, value: "x".repeat(20_000) });
  assert.ok(report.length < 2_000, `报告 ${report.length} 字，未截断`);
  assert.match(report, /…/);
});

test("a huge object return value is clipped too", () => {
  const big = { rows: Array.from({ length: 500 }, (_, i) => ({ i, text: "y".repeat(50) })) };
  const report = formatWorkflowReport({ ...base, value: big });
  assert.ok(report.length < 2_500, `报告 ${report.length} 字，未截断`);
});

test("huge log entries are clipped and only the tail is kept", () => {
  const logs = Array.from({ length: 40 }, (_, i) => `[${i}] ${"z".repeat(2_000)}`);
  const report = formatWorkflowReport({ ...base, logs });
  assert.ok(report.length < 3_000, `报告 ${report.length} 字，日志未截断`);
  assert.match(report, /\[39\]/, "保留尾部（最新的）日志");
  assert.doesNotMatch(report, /\[0\]/, "最早的日志被切掉");
});

test("huge node results and errors are clipped", () => {
  const results = [
    { description: "ok-node", text: "a".repeat(5_000) },
    { description: "bad-node", text: null, error: "b".repeat(5_000) },
  ];
  const report = formatWorkflowReport({ ...base, results });
  assert.ok(report.length < 2_500, `报告 ${report.length} 字，未截断`);
});

test("a normal small report keeps everything (clipping must not mangle the useful case)", () => {
  const report = formatWorkflowReport({
    ...base,
    value: { count: 2 },
    results: [{ description: "n1", text: "fine" }],
    logs: ["started", "done"],
  });
  assert.match(report, /"count": 2/);
  assert.match(report, /n1: fine/);
  assert.match(report, /started \| done/);
  assert.doesNotMatch(report, /…/);
});
