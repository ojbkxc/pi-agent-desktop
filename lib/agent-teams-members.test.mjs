import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  addTeamMember,
  removeTeamMember,
  runGlobalQuotaGate,
  parseAddMembersBatch,
  parseRemoveMemberNames,
  MAX_BATCH_ADD_MEMBERS,
  MemberConflictError,
  MemberNotFoundError,
} = await jiti.import("@/lib/agent-teams-members.ts");
const { mutateTeamConfigFile, quotaInflightCount } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");

let teamDir;
let deliverCalls;
let startedSessions;
let stoppedSessions;
let probeResult;
let probeThrows;

test.before(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "pi-teams-members-"));
});
test.after(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

async function readConfig() {
  return JSON.parse(await readFile(join(teamDir, "config.json"), "utf8"));
}

async function writeConfig(config) {
  await writeFile(join(teamDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function baseConfig(members) {
  return { name: "demo", createdAt: 1, leadAgentId: "team-lead", members };
}

/** lifecycle 假实现：内存表，ensureLive/release 语义照 pi-team（无 sessionId 的 revive 抛错）。 */
function makeLifecycle(initial = {}) {
  const members = new Map(Object.entries(initial));
  return {
    map: members,
    async get(name) {
      return members.get(name);
    },
    async adopt(name, info) {
      const current = members.get(name) ?? { name, status: "idle", generation: 0 };
      const next = { ...current, ...info, status: "idle", generation: (current.generation ?? 0) + 1 };
      members.set(name, next);
      return next;
    },
    async release(name) {
      const current = members.get(name);
      if (!current) return { status: "parked", generation: 0 };
      const next = { ...current, status: "parked", generation: (current.generation ?? 0) + 1 };
      members.set(name, next);
      return next;
    },
    async ensureLive(name) {
      const current = members.get(name);
      if (!current) throw new Error(`成员 "${name}" 未登记到生命周期中。`);
      if (current.status === "running" || current.status === "idle") return current;
      if (!current.sessionId) throw new Error(`成员 "${name}" 处于 ${current.status} 但没有可复活的会话（sessionId 缺失）；请在邮箱里留言，等它的会话恢复后自行 drain。`);
      current.status = "idle";
      current.generation = (current.generation ?? 0) + 1;
      return current;
    },
  };
}

function makeDeps(overrides = {}) {
  deliverCalls = [];
  startedSessions = [];
  stoppedSessions = [];
  probeResult = false;
  probeThrows = false;
  let lifecycleInstance = overrides.lifecycleInstance ?? makeLifecycle();
  const deps = {
    teamDir,
    rawTeamName: "demo",
    quotaPerTeamLimit: 12,
    now: () => Date.now(),
    uuid: () => Math.random().toString(36).slice(2, 10),
    snapshotEntry: (entry) => JSON.stringify(entry),
    // 测试默认 lead 链：leadSessionId 命中优先（与 route 的注入同构）。
    leadNamesOf: (rosterMembers) => {
      const sessionIds = new Map(rosterMembers.map((member) => [member.name, member.sessionId]));
      const leads = new Set();
      if (overrides.leadSessionId && overrides.leadSessionId !== "unknown-session") {
        for (const [name, sessionId] of sessionIds) {
          if (sessionId === overrides.leadSessionId) leads.add(name);
        }
        if (leads.size > 0) return leads;
      }
      for (const member of rosterMembers) {
        if (member.name === "team-lead") leads.add(member.name);
      }
      if (leads.size > 0) return leads;
      if (rosterMembers[0]) leads.add(rosterMembers[0].name);
      return leads;
    },
    lifecycle: () => lifecycleInstance,
    hasLifecycleInstance: () => true,
    start: async (request) => {
      startedSessions.push(request);
      const sessionId = `sess-${startedSessions.length}`;
      return { sessionId, sessionFile: `${sessionId}.jsonl` };
    },
    stopSession: async (sessionId) => {
      stoppedSessions.push(sessionId);
    },
    probeRunning: async () => {
      if (probeThrows) throw new Error("probe exploded");
      return probeResult;
    },
    deliverText: async (to, body) => {
      deliverCalls.push({ to, body });
    },
    mutateConfig: (mutation) => mutateTeamConfigFile(teamDir, mutation),
    ...overrides,
  };
  return { deps, setLifecycle: (instance) => { lifecycleInstance = instance; } };
}

async function seed(members) {
  await writeConfig(baseConfig(members));
}

test("add：新成员 spawn + adopt + 递 prompt（名册真写盘）", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
  ]);
  const { deps } = makeDeps();
  const result = await addTeamMember(deps, { name: "alice", agentType: "general-purpose", prompt: "做 A" });
  assert.equal(result.status, "spawned");
  assert.ok(result.agentId?.startsWith("alice-"));
  assert.ok(startedSessions.length === 1 && startedSessions[0].name === "alice");
  assert.deepEqual(deliverCalls.map((call) => call.to), ["alice"], "prompt 必须真的递出去");
  const config = await readConfig();
  const alice = config.members.find((member) => member.name === "alice");
  assert.ok(alice, "名册必须真写盘");
  assert.equal(alice.agentType, "general-purpose");
});

test("add：同名活跃 ⇒ 409 且不假接新任务（不 start 不 deliver）", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "a-1", name: "bob", joinedAt: 1, cwd: "D:/p" },
  ]);
  const instance = makeLifecycle({ bob: { name: "bob", status: "running", sessionId: "sess-bob", generation: 3 } });
  const { deps } = makeDeps({ lifecycleInstance: instance });
  await assert.rejects(
    addTeamMember(deps, { name: "bob", prompt: "新任务" }),
    (error) => error instanceof MemberConflictError && /活跃/.test(error.message),
  );
  assert.deepEqual(startedSessions, [], "不能假装接新任务");
  assert.deepEqual(deliverCalls, []);
});

