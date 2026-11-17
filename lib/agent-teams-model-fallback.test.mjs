import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./agent-teams-model-fallback.ts");
const { classifyOutageError } = await jiti.import("./outage/classify.ts");
const runtimeMod = await jiti.import("./agent-teams-model-fallback-runtime.ts");

const A = { providerId: "p1", modelId: "m-a" };
const B = { providerId: "p1", modelId: "m-b" };
const C = { providerId: "p2", modelId: "m-c" };

const classify = (text) => classifyOutageError(text);

function decide(patch = {}) {
  return mod.decideModelFallback({
    sessionId: "s-1",
    errorText: "503 Service Unavailable",
    current: A,
    roster: [A, B, C],
    hasAuth: () => true,
    attemptsSoFar: 0,
    ...patch,
  }, classify);
}

// ── 误判防线 ────────────────────────────────────────────

test("代码错误绝不能触发换模型（换模型解决不了，还会掩盖真问题）", () => {
  for (const text of [
    "TypeError: Cannot read properties of undefined",
    "SyntaxError: Unexpected token",
    "401 Unauthorized",
    "Model not found: foo",
  ]) {
    const decision = decide({ errorText: text });
    assert.equal(decision.action, "skip", text);
    assert.equal(decision.reason, "not-provider-failure", text);
  }
});

test("provider 故障（5xx / 连接断 / 额度）才换", () => {
  for (const text of ["503 Service Unavailable", "socket hang up", "ECONNREFUSED", "502 bad gateway"]) {
    const decision = decide({ errorText: text });
    assert.equal(decision.action, "switch", text);
  }
});

// ── 候选选择 ────────────────────────────────────────────

test("排除当前模型，绝不换到自己；且优先跨 provider（同 provider 多半一起挂）", () => {
  const decision = decide();
  assert.equal(decision.action, "switch");
  assert.notDeepEqual(decision.candidate, A);
  assert.deepEqual(decision.candidate, C, "p2 的候选优先于同 provider 的 m-b");
});

test("只有同 provider 的候选时才退而求其次用它", () => {
  const decision = decide({ roster: [A, B] });
  assert.equal(decision.action, "switch");
  assert.deepEqual(decision.candidate, B);
});

test("triedSoFar：本次故障里换上去又失败的模型不再重选（防 A→B→A 横跳）", () => {
  assert.deepEqual(decide().candidate, C);
  const decision = decide({ triedSoFar: [C] });
  assert.deepEqual(decision.candidate, B, "C 已试过，退到同 provider 的 B");
});

test("无候选时给 lead 一条提示（说明换了几个、为什么停手）", () => {
  const text = mod.buildLeadNudgePrompt({
    teamName: "team-x", memberSessionId: "s-1", memberName: "alice",
    reason: "没有可用候选", attempts: 1,
  });
  assert.match(text, /alice|s-1/);
  assert.match(text, /没有可用候选/);
});

test("跳过没有凭据的候选（换了也只会抛 No API key）", () => {
  const decision = decide({ hasAuth: (c) => c.modelId !== "m-b" });
  assert.equal(decision.action, "switch");
  assert.deepEqual(decision.candidate, C);
});

test("凭据查询抛异常按「没有凭据」处理，不误换", () => {
  const decision = decide({
    hasAuth: (c) => { if (c.modelId === "m-b") throw new Error("auth lookup exploded"); return false; },
  });
  assert.equal(decision.action, "no-candidate");
});

test("名册去重：同 provider+model 只算一个候选", () => {
  const decision = decide({ roster: [A, A, B, B] });
  assert.equal(decision.action, "switch");
  assert.deepEqual(decision.candidate, B);
});

test("所有候选都不可用 ⇒ no-candidate，不硬换", () => {
  const decision = decide({ roster: [A], hasAuth: () => true });
  assert.equal(decision.action, "no-candidate", "只剩当前模型等于没有候选");
  assert.equal(decision.considered, 1);
});

test("没有当前模型信息时也能换（仍然是排除不了的那一个）", () => {
  const decision = decide({ current: null });
  assert.equal(decision.action, "switch");
  assert.deepEqual(decision.candidate, A, "没有 current 就取名册第一个");
});

