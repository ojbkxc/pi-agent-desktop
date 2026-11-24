import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 删成员必须把 plan.json 里的同名条目一起摘掉（团队计数审计 P0-1）。
 *
 * 报的现象：面板上删掉成员 → 返回 `removed` → **全局「活跃成员」一点没降**；对 launch
 * 派发出来的成员点删除，还会直接 `成员不在团队名册中`（它只在 plan 里）。
 *
 * 根因：配额口径是 `config ∪ plan`，而删除路径只 splice 了 `config`。plan 里那份永远
 * 留着，于是「删了不降，只能重启腾名额」。
 *
 * `approvedSnapshot.members` 也必须同步摘：漏了它，launch 认领时会把已删成员又派出去。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const planWrite = await jiti.import("./agent-teams-plan-write.ts");

const root = mkdtempSync(join(tmpdir(), "pi-prune-plan-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

let counter = 0;
function seed(plan) {
  const dir = join(root, `team-${++counter}`);
  mkdirSync(dir, { recursive: true });
  if (plan !== undefined) writeFileSync(join(dir, "plan.json"), JSON.stringify(plan), "utf8");
  return dir;
}
const readPlan = (dir) => JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));

test("pruning drops the member and bumps the revision", async () => {
  const dir = seed({
    planId: "p1",
    revision: 4,
    state: "running",
    members: [{ id: "m1", name: "alice" }, { id: "m2", name: "bob" }],
  });
  const result = await planWrite.prunePlanRosterMember("team", "alice", dir);
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  const plan = readPlan(dir);
  assert.deepEqual(plan.members.map((m) => m.name), ["bob"]);
  assert.equal(plan.revision, 5, "a write must bump revision so the UI/пoll notices");
});

test("the approved snapshot is pruned too (otherwise launch would re-spawn the removed member)", async () => {
  const dir = seed({
    planId: "p2",
    revision: 1,
    state: "launching",
    members: [{ id: "m1", name: "alice" }],
    approvedSnapshot: { members: [{ id: "m1", name: "alice" }, { id: "m2", name: "bob" }] },
  });
  const result = await planWrite.prunePlanRosterMember("team", "alice", dir);
  assert.equal(result.removed, true);
  const plan = readPlan(dir);
  assert.deepEqual(plan.members, []);
  assert.deepEqual(plan.approvedSnapshot.members.map((m) => m.name), ["bob"]);
});

test("a name that is not in the plan is a no-op success (nothing to free)", async () => {
  const dir = seed({ planId: "p3", revision: 2, members: [{ id: "m1", name: "alice" }] });
  const result = await planWrite.prunePlanRosterMember("team", "nobody", dir);
  assert.deepEqual(result, { ok: true, removed: false });
  assert.equal(readPlan(dir).revision, 2, "no write, no bump");
});

test("a team with no plan at all is a no-op success", async () => {
  const dir = seed(undefined);
  const result = await planWrite.prunePlanRosterMember("team", "alice", dir);
  assert.deepEqual(result, { ok: true, removed: false });
});

test("a corrupted plan is reported, not silently treated as pruned", async () => {
  const dir = seed(undefined);
  writeFileSync(join(dir, "plan.json"), "{not json", "utf8");
  const result = await planWrite.prunePlanRosterMember("team", "alice", dir);
  assert.equal(result.ok, false, "a broken plan must not look like a successful cleanup");
  assert.ok(result.error && result.error.length > 0);
});