test("add：parked 有 sessionId ⇒ ensureLive 复活 + deliver 本次 prompt；无 sessionId ⇒ fallback 新 start", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "c-1", name: "carol", joinedAt: 1, cwd: "D:/p" },
  ]);
  const instance = makeLifecycle({ carol: { name: "carol", status: "parked", sessionId: "sess-carol", generation: 2 } });
  const { deps } = makeDeps({ lifecycleInstance: instance });
  const result = await addTeamMember(deps, { name: "carol", prompt: "回来干活 B" });
  assert.equal(result.status, "respawned");
  assert.equal(result.sessionId, "sess-carol");
  assert.deepEqual(startedSessions, [], "有 sessionId 必须走 ensureLive，不新起会话");
  assert.match(deliverCalls[0]?.body ?? "", /回来干活 B/);

  // 无 sessionId：ensureLive 抛 ⇒ fallback start（名册须有同名条目才走 respawn 分支——
  // lead 复核：不能只给 lifecycle 条目不给名册）。
  await writeFile(join(teamDir, "config.json"), `${JSON.stringify(baseConfig([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "c-1", name: "carol", joinedAt: 1, cwd: "D:/p" },
    { agentId: "d-1", name: "dave", joinedAt: 1, cwd: "D:/p" },
  ]), null, 2)}
`, "utf8");
  const bare = makeLifecycle({ dave: { name: "dave", status: "aborted", generation: 1 } });
  const { deps: deps2 } = makeDeps({ lifecycleInstance: bare });
  const result2 = await addTeamMember(deps2, { name: "dave", prompt: "C" });
  assert.equal(result2.status, "respawned");
  assert.equal(startedSessions.length, 1, "无 sessionId ⇒ 新 start");
  const configAfter = await readConfig();
  assert.equal(configAfter.members.filter((member) => member.name === "dave").length, 1, "fallback 不重复追加名册");
});

