import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * GET /api/teams/[team]/plan —— 只读计划读取路由。
 *
 * 直接 import route handler 调用（照 app/api 下既有 route.test.mjs 先例），传
 * `{ params: Promise.resolve({ team }) }`。读盘用临时 PI_TEAM_DIR 隔离。
 * 「store 抛错 → 500」用 jiti alias 把 store 换成一个会抛的桩，制造路由 catch 分支。
 * approve 路由的测试在 ./approve/route.test.mjs。
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");
const { readTeamPlanView } = await jiti.import("@/lib/agent-teams-plan-store.ts");
const { sanitizeTeamName } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");

const BASE_PLAN = {
  schemaVersion: 1,
  planId: "p-1",
  sessionId: "s-lead",
  teamName: "demo",
  incarnationId: "inc-1",
  revision: 3,
  state: "review_pending",
  workDir: "D:/proj",
  leaderRuntime: { providerId: "openai", modelId: "gpt-5" },
  members: [
    { id: "m1", name: "impl", agentType: "general-purpose", prompt: "build it", runtime: { providerId: "openai", modelId: "gpt-5" } },
  ],
  tasks: [{ id: "t1", subject: "build", ownerId: "m1", dependencies: [] }],
  createdAt: 1,
  updatedAt: 2,
};

/** 建临时团队目录并切到它；plan 传 null 表示不写 plan.json。 */
async function setup(t, { plan = BASE_PLAN } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-plan-get-"));
  const previousDir = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, sanitizeTeamName("demo"));
  await mkdir(dir, { recursive: true });
  if (plan !== null) {
    await writeFile(join(dir, "plan.json"), typeof plan === "string" ? plan : JSON.stringify(plan));
  }
  return { dir };
}

const get = (team = "demo") =>
  route.GET(new Request(`http://localhost/api/teams/${team}/plan`), { params: Promise.resolve({ team }) });

test("有 plan → 200 { plan }（只读投影）", async (t) => {
  await setup(t);
  const res = await get();
  assert.equal(res.status, 200);
  const { plan } = await res.json();
  assert.equal(plan.planId, "p-1");
  assert.equal(plan.state, "review_pending");
  assert.equal(plan.revision, 3);
  assert.equal(plan.teamName, "demo");
  assert.equal(plan.sessionId, "s-lead");
  assert.equal(plan.incarnationId, "inc-1");
  assert.equal(plan.members.length, 1);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.members[0].runtime.modelId, "gpt-5");
});

test("无 plan.json（团队无计划 / 目录不存在）→ 200 { plan: null }", async (t) => {
  await setup(t, { plan: null });
  assert.equal((await (await get()).json()).plan, null);
  assert.equal((await (await get("ghost-team")).json()).plan, null);
});

test("解析失败 / state 未知 → { plan: null }（不 500）", async (t) => {
  await setup(t, { plan: "{ not json" });
  assert.equal((await (await get()).json()).plan, null);
  await setup(t, { plan: { ...BASE_PLAN, state: "weird_state" } });
  assert.equal((await (await get()).json()).plan, null, "未知 state 当作没有计划");
});

test("store 抛错 → 500 { plan: null, error }", async (t) => {
  const stubDir = await mkdtemp(join(tmpdir(), "pi-teams-plan-stub-"));
  const stubPath = join(stubDir, "throwing-store.ts");
  await writeFile(stubPath, `export async function readTeamPlanView() { throw new Error("boom"); }`);
  t.after(() => rm(stubDir, { recursive: true, force: true }));

  // 只把 store 这一条 specifier 换掉；`@` 映射到仓库根，让路由里其它 `@/lib/*` 正常解析。
  const stubJiti = createJiti(import.meta.url, {
    alias: { "@/lib/agent-teams-plan-store": stubPath, "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  });
  const throwingRoute = await stubJiti.import("./route.ts");

  const res = await throwingRoute.GET(
    new Request("http://localhost/api/teams/demo/plan"),
    { params: Promise.resolve({ team: "demo" }) },
  );
  assert.equal(res.status, 500);
  const data = await res.json();
  assert.equal(data.plan, null);
  assert.match(data.error, /boom/);
});

test("readTeamPlanView 直接调用：损坏 JSON / state 未知 → null", async (t) => {
  await setup(t, { plan: "{ not json" });
  assert.equal(await readTeamPlanView("demo"), null);
  await setup(t, { plan: { ...BASE_PLAN, state: "weird_state" } });
  assert.equal(await readTeamPlanView("demo"), null);
});

// ── PATCH（计划编辑保存）──────────────────────────────────────────────────────
// 写路径的字段语义与并发语义在 lib/agent-teams-plan-write.test.mjs 钉死；这里只验
// **HTTP 层**：三重门、请求体解析、错误码透传，以及保存后状态不变。
//
// 注意：Node 的 `new Request()` 不会自动补 `host` 头，而三重门里的 host allow-list
// 在没有 host 时直接 403。真实浏览器请求必带 host，所以测试也显式带上。

const LOOPBACK_HOST = "localhost";

const patch = (body, team = "demo", headers = { "content-type": "application/json" }) =>
  route.PATCH(
    new Request(`http://${LOOPBACK_HOST}/api/teams/${team}/plan`, {
      method: "PATCH",
      headers: { host: LOOPBACK_HOST, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ team }) },
  );

const EDIT_IDENTITY = { planId: "p-1", sessionId: "s-lead", incarnationId: "inc-1", expectedRevision: 3 };

test("PATCH happy：改模型 → 200 { plan }，revision+1、状态保持、其余字段保留", async (t) => {
  await setup(t);
  const res = await patch({
    ...EDIT_IDENTITY,
    members: [{ id: "m1", runtime: { providerId: "anthropic", modelId: "claude-sonnet" } }],
  });
  assert.equal(res.status, 200);
  const { plan } = await res.json();
  assert.equal(plan.revision, 4, "保存后 revision +1");
  assert.equal(plan.state, "review_pending", "保存不打回草稿");
  assert.equal(plan.members[0].runtime.providerId, "anthropic");
  assert.equal(plan.members[0].runtime.modelId, "claude-sonnet");
  assert.equal(plan.members[0].agentType, "general-purpose", "未提到的字段保留");
  assert.equal(plan.members[0].prompt, "build it");
});

test("PATCH 409：revision 过期 / 状态不可编辑 → 透传错误码", async (t) => {
  await setup(t);
  assert.equal((await patch({ ...EDIT_IDENTITY, expectedRevision: 1 })).status, 409);

  await setup(t, { plan: { ...BASE_PLAN, state: "running" } });
  assert.equal(
    ( await patch({ ...EDIT_IDENTITY, members: [{ id: "m1", agentType: "explore" }] }) ).status,
    409,
  );
});

test("PATCH 400：身份字段缺失 / JSON 非法 / 模型缺 modelId / 未知 owner", async (t) => {
  await setup(t);
  assert.equal((await patch({ planId: "p-1" })).status, 400);
  assert.equal((await patch("{ bad json")).status, 400);
  assert.equal(
    (await patch({ ...EDIT_IDENTITY, members: [{ id: "m1", runtime: { providerId: "x" } }] })).status,
    400,
    "只给 provider 不给 modelId",
  );
  assert.equal(
    (await patch({ ...EDIT_IDENTITY, tasks: [{ id: "t1", ownerId: "ghost" }] })).status,
    400,
    "未知 owner 不落盘",
  );
});

test("PATCH 415：缺 JSON Content-Type", async (t) => {
  await setup(t);
  assert.equal((await patch({ ...EDIT_IDENTITY }, "demo", { "content-type": "text/plain" })).status, 415);
});
