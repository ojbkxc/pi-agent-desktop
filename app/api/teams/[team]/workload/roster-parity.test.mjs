import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/teams/[team]/workload` 的 `rosterWorkers` 必须与 `globalWorkers` 同源
 * （团队计数审计 P2-5）。
 *
 * 现象：同一个面板上「本队 4/16、全局 12/64」，而本队 plan 独有的成员在两处一隐一现——
 * 因为 `rosterWorkers` 只数 `config.members`，`globalWorkers` 数的是 `config ∪ plan`。
 * 操作者据此判断「还能再派几个」，判断依据却是错的。
 *
 * 口径：两边都在 `config ∪ plan` 里数、都排 lead（plan 侧的「未派发不计」由
 * `readPlanRosterMembers` 负责）。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET } = await jiti.import("./route.ts");

const root = mkdtempSync(join(tmpdir(), "pi-workload-roster-"));
process.env.PI_TEAM_DIR = root;
after(() => {
  delete process.env.PI_TEAM_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function seedTeam(dirName) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    name: "demo",
    leadSessionId: "lead-session",
    members: [
      { name: "team-lead", sessionId: "lead-session" },
      { name: "alice", agentId: "a1" },
      { name: "bob", agentId: "b1" },
    ],
  }), "utf8");
  // plan 独有成员（launch 派发出来的）：只在 plan 里。
  writeFileSync(join(dir, "plan.json"), JSON.stringify({
    planId: "p1",
    revision: 1,
    state: "running",
    members: [{ id: "c1", name: "carol" }, { id: "a1", name: "alice" }],
  }), "utf8");
  return dir;
}

test("rosterWorkers counts config ∪ plan (lead excluded), matching the global number's source", async () => {
  seedTeam("demo");
  const response = await GET(
    new Request("http://localhost/api/teams/demo/workload", { headers: { Host: "localhost" } }),
    { params: Promise.resolve({ team: "demo" }) },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  // config: alice, bob（lead 排除）；plan 独有: carol。合计 3。
  assert.equal(body.quota.rosterWorkers, 3, "plan-only members must be visible in the team's own count");
  assert.equal(body.quota.globalWorkers, 3, "…and the global count sees the same roster");
});

test("a draft plan contributes nobody (not dispatched yet)", async () => {
  const dir = seedTeam("draft-team");
  writeFileSync(join(dir, "plan.json"), JSON.stringify({
    planId: "p2", revision: 1, state: "draft", members: [{ id: "z1", name: "zoe" }],
  }), "utf8");
  const response = await GET(
    new Request("http://localhost/api/teams/draft-team/workload", { headers: { Host: "localhost" } }),
    { params: Promise.resolve({ team: "draft-team" }) },
  );
  const body = await response.json();
  assert.equal(body.quota.rosterWorkers, 2, "alice + bob only; the draft plan's zoe does not occupy quota");
});
