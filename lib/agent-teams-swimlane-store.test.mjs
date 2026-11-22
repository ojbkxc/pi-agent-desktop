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
const { applyTeamMemberModelChanges, sanitizeTeamName, readTeamWorkbench } = await jiti.import(
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

test("消息按时间解析排序：不同时区偏移的 ISO 时间戳不会被字符串比较排反", async (t) => {
  const { dir } = await setupTeam(t);
  await mkdir(join(dir, "inboxes"), { recursive: true });
  await writeFile(
    join(dir, "inboxes", "a.json"),
    JSON.stringify([
      // 01:00Z（本地 +08:00 的 09:00）在前，02:00Z 在后。
      { id: "m1", from: "b", text: "early", timestamp: "2026-11-21T09:00:00+08:00" },
      { id: "m2", from: "b", text: "late", timestamp: "2026-11-21T02:00:00Z" },
    ]),
  );

  const snapshot = await readTeamWorkbench("demo");
  assert.ok(snapshot, "团队应可读");
  // 字符串比较会把 `…02:00:00Z` 排在 `…09:00:00+08:00` 之前（错误）；按毫秒解析才是真实先后。
  assert.deepEqual(snapshot.messages.map((message) => message.text), ["early", "late"]);
});

// ── 团队并发上限（teamQuota / env）与名额预留（本轮新增）─────────────────────

const quotaApi = await jiti.import("@/lib/agent-teams-swimlane-store.ts");
const {
  TEAM_QUOTA_DEFAULTS,
  TEAM_QUOTA_RANGES,
  readTeamQuotaLimits,
  readTeamQuotaResolution,
  readTeamQuotaSettings,
  writeTeamQuotaSettings,
  readTeamSpawnConcurrency,
  tryReserveTeamWorkerSlot,
  releaseQuotaSlot,
  quotaInflightCount,
  readGlobalRosterWorkers,
} = quotaApi;

/** 临时 settings.json 路径（不存在 = 从没写过设置项）。 */
async function tempSettings(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-team-quota-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "pi-web", "settings.json");
}

const CLEAN_ENV = {};

test("默认上限更宽：每团队 16 / 全局 64（无 env、无设置项）", async (t) => {
  const settingsPath = await tempSettings(t);
  const limits = readTeamQuotaLimits(CLEAN_ENV, settingsPath);
  assert.deepEqual(limits, { perTeamLimit: 16, globalLimit: 64 });
  assert.equal(TEAM_QUOTA_DEFAULTS.perTeamLimit, 16);
  assert.equal(TEAM_QUOTA_DEFAULTS.globalLimit, 64);
  const resolution = readTeamQuotaResolution(CLEAN_ENV, settingsPath);
  assert.deepEqual(resolution.sources, { perTeamLimit: "default", globalLimit: "default" });
});

test("env 覆盖 + 全局同义 env 名（PI_TEAM_MAX_GLOBAL_WORKERS / PI_TEAM_MAX_WORKERS）都认", async (t) => {
  const settingsPath = await tempSettings(t);
  assert.deepEqual(
    readTeamQuotaLimits({ PI_TEAM_MAX_MEMBERS: "24", PI_TEAM_MAX_GLOBAL_WORKERS: "48" }, settingsPath),
    { perTeamLimit: 24, globalLimit: 48 },
  );
  assert.deepEqual(
    readTeamQuotaLimits({ PI_TEAM_MAX_WORKERS: "40" }, settingsPath),
    { perTeamLimit: 16, globalLimit: 40 },
    "文档/旧版出现过的同义名要继续生效（读的人不该踩空）",
  );
  const resolution = readTeamQuotaResolution({ PI_TEAM_MAX_WORKERS: "40" }, settingsPath);
  assert.deepEqual(resolution.sources, { perTeamLimit: "default", globalLimit: "env" });
});

test("非法/非正 env 回落下一层（设置项 → 默认），不硬套 0", async (t) => {
  const settingsPath = await tempSettings(t);
  writeTeamQuotaSettings({ perTeamLimit: 20, globalLimit: 100 }, settingsPath);
  for (const bad of ["0", "-3", "abc", "", "  "]) {
    assert.deepEqual(
      readTeamQuotaLimits({ PI_TEAM_MAX_MEMBERS: bad, PI_TEAM_MAX_GLOBAL_WORKERS: bad }, settingsPath),
      { perTeamLimit: 20, globalLimit: 100 },
      `env=${JSON.stringify(bad)} 应回落设置项`,
    );
  }
});

