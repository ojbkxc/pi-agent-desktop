import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");
const { sanitizeTeamName, readTeamWorkbench } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");

// ── fixture ────────────────────────────────────────────────────────────────────

const BASE_CONFIG = {
  name: "demo",
  description: "示例团队",
  createdAt: 1,
  leadAgentId: "team-lead",
  leadSessionId: "lead-session",
  // 顶层无关字段必须原样保留
  schemaVersion: 1,
  extra: { keep: true },
  members: [
    { agentId: "m-impl", name: "impl", joinedAt: 1, cwd: "D:/proj", model: "old-model", providerId: "old-provider", note: "keep-me" },
    { agentId: "m-qa", name: "qa", joinedAt: 1, cwd: "D:/proj" },
    { agentId: "m-idle", name: "idle", joinedAt: 1, cwd: "D:/proj" },
  ],
};

const BASE_LIFECYCLE = {
  version: 1,
  members: {
    impl: { name: "impl", status: "running", sessionId: "s-impl", updatedAt: 1 },
    qa: { name: "qa", status: "parked", sessionId: "s-qa", updatedAt: 1 },
    // idle 成员没有任何会话条目
  },
};

/** 建一个临时团队目录并切到它；返回 { dir, configPath }。调用方负责 after 清理。 */
async function setup(t, { config = BASE_CONFIG, lifecycle = BASE_LIFECYCLE, plan = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-members-"));
  const previousDir = process.env.PI_TEAM_DIR;
  const previousSessions = globalThis.__piSessions;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previousDir;
    if (previousSessions === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = previousSessions;
    await rm(root, { recursive: true, force: true });
  });

  const dir = join(root, sanitizeTeamName("demo"));
  await mkdir(join(dir, "inboxes"), { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config));
  if (lifecycle) await writeFile(join(dir, "lifecycle.json"), JSON.stringify(lifecycle));
  if (plan) await writeFile(join(dir, "plan.json"), JSON.stringify(plan));
  return { dir, configPath: join(dir, "config.json") };
}

function patch(body, team = "demo") {
  return route.PATCH(
    new Request(`http://localhost/api/teams/${team}/members`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ team }) },
  );
}

/** 装一个假会话注册表：列出哪些 sessionId 存活、send 行为。返回发送记录。 */
function fakeRegistry(sessions) {
  const sent = [];
  const map = new Map();
  for (const [id, spec] of Object.entries(sessions)) {
    map.set(id, {
      isAlive: () => spec.alive !== false,
      send: async (command) => {
        if (spec.throw) throw new Error(spec.throw);
        sent.push({ sessionId: id, command });
        return { ok: true };
      },
    });
  }
  globalThis.__piSessions = map;
  return sent;
}

const readConfig = async (path) => JSON.parse(await readFile(path, "utf8"));
const memberOf = (config, id) => config.members.find((member) => member.agentId === id);

// ── tests ──────────────────────────────────────────────────────────────────────

