import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const listRoute = await jiti.import("./route.ts");
const teamRoute = await jiti.import("./[team]/workbench/route.ts");
const sessionRoute = await jiti.import("./session/[id]/workbench/route.ts");
const latestRoute = await jiti.import("./workbench/route.ts");
const { sanitizeTeamName } = await jiti.import("../../../lib/agent-teams-swimlane-store.ts");

async function writeFixture(root) {
  const dir = join(root, sanitizeTeamName("demo"));
  await mkdir(join(dir, "inboxes"), { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({
    name: "demo",
    description: "泳道图示例",
    createdAt: Date.parse("2026-11-05T00:00:00.000Z"),
    leadAgentId: "team-lead",
    leadSessionId: "lead-session",
    members: [
      { agentId: "lead-1", name: "team-lead", joinedAt: Date.parse("2026-11-05T00:00:00.000Z"), cwd: "D:/proj" },
      { agentId: "m-impl", name: "impl", joinedAt: Date.parse("2026-11-05T00:00:00.000Z"), cwd: "D:/proj" },
    ],
  }));
  await writeFile(join(dir, "plan.json"), JSON.stringify({
    incarnationId: "inc-1",
    state: "running",
    createdAt: Date.parse("2026-11-05T00:30:00.000Z"),
    members: [{ id: "p-impl", name: "impl", runtime: { modelId: "claude-sonnet-4-6" } }],
    tasks: [{ id: "t1", subject: "实现 X", ownerId: "p-impl", dependencies: [] }],
  }));
  await writeFile(join(dir, "lifecycle.json"), JSON.stringify({
    version: 1,
    members: { impl: { name: "impl", status: "running", sessionId: "s-impl", updatedAt: Date.parse("2026-11-05T01:30:00.000Z") } },
  }));
}

test("GET /api/teams returns the roster", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-api-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  await writeFixture(root);
  const response = await listRoute.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.teams.map((team) => team.name), ["demo"]);
  assert.equal(body.teams[0].memberCount, 2);
  // memberSessionIds：名册无 sessionId，lifecycle 的 s-impl 必须出现
  assert.ok(Array.isArray(body.teams[0].memberSessionIds), "GET /api/teams 返回 memberSessionIds 数组");
  assert.deepEqual(body.teams[0].memberSessionIds, ["s-impl"]);
});

test("GET /api/teams/[team]/workbench returns a lane snapshot lane-diagram can read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-api-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  await writeFixture(root);
  const response = await teamRoute.GET(new Request("http://localhost/api/teams/demo/workbench"), { params: Promise.resolve({ team: "demo" }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.team.name, "demo");
  assert.deepEqual(body.lanes.map((lane) => lane.name), ["team-lead", "impl"]);
  // lane-diagram.html 读的兼容字段
  assert.equal(body.tasks[0].subject, "实现 X");
  assert.equal(body.tasks[0].owner, "impl");

  const missing = await teamRoute.GET(new Request("http://localhost/api/teams/ghost/workbench"), { params: Promise.resolve({ team: "ghost" }) });
  assert.equal(missing.status, 404);
});

test("GET /api/teams/workbench (no session param) serves the newest team for lane-diagram", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-api-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  // public/lane-diagram.html 无 ?session= 时回退到这个聚合入口。
  const empty = await latestRoute.GET();
  assert.equal(empty.status, 404);

  await writeFixture(root);
  // 再放一个更晚创建的团队：聚合入口必须挑它，而不是目录里的第一个。
  const older = join(root, sanitizeTeamName("demo"));
  const newer = join(root, sanitizeTeamName("demo2"));
  await mkdir(newer, { recursive: true });
  await writeFile(join(newer, "config.json"), JSON.stringify({
    name: "demo2",
    createdAt: Date.parse("2026-11-06T00:00:00.000Z"),
    leadAgentId: "team-lead",
    members: [{ agentId: "lead-2", name: "team-lead", joinedAt: Date.parse("2026-11-06T00:00:00.000Z"), cwd: "D:/proj" }],
  }));
  assert.ok(older);

  const response = await latestRoute.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.team.name, "demo2");
  assert.ok(Array.isArray(body.tasks), "lane-diagram 读的兼容字段仍在");
});

test("GET /api/teams/session/[id]/workbench resolves the team by lead session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-api-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  await writeFixture(root);
  const ok = await sessionRoute.GET(new Request("http://localhost/api/teams/session/lead-session/workbench"), { params: Promise.resolve({ id: "lead-session" }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).team.id, "demo");

  // 成员会话（lifecycle.json 里的 s-impl）同样能反查到团队
  const member = await sessionRoute.GET(new Request("http://localhost/api/teams/session/s-impl/workbench"), { params: Promise.resolve({ id: "s-impl" }) });
  assert.equal(member.status, 200);
  assert.equal((await member.json()).team.id, "demo");

  const missing = await sessionRoute.GET(new Request("http://localhost/api/teams/session/nope/workbench"), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(missing.status, 404);
});
