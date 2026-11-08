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
  MemberConflictError,
  MemberNotFoundError,
} = await jiti.import("@/lib/agent-teams-members.ts");
const { mutateTeamConfigFile } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");

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
    const { readGlobalRosterWorkers, readTeamQuotaLimits, withQuotaLock, mutateTeamConfigFile } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");
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
    // route 真闸：withQuotaLock 包 runGlobalQuotaGate（route POST 的同一函数链）。
    const attempt = (team, name) => withQuotaLock(() =>
      runGlobalQuotaGate(
        {
          globalLimit: limits.globalLimit,
          readTotal: async () => (await readGlobalRosterWorkers()).total,
          addOne: (input) => addMember(makeDepsFor(team), input),
        },
        [{ name }],
      ).then((gate) => ({ team, status: gate.conflict ? "conflict" : "ok" })),
    );
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
    },
    [{ name: "re" }, { name: "new1" }],
  );
  assert.equal(gate.conflict, null);
  assert.deepEqual(gate.results.map((result) => result.status), ["respawned", "spawned"]);
  assert.equal(total, 2, "respawn 不加 total ⇒ 第二个 spawn 恰好进得来");
});
