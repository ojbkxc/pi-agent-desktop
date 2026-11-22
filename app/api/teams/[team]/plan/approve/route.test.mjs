import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * POST /api/teams/[team]/plan/approve —— 批准动作路由（**只投递、不写盘**）。
 *
 * `defaultDeliver` 必须 mock 掉（绝不真投递/复活会话）：用 jiti alias 把
 * `@/lib/agent-teams-unattended-runtime` 换成一个读 `globalThis.__deliverResult` 的桩，
 * 并把调用记进 `globalThis.__deliverCalls`。store / plan 纯模块保持真实。
 */

const DELIVER_STUB = `
export async function defaultDeliver(sessionId, message) {
  globalThis.__deliverCalls = globalThis.__deliverCalls || [];
  globalThis.__deliverCalls.push({ sessionId, message });
  return globalThis.__deliverResult ?? { ok: true };
}
`;

const stubDir = await mkdtemp(join(tmpdir(), "pi-plan-deliver-"));
const stubPath = join(stubDir, "deliver-stub.ts");
await writeFile(stubPath, DELIVER_STUB);
after(() => rm(stubDir, { recursive: true, force: true }));

// 具体 specifier 放在 "@" 之前，避免前缀别名抢先命中。
const jiti = createJiti(import.meta.url, {
  alias: {
    "@/lib/agent-teams-unattended-runtime": stubPath,
    "@": process.cwd(),
  },
  interopDefault: true,
  moduleCache: false,
});
const approveRoute = await jiti.import("./route.ts");
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
  members: [{ id: "m1", name: "impl", agentType: "general-purpose", prompt: "x", runtime: { providerId: "openai", modelId: "gpt-5" } }],
  tasks: [{ id: "t1", subject: "build", ownerId: "m1", dependencies: [] }],
  createdAt: 1,
  updatedAt: 2,
};
const IDENTITY = { planId: "p-1", sessionId: "s-lead", incarnationId: "inc-1", expectedRevision: 3 };

async function setup(t, { plan = BASE_PLAN } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-plan-approve-"));
  const previousDir = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  globalThis.__deliverCalls = [];
  delete globalThis.__deliverResult;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, sanitizeTeamName("demo"));
  await mkdir(dir, { recursive: true });
  if (plan !== null) await writeFile(join(dir, "plan.json"), JSON.stringify(plan));
  return { dir };
}

const approve = (body, team = "demo", headers = { "content-type": "application/json" }) =>
  approveRoute.POST(
    new Request(`http://localhost/api/teams/${team}/plan/approve`, {
      method: "POST",
      // host 必须显式带上：Node 的 new Request() 不补 host，而路由的 host allow-list
      // 在没有 host 时直接 403（真实浏览器请求必带 host）。
      headers: { host: "localhost", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ team }) },
  );

test("403：host 不可信（跨站页面借浏览器发起的批准）不投递", async (t) => {
  await setup(t);
  globalThis.__deliverResult = { ok: true };
  const res = await approve(IDENTITY, "demo", { "content-type": "application/json", host: "evil.example" });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.reason, /Untrusted API request/);
  assert.equal(globalThis.__deliverCalls.length, 0, "门禁挡下就不能投递（这一步会让 lead spawn 整个团队）");
});

test("415：缺 application/json（表单/纯文本的简单请求可以绕过预检）", async (t) => {
  await setup(t);
  globalThis.__deliverResult = { ok: true };
  const res = await approve(IDENTITY, "demo", { "content-type": "text/plain" });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).ok, false);
  assert.equal(globalThis.__deliverCalls.length, 0);
});

test("400：缺任一 identity 字段 / JSON 非法", async (t) => {
  await setup(t);
  assert.equal((await approve({ planId: "p-1" })).status, 400);
  assert.equal((await approve({ ...IDENTITY, expectedRevision: undefined })).status, 400);
  assert.equal((await approve("{ bad json")).status, 400);
});

test("404：无 plan", async (t) => {
  await setup(t, { plan: null });
  const res = await approve(IDENTITY);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).ok, false);
});

test("409：identity 不一致（revision / incarnation / session / planId）→ 刷新提示", async (t) => {
  await setup(t);
  for (const bad of [{ expectedRevision: 99 }, { incarnationId: "x" }, { sessionId: "x" }, { planId: "x" }]) {
    const res = await approve({ ...IDENTITY, ...bad });
    assert.equal(res.status, 409, JSON.stringify(bad));
    assert.match((await res.json()).reason, /plan changed/);
  }
});

test("409：state ≠ review_pending", async (t) => {
  await setup(t, { plan: { ...BASE_PLAN, state: "draft" } });
  const res = await approve(IDENTITY);
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.reason, /not awaiting review/);
});

