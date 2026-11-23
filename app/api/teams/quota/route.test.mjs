import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * GET/PUT /api/teams/quota —— 团队并发上限的设置面。
 *
 * 隔离：`PI_CODING_AGENT_DIR` 指向临时目录 ⇒ 设置文件（pi-web/settings.json）落在临时目录，
 * 绝不碰本机真实设置；`PI_TEAM_DIR` 同理隔离团队名册。
 */
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-team-quota-route-"));
  const agentDir = join(root, "agent");
  const previous = {
    teamDir: process.env.PI_TEAM_DIR,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    perTeam: process.env.PI_TEAM_MAX_MEMBERS,
    global: process.env.PI_TEAM_MAX_GLOBAL_WORKERS,
  };
  process.env.PI_TEAM_DIR = join(root, "teams");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_TEAM_MAX_MEMBERS;
  delete process.env.PI_TEAM_MAX_GLOBAL_WORKERS;
  t.after(async () => {
    for (const [key, envName] of [
      ["teamDir", "PI_TEAM_DIR"],
      ["agentDir", "PI_CODING_AGENT_DIR"],
      ["perTeam", "PI_TEAM_MAX_MEMBERS"],
      ["global", "PI_TEAM_MAX_GLOBAL_WORKERS"],
    ]) {
      if (previous[key] === undefined) delete process.env[envName];
      else process.env[envName] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(process.env.PI_TEAM_DIR, { recursive: true });
  return { settingsPath: join(agentDir, "pi-web", "settings.json") };
}

function put(body) {
  return route.PUT(new Request("http://localhost/api/teams/quota", {
    method: "PUT",
    headers: { "content-type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  }));
}

test("GET：默认 16/64、来源 default、区间与并发度一并回报", async (t) => {
  await setup(t);
  const res = await route.GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.quota, { perTeamLimit: 16, globalLimit: 64 });
  assert.deepEqual(body.sources, { perTeamLimit: "default", globalLimit: "default" });
  assert.deepEqual(body.defaults, { perTeamLimit: 16, globalLimit: 64 });
  assert.equal(body.ranges.perTeamLimit.max, 128);
  assert.equal(body.spawnConcurrency, 4);
  assert.equal(body.globalWorkers, 0, "空名册 ⇒ 已用 0");
  assert.match(body.sourceHints.perTeamLimit, /默认值/);
});

test("GET：已用数字来自真实名册（lead 不计）", async (t) => {
  await setup(t);
  const teamDir = join(process.env.PI_TEAM_DIR, "team-a");
  await mkdir(teamDir, { recursive: true });
  await writeFile(join(teamDir, "config.json"), JSON.stringify({
    name: "team-a",
    createdAt: 1,
    leadAgentId: "lead-1",
    members: [
      { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
      { agentId: "w-1", name: "a", joinedAt: 1, cwd: "D:/p" },
      { agentId: "w-2", name: "b", joinedAt: 1, cwd: "D:/p" },
    ],
  }));
  const body = await (await route.GET()).json();
  assert.equal(body.globalWorkers, 2);
});

test("PUT：写设置项并立即生效（不必重启），来源变 settings", async (t) => {
  const { settingsPath } = await setup(t);
  const res = await put({ perTeamLimit: 24, globalLimit: 96 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.quota, { perTeamLimit: 24, globalLimit: 96 });
  assert.deepEqual(body.sources, { perTeamLimit: "settings", globalLimit: "settings" });
  assert.deepEqual(body.saved, { perTeamLimit: 24, globalLimit: 96 });
  assert.equal(body.warning, undefined);

  const stored = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(stored.teamQuota, { perTeamLimit: 24, globalLimit: 96 }, "落在 pi-web/settings.json 的 teamQuota 段");
  assert.equal(stored.version, 1, "与其它设置段同文件同版本号");

  // 只改一个字段：另一个保留。
  const again = await (await put({ globalLimit: 128 })).json();
  assert.deepEqual(again.quota, { perTeamLimit: 24, globalLimit: 128 });
});

test("PUT：越界/非整数/空 body ⇒ 400 且不落盘", async (t) => {
  const { settingsPath } = await setup(t);
  assert.equal((await put({ perTeamLimit: 0 })).status, 400);
  assert.equal((await put({ perTeamLimit: 1.5 })).status, 400);
  assert.equal((await put({ globalLimit: 9999 })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ perTeamLimit: "24" })).status, 400);
  const bad = route.PUT(new Request("http://localhost/api/teams/quota", { method: "PUT", headers: { "content-type": "application/json", Host: "localhost" }, body: "not json" }));
  assert.equal((await bad).status, 400);
  await assert.rejects(readFile(settingsPath, "utf8"), /ENOENT/, "被拒的请求不写文件");
});

test("PUT：被 env 顶掉时如实 warning（saved 是落盘值，quota 是生效值）", async (t) => {
  const { settingsPath } = await setup(t);
  process.env.PI_TEAM_MAX_MEMBERS = "8";
  const res = await put({ perTeamLimit: 24 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.quota.perTeamLimit, 8, "生效值仍是 env 的 8");
  assert.equal(body.sources.perTeamLimit, "env");
  assert.equal(body.saved.perTeamLimit, 24, "落盘值如实回报");
  assert.match(body.warning ?? "", /PI_TEAM_MAX_MEMBERS/, "要说清被哪个环境变量覆盖");
  const stored = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(stored.teamQuota.perTeamLimit, 24);
});
