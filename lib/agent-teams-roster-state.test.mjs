import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 未派发的计划不占全局名额（团队计数审计 P0-2）。
 *
 * 报的现象：「活跃成员从 27 涨到 34，已经超过上限 32」。根因不是配额算错，而是**把名册
 * 人数当成活跃数**：`readPlanRosterMembers` 不看 `plan.state`，于是「还没批准的计划」
 * 与「已经取消的计划」里的成员都算占用；再叠加「停掉的名册条目永久保留」
 * （`release(tombstone:false)` 刻意如此），数字只涨不降。
 *
 * 这条口径刻意只排除**明确列举**的未派发状态（draft / review_pending / cancelled），
 * 其余（含字段缺失、老格式、上游新增状态）照旧计入：少算一个真在跑的成员会让配额
 * 超卖，多算一个未派发的只是回到旧行为。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const roster = await jiti.import("./agent-teams-roster.ts");

const root = mkdtempSync(join(tmpdir(), "pi-roster-state-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

function seedPlan(team, plan) {
  const dir = join(root, team);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan), "utf8");
  return dir;
}

const MEMBERS = [{ id: "m1", name: "alice" }, { id: "m2", name: "bob" }];

test("a draft plan occupies nothing", async () => {
  const dir = seedPlan("t-draft", { state: "draft", members: MEMBERS });
  assert.deepEqual(await roster.readPlanRosterMembers(dir), []);
});

test("a plan awaiting review occupies nothing", async () => {
  const dir = seedPlan("t-review", { state: "review_pending", members: MEMBERS });
  assert.deepEqual(await roster.readPlanRosterMembers(dir), []);
});

test("a cancelled plan releases its members", async () => {
  const dir = seedPlan("t-cancelled", { state: "cancelled", members: MEMBERS });
  assert.deepEqual(await roster.readPlanRosterMembers(dir), []);
});

test("a running plan still counts its members", async () => {
  const dir = seedPlan("t-running", { state: "running", members: MEMBERS });
  const members = await roster.readPlanRosterMembers(dir);
  assert.deepEqual(members.map((m) => m.name), ["alice", "bob"]);
});

test("an approved plan counts even before its state moves (approval is the gate)", async () => {
  // approvedSnapshot 一落盘，lead 随时会开始 spawn；这时把它们排除就是给超卖开门。
  const dir = seedPlan("t-approved", { state: "review_pending", approvedSnapshot: { members: [] }, members: MEMBERS });
  const members = await roster.readPlanRosterMembers(dir);
  assert.deepEqual(members.map((m) => m.name), ["alice", "bob"]);
});

test("a plan without a state field keeps the old counting (never under-count)", async () => {
  const dir = seedPlan("t-legacy", { members: MEMBERS });
  const members = await roster.readPlanRosterMembers(dir);
  assert.equal(members.length, 2, "an unknown/absent state must not silently free the slots");
});

test("an unknown future state also keeps counting", async () => {
  const dir = seedPlan("t-future", { state: "some_new_upstream_state", members: MEMBERS });
  assert.equal((await roster.readPlanRosterMembers(dir)).length, 2);
});