test("add：spawn 后 adopt 失败 ⇒ stop 会话 + 恢复临界区前原值（无原条目 ⇒ 摘除）", async () => {
  await seed([{ agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" }]);
  const { deps } = makeDeps();
  deps.lifecycle = () => ({
    get: async () => undefined,
    adopt: async () => {
      throw new Error("实例被并发移除");
    },
    release: async () => ({ status: "parked", generation: 1 }),
    ensureLive: async () => {
      throw new Error("unreachable");
    },
  });
  const result = await addTeamMember(deps, { name: "erin", prompt: "D" });
  assert.equal(result.status, "failed");
  assert.deepEqual(stoppedSessions.length, 1, "刚起的会话必须回收");
  const config = await readConfig();
  assert.equal(config.members.find((member) => member.name === "erin"), undefined, "名册必须回滚");
});

test("add：per-team 配额在临界区内判（名册 12 满 ⇒ 409 不写盘）", async () => {
  const members = [{ agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" }];
  for (let index = 0; index < 11; index += 1) {
    members.push({ agentId: `m-${index}`, name: `w${index}`, joinedAt: 1, cwd: "D:/p" });
  }
  await seed(members); // 11 workers（不含 lead）+ 新 1 = 12 ≤ 12 可行；再加第 13 个必须拒
  const { deps } = makeDeps({ quotaPerTeamLimit: 12 });
  const first = await addTeamMember(deps, { name: "will-fit" });
  assert.equal(first.status, "spawned");
  await assert.rejects(
    addTeamMember(deps, { name: "over-limit" }),
    (error) => error instanceof MemberConflictError && /per-team worker limit/.test(error.message),
  );
  const config = await readConfig();
  assert.equal(config.members.find((member) => member.name === "over-limit"), undefined, "被拒不写盘");
});

test("remove：running ⇒ 409；回执 parked 但 probe=true ⇒ 名册未动（判别）", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "f-1", name: "frank", joinedAt: 1, cwd: "D:/p" },
  ]);
  const instance = makeLifecycle({ frank: { name: "frank", status: "running", sessionId: "sess-frank", generation: 5 } });
  const { deps } = makeDeps({ lifecycleInstance: instance });
  await assert.rejects(
    removeTeamMember(deps, "frank"),
    (error) => error instanceof MemberConflictError && /running/.test(error.message),
  );

  // parked 回执 + 仍在跑 ⇒ 拒删。
  const parked = makeLifecycle({ frank: { name: "frank", status: "idle", sessionId: "sess-frank", generation: 5 } });
  const { deps: deps2 } = makeDeps({ lifecycleInstance: parked });
  probeResult = true;
  const result = await removeTeamMember(deps2, "frank");
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /仍在运行/);
  const config = await readConfig();
  assert.ok(config.members.find((member) => member.name === "frank"), "probe=true ⇒ 名册必须未动");
});

test("remove：probe 抛错 ⇒ 名册未动；全静 ⇒ 名册真移除；原值被并发改写 ⇒ 冲突不移除", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "g-1", name: "grace", joinedAt: 1, cwd: "D:/p" },
  ]);
  const instance = makeLifecycle({ grace: { name: "grace", status: "idle", sessionId: "sess-grace", generation: 2 } });
  const { deps } = makeDeps({ lifecycleInstance: instance });
  probeThrows = true;
  const failed = await removeTeamMember(deps, "grace");
  assert.equal(failed.status, "failed");
  let config = await readConfig();
  assert.ok(config.members.find((member) => member.name === "grace"));

  // 全静 ⇒ 移除。
  probeThrows = false;
  probeResult = false;
  const ok = await removeTeamMember(deps, "grace");
  assert.equal(ok.status, "removed");
  config = await readConfig();
  assert.equal(config.members.find((member) => member.name === "grace"), undefined);

  // 原值并发改写 ⇒ 冲突。
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "h-1", name: "heidi", joinedAt: 1, cwd: "D:/p", model: "m1" },
  ]);
  const instance2 = makeLifecycle({ heidi: { name: "heidi", status: "idle", sessionId: "sess-heidi", generation: 2 } });
  const { deps: deps3 } = makeDeps({ lifecycleInstance: instance2 });
  // 在 release 与移除之间改写名册：monkey-patch probeRunning 作同步钩子。
  let mutated = false;
  const originalProbe = deps3.probeRunning;
  deps3.probeRunning = async (sessionId) => {
    if (!mutated) {
      mutated = true;
      const current = await readConfig();
      const heidi = current.members.find((member) => member.name === "heidi");
      if (heidi) heidi.model = "m2-changed";
      await writeConfig(current);
    }
    return originalProbe(sessionId);
  };
  const conflict = await removeTeamMember(deps3, "heidi");
  assert.equal(conflict.status, "failed");
  assert.match(conflict.reason ?? "", /并发修改/);
  config = await readConfig();
  assert.equal(config.members.find((member) => member.name === "heidi")?.model, "m2-changed", "不覆盖他人改动");
});

test("remove：从未派发（无 lifecycle 条目、无 sessionId）⇒ 直接移除", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "i-1", name: "ivy", joinedAt: 1, cwd: "D:/p" },
  ]);
  const { deps } = makeDeps(); // lifecycle 空 ⇒ get 返回 undefined
  const result = await removeTeamMember(deps, "ivy");
  assert.equal(result.status, "removed");
  const config = await readConfig();
  assert.equal(config.members.find((member) => member.name === "ivy"), undefined);
});

