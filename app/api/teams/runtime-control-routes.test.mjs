import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 运行时控件路由（GET 视图 + POST 校验层）。
 *
 * 只测路由壳：404 / 200 视图 / body 校验 400。pause/resume 的 release/ensureLive 走真实
 * pi-team registry（进程内有副作用），编排语义已在 lib/agent-teams-runtime-control.test.mjs
 * 全量覆盖，这里不重复（与 lifecycle 路由不测编排同一口径）。
 */
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const controlRoute = await jiti.import("./[team]/runtime-control/route.ts");
const memberRoute = await jiti.import("./[team]/runtime-control/member/route.ts");
const { sanitizeTeamName } = await jiti.import("../../../../lib/agent-teams-swimlane-store.ts");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-control-route-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, sanitizeTeamName("demo"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({
    name: "demo",
    createdAt: 1,
    leadAgentId: "team-lead",
    leadSessionId: "unknown-session",
    members: [
      { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
      { agentId: "m-impl", name: "impl", sessionId: "sess-impl", joinedAt: 1, cwd: "D:/p" },
    ],
  }));
  await writeFile(join(dir, "plan.json"), JSON.stringify({
    planId: "plan-1",
    incarnationId: "inc-1",
    members: [{ id: "p-impl", name: "impl" }],
  }));
  return { root, dir };
}

const params = (team) => ({ params: Promise.resolve({ team }) });

test("GET：团队不存在 ⇒ 404；存在 ⇒ 视图（running、成员合并、incarnationId）", async (t) => {
  await setup(t);
  const missing = await controlRoute.GET(new Request("http://x/api/teams/nope/runtime-control"), params("nope"));
  assert.equal(missing.status, 404);

  const response = await controlRoute.GET(new Request("http://x/api/teams/demo/runtime-control"), params("demo"));
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.status, "running");
  assert.equal(view.teamName, "demo");
  assert.equal(view.incarnationId, "inc-1");
  assert.deepEqual(view.members.map((m) => m.name), ["team-lead", "impl"]);
  assert.equal(view.resumeEligibleCount, 0);
});

test("POST：action 非法 / 身份缺失 ⇒ 400", async (t) => {
  await setup(t);
  const json = (body) => new Request("http://x/api/teams/demo/runtime-control", {
    method: "POST",
    headers: { "content-type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });

  const badAction = await controlRoute.POST(json({ action: "restart", leadSessionId: "s", incarnationId: "i" }), params("demo"));
  assert.equal(badAction.status, 400);
  assert.match(await badAction.json().then((d) => d.error), /pause 或 resume/);

  const badBody = await controlRoute.POST(json({ action: "pause" }), params("demo"));
  assert.equal(badBody.status, 400);
  assert.match(await badBody.json().then((d) => d.error), /leadSessionId/);

  const badJson = await controlRoute.POST(new Request("http://x", { method: "POST", body: "{", headers: { "content-type": "application/json", Host: "localhost" } }), params("demo"));
  assert.equal(badJson.status, 400);
});

test("member 路由：必填缺失 ⇒ 400（不触发生命周期）", async (t) => {
  await setup(t);
  const response = await memberRoute.POST(
    new Request("http://x/api/teams/demo/runtime-control/member", {
      method: "POST",
      headers: { "content-type": "application/json", Host: "localhost" },
      body: JSON.stringify({ agentId: "m-impl" }),
    }),
    params("demo"),
  );
  assert.equal(response.status, 400);
  assert.match(await response.json().then((d) => d.error), /必填/);
});