// ── 次数上限 ────────────────────────────────────────────

test("次数上限：换满 2 次就停手，交回团队", () => {
  assert.equal(decide({ attemptsSoFar: 0 }).action, "switch");
  assert.equal(decide({ attemptsSoFar: 1 }).action, "switch");
  const exhausted = decide({ attemptsSoFar: 2 });
  assert.equal(exhausted.action, "exhausted");
  assert.equal(exhausted.attempts, 2);
});

test("默认上限是 2（可被参数覆盖）", () => {
  assert.equal(mod.MAX_MODEL_FALLBACKS_PER_MEMBER, 2);
  assert.equal(decide({ attemptsSoFar: 3, maxAttempts: 5 }).action, "switch");
});

test("次数计数按会话隔离，可重置", () => {
  mod.resetModelFallbackAttempts();
  assert.equal(mod.modelFallbackAttempts("s-1"), 0);
  assert.equal(mod.recordModelFallbackAttempt("s-1"), 1);
  assert.equal(mod.recordModelFallbackAttempt("s-1"), 2);
  assert.equal(mod.modelFallbackAttempts("s-2"), 0, "别的会话不受影响");
  mod.resetModelFallbackAttempts("s-1");
  assert.equal(mod.modelFallbackAttempts("s-1"), 0);
  assert.equal(mod.modelFallbackAttempts("s-2"), 0);
});

test("去重函数过滤掉字段缺失的条目", () => {
  const deduped = mod.dedupeModelCandidates([
    { providerId: "", modelId: "x" },
    { providerId: "p", modelId: "" },
    A,
  ]);
  assert.deepEqual(deduped, [A]);
});

// ── 运行时接线（注入 deps，不走真实团队/模型栈）────────────

function fakeDeps(patch = {}) {
  const calls = { switchModel: [], resume: [], detach: [], log: [] };
  const nudged = new Set();
  return {
    calls,
    deps: {
      findTeam: async () => "team-x",
      leadSessionId: async () => "s-lead",
      readRoster: async () => [{ name: "alice", sessionId: "s-1", runtime: A }, { name: "bob", sessionId: "s-2", runtime: B }],
      currentModel: async () => A,
      hasAuth: async () => true,
      switchModel: async (id, candidate) => { calls.switchModel.push({ id, candidate }); return true; },
      resume: async (id, candidate) => { calls.resume.push({ id, candidate }); },
      detachOutage: (id) => { calls.detach.push(id); },
      nudgeLead: async (team, memberId, message) => { calls.log.push(`nudge:${memberId}`); },
      leadNudged: (id) => nudged.has(id),
      markLeadNudged: (id) => { nudged.add(id); },
      clearSessionState: () => { nudged.clear(); },
      log: (m) => { calls.log.push(m); },
      ...patch,
    },
  };
}

test("运行时：provider 故障 ⇒ 切模型 + 摘 outage + 续跑，顺序固定", async () => {
  const order = [];
  const { deps } = fakeDeps({
    switchModel: async (id, candidate) => { order.push("switch"); return true; },
    detachOutage: () => { order.push("detach"); },
    resume: async () => { order.push("resume"); },
  });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-1", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, true);
  // 名册里 s-1 当前是 A(p1)，唯一别的候选是同 provider 的 B(p1) —— 跨 provider 优先
  // 没有可选对象，所以落到 B。
  assert.deepEqual(result.to, B);
  // 顺序必须是 switch → detach → resume：先摘 outage 再续跑，否则 scheduler 可能在
  // 这中间再塞一条续跑提示（双驱动）。
  assert.deepEqual(order, ["switch", "detach", "resume"]);
});

test("运行时：不属于任何团队 ⇒ 不动（skip）", async () => {
  const { deps, calls } = fakeDeps({ findTeam: async () => null });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-1", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, false);
  assert.equal(calls.switchModel.length, 0);
});