test("单个改且会话存活：投递 set_model、标记 applied、写盘并保留其余字段", async (t) => {
  const { configPath } = await setup(t);
  const sent = fakeRegistry({ "s-impl": {} });

  const res = await patch({ memberId: "m-impl", provider: "ty", modelId: "claude-opus-4-1" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 1);
  assert.deepEqual(
    { memberId: body.results[0].memberId, name: body.results[0].name, status: body.results[0].status },
    { memberId: "m-impl", name: "impl", status: "applied" },
  );
  assert.deepEqual(body.summary, { applied: 1, saved: 0, failed: 0 });

  assert.deepEqual(sent, [{ sessionId: "s-impl", command: { type: "set_model", provider: "ty", modelId: "claude-opus-4-1" } }]);

  const config = await readConfig(configPath);
  const impl = memberOf(config, "m-impl");
  assert.equal(impl.model, "claude-opus-4-1");
  assert.equal(impl.providerId, "ty");
  assert.equal(impl.note, "keep-me", "成员其余字段保留");
  assert.equal(config.schemaVersion, 1, "顶层无关字段保留");
  assert.deepEqual(config.extra, { keep: true });
  assert.equal(memberOf(config, "m-qa").model, undefined, "未涉及的成员不变");
});

test("批量：存活→applied、parked→saved（不发命令）、不存在→failed", async (t) => {
  const { configPath } = await setup(t);
  const sent = fakeRegistry({ "s-impl": {}, "s-qa": {} }); // s-qa 即使“存活”，parked 也不该被发命令

  const res = await patch({ memberIds: ["m-impl", "m-qa", "ghost"], provider: "ty", modelId: "m2" });
  assert.equal(res.status, 200);
  const body = await res.json();
  const byId = Object.fromEntries(body.results.map((result) => [result.memberId, result]));
  assert.equal(byId["m-impl"].status, "applied");
  assert.equal(byId["m-qa"].status, "saved");
  assert.equal(byId["ghost"].status, "failed");
  assert.match(byId["ghost"].reason, /成员不存在/);
  assert.deepEqual(body.summary, { applied: 1, saved: 1, failed: 1 });

  assert.deepEqual(sent.map((item) => item.sessionId), ["s-impl"], "parked 成员绝不发命令");
  const config = await readConfig(configPath);
  assert.equal(memberOf(config, "m-qa").model, "m2", "parked 成员仍写盘，待复活");
  assert.equal(memberOf(config, "m-idle").model, undefined, "未请求的成员不变");
});

test("会话已死 / 未派发：只写盘，如实标成 saved（不谎报已生效）", async (t) => {
  const { configPath } = await setup(t);
  const sent = fakeRegistry({ "s-impl": { alive: false } });

  const res = await patch({ memberIds: ["m-impl", "m-idle"], provider: "ty", modelId: "m3" });
  const body = await res.json();
  assert.deepEqual(body.results.map((result) => result.status), ["saved", "saved"]);
  assert.deepEqual(sent, [], "没有存活会话就不发命令");
  const config = await readConfig(configPath);
  assert.equal(memberOf(config, "m-impl").model, "m3");
  assert.equal(memberOf(config, "m-idle").model, "m3", "无 sessionId 的成员也写盘");
});

test("模型不存在：透传 rpc 错误、标 failed、且不写盘", async (t) => {
  const { configPath } = await setup(t);
  fakeRegistry({ "s-impl": { throw: "Model not found: ty/nope" } });

  const res = await patch({ memberId: "m-impl", provider: "ty", modelId: "nope" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].status, "failed");
  assert.equal(body.results[0].reason, "Model not found: ty/nope", "错误原样透传");
  assert.equal(body.summary.failed, 1);

  const config = await readConfig(configPath);
  assert.equal(memberOf(config, "m-impl").model, "old-model", "失败不写盘，保持与运行态一致");
});

test("团队不存在 → 404，且不动任何文件", async (t) => {
  await setup(t);
  const res = await patch({ memberId: "m-impl", provider: "ty", modelId: "m4" }, "ghost-team");
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /团队不存在/);
});

test("请求体非法 → 400（缺 memberId、缺 provider/modelId、空数组）", async (t) => {
  await setup(t);
  assert.equal((await patch({ provider: "ty", modelId: "m" })).status, 400);
  assert.equal((await patch({ memberId: "m-impl", modelId: "m" })).status, 400);
  assert.equal((await patch({ memberIds: [], provider: "ty", modelId: "m" })).status, 400);
  assert.equal((await patch({ memberIds: [1, 2], provider: "ty", modelId: "m" })).status, 400);

  const bad = route.PATCH(
    new Request("http://localhost/api/teams/demo/members", { method: "PATCH", body: "not json" }),
    { params: Promise.resolve({ team: "demo" }) },
  );
  assert.equal((await bad).status, 400);
});

