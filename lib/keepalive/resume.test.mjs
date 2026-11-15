import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 接续（只读半边）：autofix 任务分类与只读汇总。
 * 判据与 t3 约定逐字对齐：pid 活着 ⇒ 永不孤儿；pid 死/缺 才看 updatedAt 是否超过
 * staleMs（默认 10 分钟）。
 */

const jiti = createJiti(import.meta.url);
const resume = await jiti.import("./resume.ts");

const STALE = 10 * 60_000;
const NOW = 1_800_000_000_000;
const dead = () => false;
const alive = () => true;

function task(overrides = {}) {
  return {
    version: 1,
    id: "t-1",
    task: "修 CI",
    cwd: "/work",
    status: "running",
    round: 1,
    maxRounds: 20,
    lastError: null,
    sessionId: "s-1",
    pid: 1234,
    updatedAt: NOW - STALE - 1,
    ...overrides,
  };
}

test("finished 状态：succeeded / failed / exhausted / stopped", () => {
  assert.equal(resume.classifyAutofixTask(task({ status: "succeeded" })), "succeeded");
  for (const status of ["failed", "exhausted", "stopped"]) {
    assert.equal(resume.classifyAutofixTask(task({ status })), "failed", status);
  }
});

test("pid 活着 ⇒ 活跃孤儿判据永远不命中（长 agent 轮不看 updatedAt）", () => {
  const longRound = task({ pid: 4321, updatedAt: NOW - 24 * 3_600_000 });
  assert.equal(
    resume.classifyAutofixTask(longRound, { now: NOW, staleMs: STALE, alive }),
    "active",
  );
});

test("pid 已死：updatedAt 超过阈值才可接续，新鲜的是 waiting（可能正被接手）", () => {
  assert.equal(
    resume.classifyAutofixTask(task({ pid: 999, updatedAt: NOW - STALE - 1 }), { now: NOW, staleMs: STALE, alive: dead }),
    "resumable",
  );
  assert.equal(
    resume.classifyAutofixTask(task({ pid: 999, updatedAt: NOW - 1000 }), { now: NOW, staleMs: STALE, alive: dead }),
    "waiting",
  );
});

test("pid 缺失：没有心跳信息按陈旧处理，有更新时间的按阈值", () => {
  assert.equal(
    resume.classifyAutofixTask(task({ pid: null, updatedAt: undefined }), { now: NOW, staleMs: STALE, alive: dead }),
    "resumable",
  );
  assert.equal(
    resume.classifyAutofixTask(task({ pid: null, updatedAt: NOW - STALE - 1 }), { now: NOW, staleMs: STALE, alive: dead }),
    "resumable",
  );
  assert.equal(
    resume.classifyAutofixTask(task({ pid: null, updatedAt: NOW - 1000 }), { now: NOW, staleMs: STALE, alive: dead }),
    "waiting",
  );
});

test("queued/verifying 同属活跃；格式不合法是 unknown", () => {
  assert.equal(
    resume.classifyAutofixTask(task({ status: "queued", pid: 999 }), { now: NOW, staleMs: STALE, alive: dead }),
    "resumable",
  );
  assert.equal(
    resume.classifyAutofixTask(task({ status: "verifying", pid: 999 }), { now: NOW, staleMs: STALE, alive: dead }),
    "resumable",
  );
  // 只有 status 的退化记录：pid 与 updatedAt 都没有，按「没有活着的证据」= 可接续
  // （真正的 runner 总会写 updatedAt；这里只要不把死任务当成 active 就够）。
  assert.equal(resume.classifyAutofixTask({ status: "running" }, { now: NOW }), "resumable");
  assert.equal(resume.classifyAutofixTask("nope", { now: NOW }), "unknown");
  assert.equal(resume.classifyAutofixTask(task({ status: "banana" }), { now: NOW }), "unknown");
});

test("scanAutofixTasks：只读扫描目录，汇总 active/stuck/succeeded/failed", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-keepalive-scan-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const tasksDir = join(agentDir, "autofix", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const write = (name, value) => writeFileSync(join(tasksDir, name), JSON.stringify(value));
  write("a.json", task({ id: "a", status: "running", pid: 111, updatedAt: NOW - 1000 }));
  write("b.json", task({ id: "b", status: "running", pid: 999, updatedAt: NOW - STALE - 1 }));
  write("c.json", task({ id: "c", status: "succeeded" }));
  write("d.json", task({ id: "d", status: "failed" }));
  write("e.json", { status: "running", pid: null, updatedAt: NOW - STALE - 1 });
  writeFileSync(join(tasksDir, "broken.json"), "{not json");

  const scanned = resume.scanAutofixTasks({
    agentDir,
    now: NOW,
    staleMs: STALE,
    alive: () => false,
  });
  assert.equal(scanned.unavailable, false);
  assert.deepEqual(scanned.summary, { total: 5, active: 1, stuck: 2, succeeded: 1, failed: 1 });
  assert.deepEqual(scanned.resumableIds.sort(), ["b", "e"]);
});

test("scanAutofixTasks：目录不存在时 unavailable=true 且零计数（UI 显示「未启用」）", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-keepalive-scan-missing-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const scanned = resume.scanAutofixTasks({ agentDir, now: NOW });
  assert.equal(scanned.unavailable, true);
  assert.deepEqual(scanned.summary, { total: 0, active: 0, stuck: 0, succeeded: 0, failed: 0 });
});

test("buildRecoveryNote：接续轮必须先核对现场，且带上任务/轮次/上次错误", () => {
  const note = resume.buildRecoveryNote({
    task: "修登录 bug",
    cwd: "/work",
    round: 3,
    lastError: "verify failed: 2 tests",
  });
  assert.match(note, /接续轮/);
  assert.match(note, /修登录 bug/);
  assert.match(note, /\/work/);
  assert.match(note, /已完成轮次：3/);
  assert.match(note, /verify failed: 2 tests/);
  assert.match(note, /不要从头重来/);
});