test("运行时：lead 会话 ⇒ 绝不换（lead 不是执行中的成员）", async () => {
  const { deps, calls } = fakeDeps({ leadSessionId: async () => "s-lead" });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-lead", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, false);
  assert.equal(calls.switchModel.length, 0);
  assert.equal(calls.log.filter((line) => line.startsWith("nudge:")).length, 0, "也不给自己发提醒");
});

test("运行时：解不出 lead ⇒ 按成员处理，照常换（反推失败不阻断）", async () => {
  const { deps } = fakeDeps({ leadSessionId: async () => null });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-1", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, true);
});

test("运行时：不是 provider 故障 ⇒ 连团队都不查", async () => {
  let asked = false;
  const { deps } = fakeDeps({ findTeam: async () => { asked = true; return "team-x"; } });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-1", errorText: "TypeError: undefined is not a function",
  });
  assert.equal(result.switched, false);
  assert.equal(asked, false, "非 provider 故障不该有任何 IO");
});

test("运行时：set_model 投递失败 ⇒ 不推进计数、不续跑、不摘 outage", async () => {
  const { deps, calls } = fakeDeps({ switchModel: async () => false });
  mod.resetModelFallbackAttempts();
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-fail", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, false);
  assert.equal(calls.resume.length, 0, "切换没成功就不能续跑");
  assert.equal(calls.detach.length, 0, "切换没成功不能摘 outage，否则既没换模型也不再等待恢复");
  assert.equal(mod.modelFallbackAttempts("s-fail"), 0, "失败的尝试不计数");
});

test("运行时：deps 抛异常 ⇒ 吞掉并返回 skipped（绝不影响成员自身错误上报）", async () => {
  const { deps } = fakeDeps({ findTeam: async () => { throw new Error("boom"); } });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-1", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, false);
  assert.equal(result.decision.action, "skip");
});

test("运行时：名册里成员没有 runtime ⇒ 跳过该条，不崩", async () => {
  // s-2 当前是 B(p1)；名册里 A(p1) 是唯一别的候选。
  const { deps, calls } = fakeDeps({
    currentModel: async () => B,
    readRoster: async () => [{ name: "alice", sessionId: "s-1", runtime: A }, { name: "bad", sessionId: "s-9", runtime: {} }, { name: "bob", sessionId: "s-2", runtime: B }],
  });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-2", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, true);
  assert.deepEqual(calls.switchModel[0].candidate, A);
});

// ── 回落提醒（无候选 / 触顶）──────────────────────────────

test("运行时：无候选 ⇒ 不硬换，提醒 lead 一次；同一会话再失败不重复提醒", async () => {
  let nudges = 0;
  const nudged = new Set();
  const { deps, calls } = fakeDeps({
    readRoster: async () => [{ name: "alice", sessionId: "s-1", runtime: A }],
    nudgeLead: async () => { nudges += 1; },
    leadNudged: (id) => nudged.has(id),
    markLeadNudged: (id) => { nudged.add(id); },
  });
  const first = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-1", errorText: "503 Service Unavailable",
  });
  assert.equal(first.switched, false);
  assert.equal(first.decision.action, "no-candidate");
  assert.equal(calls.switchModel.length, 0, "没有候选就不能调 set_model");
  assert.equal(nudges, 1, "要提醒 lead，不能静默");

  const second = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-1", errorText: "503 Service Unavailable",
  });
  assert.equal(second.switched, false);
  assert.equal(nudges, 1, "同一段故障里不重复提醒 lead");
});

test("运行时：次数触顶 ⇒ 不硬换，提醒 lead（reason=次数上限）", async () => {
  mod.resetModelFallbackAttempts("s-exhausted");
  mod.recordModelFallbackAttempt("s-exhausted");
  mod.recordModelFallbackAttempt("s-exhausted");
  const nudged = new Set();
  const nudges = [];
  const { deps, calls } = fakeDeps({
    nudgeLead: async (team, memberId, message) => { nudges.push(message); },
    leadNudged: (id) => nudged.has(id),
    markLeadNudged: (id) => { nudged.add(id); },
  });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-exhausted", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, false);
  assert.equal(result.decision.action, "exhausted");
  assert.equal(calls.switchModel.length, 0, "触顶后绝不能继续换");
  assert.equal(nudges.length, 1);
  assert.match(nudges[0], /次数上限/);
});

