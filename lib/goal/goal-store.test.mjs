import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/goal` 纯状态机 + 续跑双闸 + 落盘。
 *
 * 全部无 SDK、无扩展：applyGoalEvent / shouldContinueGoal / goalGateExceeded 是纯函数，
 * 单测直接把状态迁移与 20 轮 / 10 分钟双闸锁死。落盘用临时 home 目录隔离。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  applyGoalEvent,
  shouldContinueGoal,
  goalGateExceeded,
  isGoalState,
  readGoalState,
  writeGoalState,
  goalFilePath,
  safeGoalFileStem,
} = await jiti.import("./goal-store.ts");
const { GOAL_DEFAULT_LIMITS } = await jiti.import("./goal-types.ts");

const T0 = 1_000_000;
const base = (over = {}) => ({
  sessionId: "s-1",
  objective: "ship the feature",
  status: "active",
  continuations: 0,
  maxContinuations: GOAL_DEFAULT_LIMITS.maxContinuations,
  startedAt: T0,
  elapsedMs: 0,
  updatedAt: T0,
  ...over,
});

// ───────────────────────── 默认双闸值（变异守卫）─────────────────────────

test("默认双闸 = 20 轮 / 10 分钟（改错这两个常量 → 下面边界断言必红）", () => {
  assert.equal(GOAL_DEFAULT_LIMITS.maxContinuations, 20);
  assert.equal(GOAL_DEFAULT_LIMITS.maxElapsedMs, 600_000);
});

// ───────────────────────── 状态迁移 ─────────────────────────

test("created：凭空建态，计数/计时归零，状态 active", () => {
  const next = applyGoalEvent(null, { type: "created", sessionId: "s-9", objective: "do it" }, T0);
  assert.equal(next.status, "active");
  assert.equal(next.sessionId, "s-9");
  assert.equal(next.objective, "do it");
  assert.equal(next.continuations, 0);
  assert.equal(next.maxContinuations, 20);
  assert.equal(next.startedAt, T0);
  assert.equal(next.elapsedMs, 0);
});

test("created：可带 budget 与自定义 maxContinuations", () => {
  const next = applyGoalEvent(null, { type: "created", sessionId: "s-9", objective: "x", budget: 500, maxContinuations: 3 }, T0);
  assert.equal(next.budget, 500);
  assert.equal(next.maxContinuations, 3);
});

test("非 created 事件在无既有目标时返回 null", () => {
  for (const event of [{ type: "message" }, { type: "paused" }, { type: "resumed" }, { type: "completed" }, { type: "cleared" }, { type: "replaced", objective: "y" }]) {
    assert.equal(applyGoalEvent(null, event, T0), null, JSON.stringify(event));
  }
});

test("replaced：换目标是全新一轮（计数归零、计时重开）", () => {
  const current = base({ continuations: 7, startedAt: T0 - 60_000 });
  const next = applyGoalEvent(current, { type: "replaced", objective: "new objective" }, T0);
  assert.equal(next.objective, "new objective");
  assert.equal(next.status, "active");
  assert.equal(next.continuations, 0);
  assert.equal(next.startedAt, T0);
  assert.equal(next.elapsedMs, 0);
});

test("paused / completed / cleared：只改状态，保留 objective", () => {
  for (const [event, status] of [[{ type: "paused" }, "paused"], [{ type: "completed", summary: "done" }, "completed"], [{ type: "cleared" }, "cleared"]]) {
    const next = applyGoalEvent(base(), event, T0 + 5000);
    assert.equal(next.status, status, JSON.stringify(event));
    assert.equal(next.objective, "ship the feature");
    assert.equal(next.elapsedMs, 5000, "刷新 elapsedMs");
  }
});

test("status 事件：直接设任意状态", () => {
  assert.equal(applyGoalEvent(base(), { type: "status", status: "paused" }, T0).status, "paused");
});

test("resumed：计数归零、计时重开（恢复给全新预算）", () => {
  const current = base({ status: "paused", continuations: 20, startedAt: T0 - 700_000 });
  const next = applyGoalEvent(current, { type: "resumed" }, T0);
  assert.equal(next.status, "active");
  assert.equal(next.continuations, 0);
  assert.equal(next.startedAt, T0);
});

test("message：每次续跑轮数 +1", () => {
  const next = applyGoalEvent(base({ continuations: 3 }), { type: "message" }, T0 + 1000);
  assert.equal(next.continuations, 4);
});

test("迁移不修改入参", () => {
  const current = base();
  const frozen = JSON.stringify(current);
  applyGoalEvent(current, { type: "message" }, T0 + 1);
  assert.equal(JSON.stringify(current), frozen);
});

// ───────────────────────── 续跑双闸 ─────────────────────────

test("shouldContinueGoal：active + 无 pending + 未触顶 → 续", () => {
  assert.equal(shouldContinueGoal(base(), T0 + 1000, false), true);
  assert.equal(shouldContinueGoal(base({ continuations: 19 }), T0 + 1000, false), true, "第 20 轮前仍续");
});

test("shouldContinueGoal：无目标 / 非 active 一律不续", () => {
  assert.equal(shouldContinueGoal(null, T0, false), false);
  for (const status of ["paused", "completed", "cleared"]) {
    assert.equal(shouldContinueGoal(base({ status }), T0, false), false, status);
  }
});

test("shouldContinueGoal：有 pending 用户消息不续（让用户驱动下一轮）", () => {
  assert.equal(shouldContinueGoal(base(), T0 + 1000, true), false);
});

test("shouldContinueGoal：轮数触顶（20）不续", () => {
  assert.equal(shouldContinueGoal(base({ continuations: 20 }), T0 + 1000, false), false);
  assert.equal(shouldContinueGoal(base({ continuations: 25 }), T0 + 1000, false), false);
});

test("shouldContinueGoal：时间触顶（10 分钟）不续", () => {
  assert.equal(shouldContinueGoal(base(), T0 + 600_000, false), false, "恰好 10 分钟即停");
  assert.equal(shouldContinueGoal(base(), T0 + 599_999, false), true);
});

test("goalGateExceeded：报出撞的是哪道闸；未触顶/非 active → null", () => {
  assert.equal(goalGateExceeded(base(), T0 + 1000), null);
  assert.equal(goalGateExceeded(base({ continuations: 20 }), T0 + 1000), "maxContinuations");
  assert.equal(goalGateExceeded(base(), T0 + 600_000), "maxElapsedMs");
  assert.equal(goalGateExceeded(base({ status: "paused", continuations: 99 }), T0 + 999_999), null, "非 active 不判闸");
});

test("触顶 → 交回的是 paused（扩展据此落库 + notify，绝不静默续跑）", () => {
  // 模拟扩展在 agent_settled 里对两轮触顶的处理：不续 + 转 paused。
  for (const state of [base({ continuations: 20 }), base({ startedAt: T0 - 600_000 })]) {
    const shouldContinue = shouldContinueGoal(state, T0, false);
    const gate = goalGateExceeded(state, T0);
    assert.equal(shouldContinue, false);
    assert.ok(gate, "撞了某道闸");
    const next = applyGoalEvent(state, { type: "paused" }, T0);
    assert.equal(next.status, "paused");
    assert.equal(goalGateExceeded(next, T0), null, "paused 后不再判闸");
  }
});

// ───────────────────────── 结构守卫 + 落盘 ─────────────────────────

test("isGoalState：合法通过；缺字段 / 坏状态拒绝", () => {
  assert.equal(isGoalState(base()), true);
  assert.equal(isGoalState({ ...base(), status: "weird" }), false);
  assert.equal(isGoalState({ ...base(), continuations: undefined }), false);
  assert.equal(isGoalState({ ...base(), sessionId: "" }), false);
  assert.equal(isGoalState(null), false);
});

test("落盘往返 + 坏 JSON / 缺文件容错", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-goal-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.equal(readGoalState("s-1", home), null, "缺文件 → null");
  const state = base();
  writeGoalState(state, home);
  assert.deepEqual(readGoalState("s-1", home), state, "写后可读回");

  // 坏 JSON → null（不抛）
  await writeFile(goalFilePath("s-bad", home), "{ not json");
  assert.equal(readGoalState("s-bad", home), null);

  // 结构不合法 → null
  await writeFile(goalFilePath("s-shape", home), JSON.stringify({ sessionId: "s-shape" }));
  assert.equal(readGoalState("s-shape", home), null);

  // 文件名做安全化，且落盘是纯 JSON
  assert.equal(safeGoalFileStem("a/b\\c d"), "a_b_c_d");
  const raw = await readFile(goalFilePath("s-1", home), "utf8");
  assert.equal(JSON.parse(raw).objective, "ship the feature");
});