test("remove：不存在的成员 ⇒ 404 语义", async () => {
  await seed([{ agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" }]);
  const { deps } = makeDeps();
  await assert.rejects(
    removeTeamMember(deps, "nobody"),
    (error) => error instanceof MemberNotFoundError,
  );
});

test("add：respawn 后 deliverText 失败 ⇒ status=respawned + warning（不整单失败、不回收会话）", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "j-1", name: "judy", joinedAt: 1, cwd: "D:/p" },
  ]);
  const instance = makeLifecycle({ judy: { name: "judy", status: "parked", sessionId: "sess-judy", generation: 2 } });
  deliverCalls = [];
  startedSessions = [];
  const { deps } = makeDeps({
    lifecycleInstance: instance,
    deliverText: async () => {
      throw new Error("bus down");
    },
  });
  const result = await addTeamMember(deps, { name: "judy", prompt: "回来" });
  assert.equal(result.status, "respawned", "复活成功不因投递失败变 failed");
  assert.match(result.warning ?? "", /投递失败/);
  assert.deepEqual(stoppedSessions, [], "不回收已复活的会话（那会留下未接管残骸）");
});

test("readGlobalRosterWorkers：改名 lead 不虚占全局配额（leadSessionId 优先链）", async () => {
  // 新目录 + PI_TEAM_DIR 指向测试根：改名 lead（chief）在首位、leadSessionId 指向它。
  const { mkdtemp: mk } = await import("node:fs/promises");
  const root = await mk(join(tmpdir(), "pi-teams-quota-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    await mkdir(join(root, "team-x"), { recursive: true });
    await writeFile(join(root, "team-x", "config.json"), `${JSON.stringify({
      name: "team-x", createdAt: 1, leadAgentId: "lead-1", leadSessionId: "sess-chief",
      members: [
        { agentId: "lead-1", name: "chief", sessionId: "sess-chief", joinedAt: 1, cwd: "D:/p" },
        { agentId: "w-1", name: "worker-a", joinedAt: 1, cwd: "D:/p" },
      ],
    })}
`, "utf8");
    const { readGlobalRosterWorkers, resolveLeadNames, readTeamConfigSnapshot } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");
    const snapshot = await readTeamConfigSnapshot("team-x");
    const leads = resolveLeadNames(snapshot);
    assert.ok(leads.has("chief"), "leadSessionId 优先识别改名 lead");
    const { total } = await readGlobalRosterWorkers();
    assert.equal(total, 1, "改名 lead 不虚占全局配额（只数 worker-a）");
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("readGlobalRosterWorkers：plan 独有成员计入全局配额（launch 派发不写 config）", async () => {
  // config.json 只在 team_create 写一次；launch 派发的成员只进 plan/lifecycle——
  // 只数 config 会让他们在全局配额里隐身（叠加上游 A2 的跨团队超卖）。
  const { mkdtemp: mk } = await import("node:fs/promises");
  const root = await mk(join(tmpdir(), "pi-teams-quota-plan-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    await mkdir(join(root, "team-x"), { recursive: true });
    await writeFile(join(root, "team-x", "config.json"), `${JSON.stringify({
      name: "team-x", createdAt: 1, leadAgentId: "lead-1", leadSessionId: "unknown-session",
      members: [
        { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
        { agentId: "w-1", name: "worker-a", joinedAt: 1, cwd: "D:/p" },
      ],
    })}
`, "utf8");
    await writeFile(join(root, "team-x", "plan.json"), `${JSON.stringify({
      planId: "plan-1",
      members: [
        { id: "p-impl", name: "impl", runtime: { modelId: "m1" } },
        { id: "p-qa", name: "qa", runtime: { modelId: "m2" } },
        { id: "p-a", name: "worker-a", runtime: { modelId: "m3" } }, // 同名以 config 为准，不重复计
      ],
    })}
`, "utf8");
    const { readGlobalRosterWorkers } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");
    const { total } = await readGlobalRosterWorkers();
    assert.equal(total, 3, "config worker（worker-a）+ plan 独有成员（impl、qa）= 3；同名不重复计");

    // plan.json 损坏 ⇒ 容错按无 plan 计（不拖垮配额读取）。
    await writeFile(join(root, "team-x", "plan.json"), "{ broken", "utf8");
    const degraded = await readGlobalRosterWorkers();
    assert.equal(degraded.total, 1, "plan 损坏时只数 config 名册");
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("per-team 配额计数走可靠 lead 链：改名 lead 不虚占（deps.leadNamesOf 判别）", async () => {
  // 名册 11 worker + 改名 lead（chief，首位）= 12 条目；quotaPerTeamLimit=12。
  // 旧口径（按名字排除 team-lead）数出 12 workers ⇒ 409；可靠链数出 11 ⇒ 可加。
  const members = [{ agentId: "lead-1", name: "chief", sessionId: "sess-chief", joinedAt: 1, cwd: "D:/p" }];
  for (let index = 0; index < 11; index += 1) {
    members.push({ agentId: `w-${index}`, name: `w${index}`, joinedAt: 1, cwd: "D:/p" });
  }
  await seed(members);
  const { deps } = makeDeps({
    quotaPerTeamLimit: 12,
    lifecycleInstance: makeLifecycle({ chief: { name: "chief", status: "idle", sessionId: "sess-chief", generation: 1 } }),
  });
  // makeDeps 的 deps 没有 leadNamesOf——route 注入的；这里手工按 store 链装配同款。
  const { resolveLeadNames } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");
  deps.leadNamesOf = (rosterMembers) => resolveLeadNames({
    rawName: "demo",
    leadSessionId: "sess-chief",
    members: rosterMembers.map((member) => ({
      agentId: typeof member.agentId === "string" ? member.agentId : "",
      name: typeof member.name === "string" ? member.name : "",
      ...(typeof member.sessionId === "string" && member.sessionId ? { sessionId: member.sessionId } : {}),
    })),
  });
  const result = await addTeamMember(deps, { name: "fits" });
  assert.equal(result.status, "spawned", "改名 lead 不虚占：11 workers < 12 可加");
  const config = await readConfig();
  assert.ok(config.members.find((member) => member.name === "fits"));
});

test("addTeamMember respawn 不新增名册条目（全局配额不因 respawn 虚增的实现基础）", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "k-1", name: "kate", joinedAt: 1, cwd: "D:/p" },
  ]);
  const instance = makeLifecycle({ kate: { name: "kate", status: "parked", sessionId: "sess-kate", generation: 2 } });
  const { deps } = makeDeps({ lifecycleInstance: instance });
  const before = (await readConfig()).members.length;
  const result = await addTeamMember(deps, { name: "kate", prompt: "回归" });
  assert.equal(result.status, "respawned");
  const after = (await readConfig()).members.length;
  assert.equal(after, before, "respawn 不追加名册 ⇒ 全局配额计数不变（route 侧只对 spawned +1）");
});

test("route 级全局配额：真实 withQuotaLock 下两团队并发恰一成（全局限 1）", async () => {
  const { mkdtemp: mk } = await import("node:fs/promises");
  const root = await mk(join(tmpdir(), "pi-teams-quota2-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    // 两个团队各 0 worker；全局限 1 ⇒ 并发各加 1 名成员必须恰一成一 409。
    const { readGlobalRosterWorkers, readTeamQuotaLimits, mutateTeamConfigFile } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");
    const { addTeamMember: addMember, runGlobalQuotaGate } = await jiti.import("@/lib/agent-teams-members.ts");
    for (const team of ["team-a", "team-b"]) {
      await mkdir(join(root, team), { recursive: true });
      await writeFile(join(root, team, "config.json"), `${JSON.stringify({
        name: team, createdAt: 1, leadAgentId: "lead-1",
        members: [{ agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" }],
      })}
`, "utf8");
    }
    const limits = { ...readTeamQuotaLimits(), globalLimit: 1 };
    const makeDepsFor = (team) => ({
      teamDir: join(root, team),
      rawTeamName: team,
      quotaPerTeamLimit: 12,
      now: () => Date.now(),
      uuid: () => Math.random().toString(36).slice(2, 8),
      snapshotEntry: (entry) => JSON.stringify(entry),
      leadNamesOf: (rosterMembers) => {
        const leads = new Set();
        for (const member of rosterMembers) {
          if (member.name === "team-lead") leads.add(member.name);
        }
        if (leads.size === 0 && rosterMembers[0]) leads.add(rosterMembers[0].name);
        return leads;
      },
      lifecycle: () => ({ get: async () => undefined, adopt: async () => ({}), release: async () => ({}), ensureLive: async () => { throw new Error("no session"); } }),
      hasLifecycleInstance: () => false,
      start: async () => ({ sessionId: `s-${team}`, sessionFile: "f" }),
      stopSession: async () => {},
      probeRunning: async () => false,
      deliverText: async () => {},
      mutateConfig: (mutation) => mutateTeamConfigFile(join(root, team), mutation),
    });
    // route 真闸：runGlobalQuotaGate 自己拿 .quota.lock（route POST 的同一函数链），
    // 名额判定在锁内、spawn 在锁外并行。
    const attempt = (team, name) => runGlobalQuotaGate(
      {
        globalLimit: limits.globalLimit,
        readTotal: async () => (await readGlobalRosterWorkers()).total,
        addOne: (input) => addMember(makeDepsFor(team), input),
      },
      [{ name }],
    ).then((gate) => ({ team, status: gate.conflict ? "conflict" : "ok" }));
    const outcomes = await Promise.all([attempt("team-a", "wa"), attempt("team-b", "wb")]);
    const oks = outcomes.filter((outcome) => outcome.status === "ok");
    const conflicts = outcomes.filter((outcome) => outcome.status === "conflict");
    assert.equal(oks.length, 1, `恰一成：${JSON.stringify(outcomes)}`);
    assert.equal(conflicts.length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("runGlobalQuotaGate：全局限 0 ⇒ 拒任何新增（含首个）；批量逐次重读在真闸内", async () => {
  const calls = [];
  const gate = await runGlobalQuotaGate(
    {
      globalLimit: 0,
      readTotal: async () => {
        calls.push("read");
        return 0;
      },
      addOne: async () => {
        throw new Error("limit 0 不得尝试 add");
      },
      // 假锁：本用例只验「入口就拒」，不落 .quota.lock 占位文件。
      withLock: async (task) => task(),
    },
    [{ name: "a" }, { name: "b" }],
  );
  assert.ok(gate.conflict && /limit reached \(0\)/.test(gate.conflict));
  assert.deepEqual(gate.results, []);
  assert.equal(calls.length, 1, "入口拒后不进循环");
});

test("runGlobalQuotaGate：respawn 不占位——限 1 时 respawn+spawn 批量可行", async () => {
  let total = 1; // 已满 1/limit2 → 剩 1 余量
  const gate = await runGlobalQuotaGate(
    {
      globalLimit: 2,
      readTotal: async () => total,
      addOne: async (input) => {
        if (input.name === "re") return { name: "re", status: "respawned" }; // 不占
        total += 1; // spawned 真占
        return { name: input.name, status: "spawned" };
      },
      withLock: async (task) => task(), // 假锁：本用例只验账面口径
    },
    [{ name: "re" }, { name: "new1" }],
  );
  assert.equal(gate.conflict, null);
  assert.deepEqual(gate.results.map((result) => result.status), ["respawned", "spawned"]);
  assert.equal(total, 2, "respawn 不加 total ⇒ 第二个 spawn 恰好进得来");
});

// ── 「多派成员 / 多并发」边界（本轮新增）──────────────────────────────────────

/** 进程内异步互斥：注入 runGlobalQuotaGate 的 withLock（替代真实 .quota.lock，快且确定）。 */
function makeMutex() {
  let chain = Promise.resolve();
  return (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}

test("parseAddMembersBatch：16 个一批照收（旧的 8 上限不再把「多派成员」拦在门外）", () => {
  const members = Array.from({ length: 16 }, (_, index) => ({ name: `w${index}` }));
  const parsed = parseAddMembersBatch(members);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.value.length, 16);
});

test("parseAddMembersBatch：超批上限 / 非法名 / 同名去重 / prompt 截断 的口径", () => {
  const tooMany = Array.from({ length: MAX_BATCH_ADD_MEMBERS + 1 }, (_, index) => ({ name: `w${index}` }));
  const over = parseAddMembersBatch(tooMany);
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(String(MAX_BATCH_ADD_MEMBERS)), "错误文案要带当前上限");

  assert.equal(parseAddMembersBatch([]).ok, false, "空数组整单拒");
  assert.equal(parseAddMembersBatch([{ name: "坏名字" }]).ok, false, "非法名整单拒，不静默跳过");
  assert.equal(parseAddMembersBatch(["junk"]).ok, false);

  const deduped = parseAddMembersBatch([
    { name: "alice", prompt: "x".repeat(3000) },
    { name: "ALICE" }, // 大小写同名：去重
    { name: "bob", agentType: "general-purpose", model: "m1" },
  ]);
  assert.ok(deduped.ok);
  assert.deepEqual(deduped.value.map((input) => input.name), ["alice", "bob"]);
  assert.equal(deduped.value[0].prompt.length, 2000, "超长 prompt 截断而不是拒单");
  assert.equal(deduped.value[1].agentType, "general-purpose");
  assert.equal(deduped.value[1].model, "m1");
});

test("parseRemoveMemberNames：去重保序、非法名整单拒、超上限拒", () => {
  const parsed = parseRemoveMemberNames(["a", "b", "a"]);
  assert.deepEqual(parsed.ok && parsed.value, ["a", "b"]);
  assert.equal(parseRemoveMemberNames(["a b"]).ok, false);
  assert.equal(parseRemoveMemberNames(Array.from({ length: 65 }, (_, i) => `w${i}`)).ok, false);
});

test("per-team 上限抬到 16 后：15 名 worker 仍可再派，满 16 才拒（含数字与出路）", async () => {
  const members = [{ agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" }];
  for (let index = 0; index < 15; index += 1) {
    members.push({ agentId: `m-${index}`, name: `w${index}`, joinedAt: 1, cwd: "D:/p" });
  }
  await seed(members);
  const { deps } = makeDeps({ quotaPerTeamLimit: 16 });
  const fits = await addTeamMember(deps, { name: "sixteenth" });
  assert.equal(fits.status, "spawned", "15 < 16 必须能派");
  await assert.rejects(
    addTeamMember(deps, { name: "over-limit" }),
    (error) => {
      assert.ok(error instanceof MemberConflictError);
      assert.match(error.message, /per-team worker limit reached \(16\)/, "保留英文前缀 + 上限数字");
      assert.match(error.message, /已有 16 名 worker/, "报出已用数字");
      assert.match(error.message, /PI_TEAM_MAX_MEMBERS|teamQuota\.perTeamLimit/, "给出可执行出路：改哪个开关");
      assert.match(error.message, /\/members .*remove|action":"remove|"action":"remove"/, "给出腾名额的具体请求");
      return true;
    },
  );
});

test("并发派成员不超卖：全局限 3、6 个并发请求恰 3 成，在途账本归零", async () => {
  const withLock = makeMutex();
  let onDisk = 0; // 模拟「已落盘的成员数」
  const okNames = [];
  const attempt = (name) => runGlobalQuotaGate(
    {
      globalLimit: 3,
      readTotal: async () => onDisk,
      withLock,
      addOne: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 15)); // spawn 是秒级，这里缩到 15ms
        onDisk += 1; // 名册落盘
        okNames.push(input.name);
        return { name: input.name, status: "spawned" };
      },
    },
    [{ name }],
  );
  const outcomes = await Promise.all(["a", "b", "c", "d", "e", "f"].map(attempt));
  const granted = outcomes.filter((outcome) => outcome.conflict === null);
  const refused = outcomes.filter((outcome) => outcome.conflict !== null);
  assert.equal(granted.length, 3, `恰 3 个拿到名额（实际 ${granted.length}）`);
  assert.equal(refused.length, 3);
  assert.equal(onDisk, 3, "盘上恰 3 名，不超卖");
  assert.equal(quotaInflightCount(), 0, "预留必须全部释放（泄漏会永久吃名额）");
  for (const outcome of refused) {
    assert.match(outcome.conflict, /global worker limit reached \(3\)/);
    assert.match(outcome.conflict, /teamQuota\.globalLimit|PI_TEAM_MAX_GLOBAL_WORKERS/, "拒单要给可执行出路");
  }
});

test("批内单个成员失败不中止整批：重名/该团队满只记 failed，其余继续派", async () => {
  const withLock = makeMutex();
  let onDisk = 0;
  const gate = await runGlobalQuotaGate(
    {
      globalLimit: 8,
      readTotal: async () => onDisk,
      withLock,
      addOne: async (input) => {
        if (input.name === "dup") throw new MemberConflictError("成员「dup」已存在且活跃（running）");
        onDisk += 1;
        return { name: input.name, status: "spawned" };
      },
    },
    [{ name: "a" }, { name: "dup" }, { name: "b" }, { name: "c" }],
  );
  assert.equal(gate.conflict, null, "单成员冲突不再是整批 409");
  assert.deepEqual(gate.results.map((result) => result.name), ["a", "dup", "b", "c"], "结果按请求顺序如实返回");
  assert.deepEqual(
    gate.results.map((result) => result.status),
    ["spawned", "failed", "spawned", "spawned"],
    "失败隔离：后面的成员照派",
  );
  assert.match(gate.results[1].reason, /活跃/);
  assert.equal(quotaInflightCount(), 0);
});

test("失败成员的预留会释放：限 1 时前一个失败不妨碍下一个派发", async () => {
  const withLock = makeMutex();
  let onDisk = 0;
  const deps = {
    globalLimit: 1,
    readTotal: async () => onDisk,
    withLock,
    addOne: async (input) => {
      if (input.name === "boom") throw new Error("宿主拒绝：spawn failed");
      onDisk += 1;
      return { name: input.name, status: "spawned" };
    },
  };
  const first = await runGlobalQuotaGate(deps, [{ name: "boom" }]);
  assert.deepEqual(first.results.map((result) => result.status), ["failed"]);
  assert.equal(quotaInflightCount(), 0, "失败即释放预留");
  const second = await runGlobalQuotaGate(deps, [{ name: "next" }]);
  assert.equal(second.conflict, null, "名额没泄漏 ⇒ 下一个能进");
  assert.deepEqual(second.results.map((result) => result.status), ["spawned"]);
});

test("批量派发真的并发：上限充足时多个 spawn 同时在飞（不是排队等锁）", async () => {
  const withLock = makeMutex();
  let inFlight = 0;
  let maxInFlight = 0;
  let onDisk = 0;
  const gate = await runGlobalQuotaGate(
    {
      globalLimit: 100,
      readTotal: async () => onDisk,
      withLock,
      concurrency: 4,
      addOne: async (input) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        onDisk += 1;
        return { name: input.name, status: "spawned" };
      },
    },
    Array.from({ length: 6 }, (_, index) => ({ name: `w${index}` })),
  );
  assert.equal(gate.conflict, null);
  assert.equal(gate.results.length, 6);
  assert.ok(maxInFlight > 1, `必须并发起进程（实测最大并发 ${maxInFlight}）`);
  assert.ok(maxInFlight <= 4, `并发度受 concurrency 约束（实测 ${maxInFlight}）`);
});

test("同团队不同成员并行 spawn；同名 add 仍串行（不会为同一个名字起两个会话）", async () => {
  await seed([{ agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" }]);
  let concurrent = 0;
  let maxConcurrent = 0;
  const { deps } = makeDeps();
  const baseStart = deps.start;
  deps.start = async (request) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrent -= 1;
    return baseStart(request);
  };

  const [a, b] = await Promise.all([
    addTeamMember(deps, { name: "par-a" }),
    addTeamMember(deps, { name: "par-b" }),
  ]);
  assert.equal(a.status, "spawned");
  assert.equal(b.status, "spawned");
  assert.equal(maxConcurrent, 2, `不同成员必须并行 spawn（实测 ${maxConcurrent}）`);
  const config = await readConfig();
  assert.ok(config.members.find((member) => member.name === "par-a"));
  assert.ok(config.members.find((member) => member.name === "par-b"));

  // 同名并发：成员级队列槽把第二个挡在第一个之后 ⇒ 看到「已活跃」，不会起第二个会话。
  const before = startedSessions.length;
  const same = await Promise.allSettled([
    addTeamMember(deps, { name: "par-c" }),
    addTeamMember(deps, { name: "par-c" }),
  ]);
  const fulfilled = same.filter((outcome) => outcome.status === "fulfilled");
  const rejected = same.filter((outcome) => outcome.status === "rejected");
  assert.equal(rejected.length, 1, "同名第二个必须被拒（重复会话会让第一个变孤儿）");
  assert.match(rejected[0].reason.message, /活跃/);
  assert.equal(fulfilled.length, 1);
  assert.equal(startedSessions.length - before, 1, "同名只起一个会话");
  assert.equal((await readConfig()).members.filter((member) => member.name === "par-c").length, 1, "名册不重复");
});

test("批量删成员：一个冲突不中止整批（按请求顺序如实逐条回报）", async () => {
  await seed([
    { agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "D:/p" },
    { agentId: "k1", name: "keep-a", joinedAt: 1, cwd: "D:/p" },
    { agentId: "k2", name: "busy", joinedAt: 1, cwd: "D:/p" },
    { agentId: "k3", name: "keep-b", joinedAt: 1, cwd: "D:/p" },
  ]);
  const instance = makeLifecycle({ busy: { name: "busy", status: "running", sessionId: "sess-busy", generation: 2 } });
  const { deps } = makeDeps({ lifecycleInstance: instance });
  const { removeTeamMembersBatch } = await jiti.import("@/lib/agent-teams-members.ts");
  const { results, conflict } = await removeTeamMembersBatch(deps, ["keep-a", "busy", "ghost", "keep-b"]);
  assert.deepEqual(results.map((result) => result.name), ["keep-a", "busy", "ghost", "keep-b"], "顺序稳定、四条都在");
  assert.deepEqual(
    results.map((result) => result.status),
    ["removed", "failed", "failed", "removed"],
    "冲突/不存在只记该条，后面照删（旧实现遇冲突 break）",
  );
  assert.match(conflict ?? "", /running/, "首个 409 语义如实带出");
  const config = await readConfig();
  assert.equal(config.members.find((member) => member.name === "keep-a"), undefined);
  assert.equal(config.members.find((member) => member.name === "keep-b"), undefined, "后面的成员真的被删掉");
  assert.ok(config.members.find((member) => member.name === "busy"), "running 的保留");
});