test("运行时：提醒 lead 失败 ⇒ 吞掉，仍返回 skip（换模型失败不影响成员上报）", async () => {
  const { deps } = fakeDeps({
    readRoster: async () => [{ name: "alice", sessionId: "s-1", runtime: A }],
    nudgeLead: async () => { throw new Error("lead 会话不存在"); },
  });
  const result = await runtimeMod.maybeSwitchTeamMemberModel(deps, {
    sessionId: "s-1", errorText: "503 Service Unavailable",
  });
  assert.equal(result.switched, false);
  assert.equal(result.decision.action, "no-candidate");
});

// ── 防横跳：失败过的模型进已试清单 ───────────────────────

test("markModelFallbackFailed：被排除的模型不再被选（A 失败→换 B→B 也失败→不切回 A）", () => {
  mod.resetModelFallbackAttempts("s-tried");
  mod.markModelFallbackFailed("s-tried", A);
  const tried = mod.modelFallbackTried("s-tried");
  assert.deepEqual(tried, [A]);
  // B 是当前模型，A 已试过，只剩 C。
  const decision = mod.decideModelFallback({
    sessionId: "s-tried",
    errorText: "503 Service Unavailable",
    current: B,
    roster: [A, B, C],
    hasAuth: () => true,
    attemptsSoFar: 1,
    triedSoFar: tried,
  }, classify);
  assert.equal(decision.action, "switch");
  assert.deepEqual(decision.candidate, C);
});

test("markModelFallbackFailed：字段缺失不登记；reset 清空已试清单", () => {
  mod.resetModelFallbackAttempts("s-x");
  mod.markModelFallbackFailed("s-x", { providerId: "", modelId: "m" });
  mod.markModelFallbackFailed("s-x", null);
  assert.deepEqual(mod.modelFallbackTried("s-x"), []);
  mod.markModelFallbackFailed("s-x", A);
  assert.equal(mod.modelFallbackTried("s-x").length, 1);
  mod.resetModelFallbackAttempts("s-x");
  assert.deepEqual(mod.modelFallbackTried("s-x"), []);
});

test("运行时：连续失败把每个失败模型拉黑（A 挂→C 挂→只剩 B，绝不切回 A/C）", async () => {
  mod.resetModelFallbackAttempts("s-chain");
  const roster = [
    { name: "alice", sessionId: "s-chain", runtime: A },
    { name: "bob", sessionId: "s-b", runtime: B },
    { name: "carol", sessionId: "s-c", runtime: C },
  ];
  // 第一轮：A 失败 → 跨 provider 的 C 优先，换到 C。
  const first = await runtimeMod.maybeSwitchTeamMemberModel(fakeDeps({
    readRoster: async () => roster,
    currentModel: async () => A,
    hasAuth: async () => true,
    switchModel: async () => true,
  }).deps, { sessionId: "s-chain", errorText: "503 Service Unavailable" });
  assert.deepEqual(first.to, C, "跨 provider 的 C 优先");
  // 第二轮：C 也失败（当前模型 C）→ C 被拉黑，A 早已拉黑，只剩 B。
  const second = await runtimeMod.maybeSwitchTeamMemberModel(fakeDeps({
    readRoster: async () => roster,
    currentModel: async () => C,
    hasAuth: async () => true,
    switchModel: async () => true,
  }).deps, { sessionId: "s-chain", errorText: "503 Service Unavailable" });
  assert.equal(second.switched, true);
  assert.deepEqual(second.to, B, "只剩 B 可选；A 与 C 都失败过");
  // 第三轮：B 也失败 → 次数触顶（3 > 2），且没有新候选。
  const third = await runtimeMod.maybeSwitchTeamMemberModel(fakeDeps({
    readRoster: async () => roster,
    currentModel: async () => B,
    hasAuth: async () => true,
    switchModel: async () => true,
  }).deps, { sessionId: "s-chain", errorText: "503 Service Unavailable" });
  assert.equal(third.switched, false);
  assert.equal(third.decision.action, "exhausted", "上限先于候选判定");
});