test("重复 memberId 去重，同一会话只投递一次", async (t) => {
  const { configPath } = await setup(t);
  const sent = fakeRegistry({ "s-impl": {} });

  const res = await patch({ memberIds: ["m-impl", "m-impl"], provider: "ty", modelId: "m5" });
  const body = await res.json();
  assert.equal(body.results.length, 1, "去重后只处理一次");
  assert.deepEqual(sent.map((item) => item.sessionId), ["s-impl"]);
  assert.equal(memberOf(await readConfig(configPath), "m-impl").model, "m5");
});

// ── 名册口径统一：plan 独有成员（#19 B）────────────────────────────────────────

const PLAN_ONLY = {
  createdAt: 111,
  members: [{ id: "p-carol", name: "carol", runtime: { modelId: "plan-old" } }],
  tasks: [],
};
const LIFECYCLE_WITH_CAROL = {
  version: 1,
  members: {
    impl: { name: "impl", status: "running", sessionId: "s-impl", updatedAt: 1 },
    qa: { name: "qa", status: "parked", sessionId: "s-qa", updatedAt: 1 },
    carol: { name: "carol", status: "running", sessionId: "s-carol", updatedAt: 1 },
  },
};

test("plan 独有成员：追加 config 名册、投影能读到新模型、幂等", async (t) => {
  const { configPath } = await setup(t, { plan: PLAN_ONLY });
  fakeRegistry({}); // 无存活会话 → saved

  const res = await patch({ memberId: "p-carol", provider: "ty", modelId: "claude-opus-4-1" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].status, "saved");
  assert.equal(body.results[0].name, "carol");

  const config = await readConfig(configPath);
  const carol = memberOf(config, "p-carol");
  assert.ok(carol, "plan 独有成员被追加进 config 名册");
  assert.equal(carol.name, "carol");
  assert.equal(carol.model, "claude-opus-4-1");
  assert.equal(carol.providerId, "ty");
  assert.equal(carol.sessionId, undefined, "刻意不写 sessionId（避免遮蔽 lifecycle 里后续换新的会话）");
  assert.equal(memberOf(config, "m-impl").note, "keep-me", "原有成员不受影响");

  // 投影能读到新模型 —— 即「改完确实在界面上可见」，不制造 H3 式假象
  const snapshot = await readTeamWorkbench("demo");
  const carolView = snapshot.members.find((member) => member.name === "carol");
  assert.ok(carolView, "投影名册出现 carol");
  assert.equal(carolView.model, "claude-opus-4-1", "config.member.model 优先于 plan.runtime.modelId");

  // 幂等：改第二次不再追加，只更新
  await patch({ memberId: "p-carol", provider: "ty", modelId: "m2" });
  const again = await readConfig(configPath);
  assert.equal(again.members.filter((member) => member.agentId === "p-carol").length, 1, "不重复追加");
  assert.equal(memberOf(again, "p-carol").model, "m2");
});

test("plan 独有成员但会话存活：投递 set_model、标 applied", async (t) => {
  const { configPath } = await setup(t, { plan: PLAN_ONLY, lifecycle: LIFECYCLE_WITH_CAROL });
  const sent = fakeRegistry({ "s-carol": {} });

  const res = await patch({ memberId: "p-carol", provider: "ty", modelId: "m-applied" });
  const body = await res.json();
  assert.equal(body.results[0].status, "applied");
  assert.deepEqual(sent, [{ sessionId: "s-carol", command: { type: "set_model", provider: "ty", modelId: "m-applied" } }]);
  assert.equal(memberOf(await readConfig(configPath), "p-carol").model, "m-applied");
});

test("plan 独有成员投递失败：failed 且不追加名册", async (t) => {
  const { configPath } = await setup(t, { plan: PLAN_ONLY, lifecycle: LIFECYCLE_WITH_CAROL });
  fakeRegistry({ "s-carol": { throw: "Model not found: ty/nope" } });

  const res = await patch({ memberId: "p-carol", provider: "ty", modelId: "nope" });
  const body = await res.json();
  assert.equal(body.results[0].status, "failed");
  assert.equal(body.results[0].reason, "Model not found: ty/nope");
  assert.equal(memberOf(await readConfig(configPath), "p-carol"), undefined, "失败不落名册");
});