test("happy：投递成功 → 200 { ok:true, requestId 确定性 }，且投给 lead 会话", async (t) => {
  await setup(t);
  globalThis.__deliverResult = { ok: true };
  const res = await approve(IDENTITY);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.requestId, "desktop-approve-p-1-r3", "requestId = desktopApprovalRequestId(plan) 的确定性值");

  assert.equal(globalThis.__deliverCalls.length, 1, "只投递一次");
  assert.equal(globalThis.__deliverCalls[0].sessionId, "s-lead", "投给计划的 lead 会话");
  const prompt = globalThis.__deliverCalls[0].message;
  assert.match(prompt, /p-1/);
  assert.match(prompt, /desktop-approve-p-1-r3/, "prompt 里钉住同一条确定性 request_id");
  assert.match(prompt, /launch/, "要求 lead 再执行 launch");
  // 「多派成员、多并发」：投递文案必须要求一次把全部成员并行派出、任务按依赖并行推进，
  // 否则 lead 会只派一两个成员然后串行等结果。四件身份信息也必须在文案里。
  assert.match(prompt, /team=demo/, "team 名（否则 lead 对不上团队）");
  assert.match(prompt, /revision=3/);
  assert.match(prompt, /全部 1 个成员/, "要求整批派发全部成员");
  assert.match(prompt, /并行/, "要求任务并行推进");
  assert.match(prompt, /impl/, "列出成员名册，避免派错人");
});

test("400：显式传入的 requestId 必须等于确定性值（随机 id 会跳过上游 revision 校验）", async (t) => {
  await setup(t);
  globalThis.__deliverResult = { ok: true };
  const res = await approve({ ...IDENTITY, requestId: "desktop-approve-p-1-r3-random" });
  assert.equal(res.status, 400, "不一致就拒绝，不能静默换成别的 id 投递");
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.reason, /desktop-approve-p-1-r3/, "告诉调用方唯一合法的值");
  assert.equal(globalThis.__deliverCalls.length, 0);
});

test("显式传入正确的确定性 requestId → 照常批准（向后兼容）", async (t) => {
  await setup(t);
  globalThis.__deliverResult = { ok: true };
  const res = await approve({ ...IDENTITY, requestId: "desktop-approve-p-1-r3" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).requestId, "desktop-approve-p-1-r3");
  assert.equal(globalThis.__deliverCalls.length, 1);
});

test("502：投递失败 → { ok:false, reason }（不静默）", async (t) => {
  await setup(t);
  globalThis.__deliverResult = { ok: false, reason: "lead 会话正在运行，跳过以免打断" };
  const res = await approve(IDENTITY);
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.reason, /正在运行/);
});

/**
 * plan.json 的 sessionId 与 config.json 的 leadSessionId 同源（都读 PI_SESSION_ID，
 * 服务进程从不设置）→ 真实机器上恒为 'unknown-session'。照抄它投递，用户点「批准」
 * 什么都不会发生。这里钉住改投真实 lead。
 */
async function writeTeamWithPlaceholderLead(dir, { withMemberSession }) {
  await writeFile(join(dir, "config.json"), JSON.stringify({
    name: "demo", leadSessionId: "unknown-session",
    members: [{ agentId: "a", name: "team-lead" }, { agentId: "b", name: "impl" }],
  }));
  if (!withMemberSession) return;
  const memberFile = join(dir, "impl-session.jsonl");
  await writeFile(memberFile, `${[
    { type: "session", version: 3, id: "child-impl", timestamp: "2026-11-05T01:00:00.000Z", cwd: "D:/proj" },
    {
      type: "custom", customType: "pi-web:subagent", id: "a1", parentId: null, timestamp: "2026-11-05T01:00:01.000Z",
      data: { version: 1, parentSessionId: "real-lead", parentSessionPath: "/s/real-lead.jsonl", parentToolCallId: "pi-team:impl", profile: "general-purpose", description: "demo/impl", task: "干活", runInBackground: true, createdAt: "2026-11-05T01:00:01.000Z" },
    },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
  await writeFile(join(dir, "lifecycle.json"), JSON.stringify({
    version: 1,
    members: { impl: { name: "impl", status: "parked", sessionId: "child-impl", sessionFile: memberFile, updatedAt: 1 } },
  }));
}

const UNKNOWN_PLAN = { ...BASE_PLAN, sessionId: "unknown-session" };
const UNKNOWN_IDENTITY = { ...IDENTITY, sessionId: "unknown-session" };

test("plan.sessionId 是占位 'unknown-session' → 投给反推出的真实 lead 会话", async (t) => {
  const { dir } = await setup(t, { plan: UNKNOWN_PLAN });
  await writeTeamWithPlaceholderLead(dir, { withMemberSession: true });
  globalThis.__deliverResult = { ok: true };
  const res = await approve(UNKNOWN_IDENTITY);
  assert.equal(res.status, 200);
  assert.equal(globalThis.__deliverCalls.length, 1);
  assert.equal(globalThis.__deliverCalls[0].sessionId, "real-lead", "不能投给占位值");
});

test("反推不出真实 lead → 回落 plan.sessionId（不静默丢批准）", async (t) => {
  const { dir } = await setup(t, { plan: UNKNOWN_PLAN });
  await writeTeamWithPlaceholderLead(dir, { withMemberSession: false });
  globalThis.__deliverResult = { ok: true };
  const res = await approve(UNKNOWN_IDENTITY);
  assert.equal(res.status, 200);
  assert.equal(globalThis.__deliverCalls[0].sessionId, "unknown-session");
});