test("设置项 teamQuota 生效且来源可辨；env 优先于设置项（如实例来源，避免「改了不生效」黑箱）", async (t) => {
  const settingsPath = await tempSettings(t);
  const saved = writeTeamQuotaSettings({ perTeamLimit: 24, globalLimit: 96 }, settingsPath);
  assert.deepEqual(saved, { perTeamLimit: 24, globalLimit: 96 });
  assert.deepEqual(readTeamQuotaSettings(settingsPath), { perTeamLimit: 24, globalLimit: 96 });

  const fromSettings = readTeamQuotaResolution(CLEAN_ENV, settingsPath);
  assert.deepEqual(
    { perTeamLimit: fromSettings.perTeamLimit, globalLimit: fromSettings.globalLimit },
    { perTeamLimit: 24, globalLimit: 96 },
  );
  assert.deepEqual(fromSettings.sources, { perTeamLimit: "settings", globalLimit: "settings" });

  // env 顶掉设置项：值是 env 的，来源如实标 env（设置页据此提示「被环境变量覆盖」）。
  const overridden = readTeamQuotaResolution({ PI_TEAM_MAX_MEMBERS: "8" }, settingsPath);
  assert.equal(overridden.perTeamLimit, 8);
  assert.equal(overridden.sources.perTeamLimit, "env");
  assert.equal(overridden.globalLimit, 96);
  assert.equal(overridden.sources.globalLimit, "settings");
});

test("writeTeamQuotaSettings：只改一个字段时另一个保留；越界/非整数抛 RangeError（不静默夹取）", async (t) => {
  const settingsPath = await tempSettings(t);
  writeTeamQuotaSettings({ perTeamLimit: 18, globalLimit: 72 }, settingsPath);
  writeTeamQuotaSettings({ globalLimit: 128 }, settingsPath);
  assert.deepEqual(readTeamQuotaSettings(settingsPath), { perTeamLimit: 18, globalLimit: 128 });

  assert.throws(() => writeTeamQuotaSettings({ perTeamLimit: 0 }, settingsPath), RangeError);
  assert.throws(() => writeTeamQuotaSettings({ globalLimit: TEAM_QUOTA_RANGES.globalLimit.max + 1 }, settingsPath), RangeError);
  assert.throws(() => writeTeamQuotaSettings({ perTeamLimit: 8.5 }, settingsPath), RangeError);
  assert.deepEqual(readTeamQuotaSettings(settingsPath), { perTeamLimit: 18, globalLimit: 128 }, "被拒的写入不落盘");
});

test("readTeamSpawnConcurrency：默认 4，env 可调并夹到 1..16", () => {
  assert.equal(readTeamSpawnConcurrency(CLEAN_ENV), 4);
  assert.equal(readTeamSpawnConcurrency({ PI_TEAM_MAX_SPAWN_CONCURRENCY: "8" }), 8);
  assert.equal(readTeamSpawnConcurrency({ PI_TEAM_MAX_SPAWN_CONCURRENCY: "0" }), 4, "非正回落默认");
  assert.equal(readTeamSpawnConcurrency({ PI_TEAM_MAX_SPAWN_CONCURRENCY: "99" }), 16);
});

test("名额预留：真实 .quota.lock 下并发 6 个请求限 2 ⇒ 恰 2 成，释放后可再用", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-team-quota-reserve-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  const decisions = await Promise.all(Array.from({ length: 6 }, () =>
    tryReserveTeamWorkerSlot({ globalLimit: 2, readTotal: async () => 0 })));
  const granted = decisions.filter((decision) => decision.granted);
  const refused = decisions.filter((decision) => !decision.granted);
  assert.equal(granted.length, 2, "在途预留必须挡住其它并发请求（不超卖）");
  assert.equal(refused.length, 4);
  assert.equal(quotaInflightCount(), 2);
  for (const decision of refused) assert.equal(decision.limit, 2, "拒单要能带出上限数字");

  for (const decision of granted) releaseQuotaSlot(decision.reservationId);
  assert.equal(quotaInflightCount(), 0);
  const after = await Promise.all(Array.from({ length: 2 }, () =>
    tryReserveTeamWorkerSlot({ globalLimit: 2, readTotal: async () => 0 })));
  assert.equal(after.filter((decision) => decision.granted).length, 2, "释放后名额立刻可用");
  for (const decision of after) if (decision.reservationId) releaseQuotaSlot(decision.reservationId);
  assert.equal(quotaInflightCount(), 0);
});

test("readGlobalRosterWorkers：多团队 × 几十名成员全部计数（并行读盘不吞成员）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-team-quota-many-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  let expected = 0;
  for (const team of ["team-a", "team-b", "team-c"]) {
    const members = [{ agentId: `${team}-lead`, name: "team-lead", joinedAt: 1, cwd: "D:/p" }];
    for (let index = 0; index < 20; index += 1) {
      members.push({ agentId: `${team}-w${index}`, name: `w${index}`, joinedAt: 1, cwd: "D:/p" });
    }
    expected += 20;
    await mkdir(join(root, team), { recursive: true });
    await writeFile(join(root, team, "config.json"), JSON.stringify({ name: team, createdAt: 1, members }));
    // plan 独有成员也要计（launch 派发只写 plan）。
    await writeFile(join(root, team, "plan.json"), JSON.stringify({
      members: [{ id: `${team}-p1`, name: "plan-only" }],
    }));
    expected += 1;
  }
  const { total } = await readGlobalRosterWorkers();
  assert.equal(total, expected, `3 团队 × (20 worker + 1 plan 独有) 全部计入，实际 ${total}`);
});
