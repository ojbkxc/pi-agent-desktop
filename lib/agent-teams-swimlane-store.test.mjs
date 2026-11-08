import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { applyTeamMemberModelChanges, sanitizeTeamName } = await jiti.import(
  "@/lib/agent-teams-swimlane-store.ts",
);

// ── fixture ────────────────────────────────────────────────────────────────────

const BASE_CONFIG = {
  name: "demo",
  createdAt: 1,
  members: [
    { agentId: "m-a", name: "a", joinedAt: 1, cwd: "D:/proj" },
    { agentId: "m-b", name: "b", joinedAt: 1, cwd: "D:/proj" },
  ],
};

const BASE_LIFECYCLE = {
  version: 1,
  members: {
    a: { name: "a", status: "running", sessionId: "s-a", updatedAt: 1 },
  },
};

const PLAN_ONLY = {
  createdAt: 111,
  members: [{ id: "p-c", name: "c", agentType: "general-purpose", runtime: { modelId: "plan-old" } }],
  tasks: [],
};

/** 建一个临时团队根目录并切到它（PI_TEAM_DIR）；返回 { dir, configPath }。 */
async function setupTeam(t, { config = BASE_CONFIG, lifecycle = null, plan = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-team-store-"));
  const previousDir = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });

  const dir = join(root, sanitizeTeamName("demo"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config));
  if (lifecycle) await writeFile(join(dir, "lifecycle.json"), JSON.stringify(lifecycle));
  if (plan) await writeFile(join(dir, "plan.json"), JSON.stringify(plan));
  return { dir, configPath: join(dir, "config.json") };
}

const memberOf = (config, id) => config.members.find((member) => member.agentId === id);

// ── tests ──────────────────────────────────────────────────────────────────────

test("并发两次改不同成员：两个改动都落盘（队列内写前重读合并，后写不覆盖先写）", async (t) => {
  const { configPath } = await setupTeam(t);
  const deliver = async () => ({ kind: "applied" });

  await Promise.all([
    applyTeamMemberModelChanges({
      teamName: "demo",
      updates: [{ memberId: "m-a", provider: "p1", modelId: "model-a" }],
      deliver,
    }),
    applyTeamMemberModelChanges({
      teamName: "demo",
      updates: [{ memberId: "m-b", provider: "p2", modelId: "model-b" }],
      deliver,
    }),
  ]);

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(memberOf(config, "m-a").model, "model-a", "先完成者的改动没有被后写者的旧快照覆盖");
  assert.equal(memberOf(config, "m-a").providerId, "p1");
  assert.equal(memberOf(config, "m-b").model, "model-b", "后完成者的改动也落盘");
  assert.equal(memberOf(config, "m-b").providerId, "p2");
});

test("高并发同写一个团队：config.json 始终可解析、不留下临时文件", async (t) => {
  const { dir, configPath } = await setupTeam(t);
  const deliver = async () => ({ kind: "applied" });

  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    applyTeamMemberModelChanges({
      teamName: "demo",
      updates: [{ memberId: "m-a", provider: `p${index}`, modelId: `model-${index}` }],
      deliver,
    })));

  const files = await readdir(dir);
  assert.deepEqual(
    files.filter((name) => name.endsWith(".tmp")),
    [],
    "每次写回的随机临时文件都被 rename 或清掉",
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const final = memberOf(config, "m-a");
  assert.match(final.model, /^model-\d$/, "串行落盘后最终值是某一次完整写入，不是撕裂内容");
  assert.match(final.providerId, /^p\d$/);
});

test("投递抛错的成员不进落盘意图，同批其他成员照写", async (t) => {
  const { configPath } = await setupTeam(t, { lifecycle: BASE_LIFECYCLE });
  const deliver = async (sessionId) => {
    if (sessionId === "s-a") throw new Error("Model not found");
    return { kind: "applied" };
  };

  const outcome = await applyTeamMemberModelChanges({
    teamName: "demo",
    updates: [
      { memberId: "m-a", provider: "p", modelId: "nope" },
      { memberId: "m-b", provider: "p", modelId: "model-b" },
    ],
    deliver,
  });

  assert.deepEqual(outcome.results.map((result) => result.status), ["failed", "saved"]);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(memberOf(config, "m-a").model, undefined, "失败的成员不改盘");
  assert.equal(memberOf(config, "m-b").model, "model-b", "无会话成员照写（saved）");
});

test("plan 独有成员在队列合并阶段追加名册（幂等、不写 sessionId）", async (t) => {
  const { configPath } = await setupTeam(t, { plan: PLAN_ONLY });
  // p-c 没有会话条目：deliver 不应被调用，被调用即抛错并暴露为 failed。
  const deliver = async () => {
    throw new Error("不应投递");
  };

  await applyTeamMemberModelChanges({
    teamName: "demo",
    updates: [{ memberId: "p-c", provider: "ty", modelId: "m1" }],
    deliver,
  });
  await applyTeamMemberModelChanges({
    teamName: "demo",
    updates: [{ memberId: "p-c", provider: "ty", modelId: "m2" }],
    deliver,
  });

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const carols = config.members.filter((member) => member.agentId === "p-c");
  assert.equal(carols.length, 1, "不重复追加");
  assert.equal(carols[0].model, "m2");
  assert.equal(carols[0].providerId, "ty");
  assert.equal(carols[0].sessionId, undefined, "追加条目刻意不写 sessionId");
  assert.equal(carols[0].agentType, "general-purpose", "角色保持 plan 口径");
});
