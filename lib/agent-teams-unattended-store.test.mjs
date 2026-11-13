import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const store = await jiti.import("./agent-teams-unattended-store.ts");
const { collectUnattendedInput, readUnattendedFile, writeUnattendedFile, writeUnattendedState, writeUnattendedConfig, clearManualNeeds, isUnattendedDisabledByEnv, sanitizeTeamName, unattendedSettingsPath } = store;

async function teamsRoot() {
  return mkdtemp(join(tmpdir(), "pi-teams-fallback-"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

test("collects review_pending plans and failed assignments from disk", async () => {
  const root = await teamsRoot();
  await writeJson(join(root, "alpha", "plan.json"), {
    planId: "p1", sessionId: "lead-1", revision: 3, state: "review_pending", updatedAt: 111,
    members: [
      { id: "m1", name: "w1", runtime: { providerId: "prov", modelId: "big" } },
      { id: "m2", name: "w2", runtime: { providerId: "prov2", modelId: "flash-x" } },
    ],
  });
  await writeJson(join(root, "alpha", "tickets", "t1.json"), {
    id: "t1", subject: "实现登录", status: "open", assignments: [
      { id: "a1", assignee: "w1", status: "ended", outcome: "completed", updatedAt: 1 },
      { id: "a2", assignee: "w1", status: "ended", outcome: "failed", result: "boom", updatedAt: 2 },
    ],
  });
  // An ended ticket is ignored even with a failed assignment.
  await writeJson(join(root, "alpha", "tickets", "t2.json"), {
    id: "t2", subject: "已结束", status: "ended", assignments: [
      { id: "b1", assignee: "w2", status: "ended", outcome: "failed", updatedAt: 3 },
    ],
  });
  // A member stamped after failures is still resolved for the model field.
  await writeJson(join(root, "beta", "config.json"), { members: [] }); // no plan.json -> skipped

  const input = await collectUnattendedInput({ PI_TEAM_DIR: root });

  assert.equal(input.awaitingPlans.length, 1);
  const plan = input.awaitingPlans[0];
  assert.equal(plan.teamName, "alpha");
  assert.equal(plan.sessionId, "lead-1");
  assert.equal(plan.revision, 3);
  assert.equal(plan.updatedAt, 111);
  assert.deepEqual(plan.members.map((m) => m.name), ["w1", "w2"]);

  assert.equal(input.failedAssignments.length, 1);
  const failure = input.failedAssignments[0];
  assert.equal(failure.ticketId, "t1");
  assert.equal(failure.assignmentId, "a2");
  assert.equal(failure.member, "w1");
  assert.equal(failure.providerId, "prov");
  assert.equal(failure.modelId, "big");
  assert.equal(failure.error, "boom");

  assert.deepEqual(input.skippedTeams, ["beta"]);
});

test("a missing teams root yields an empty, non-throwing input", async () => {
  const input = await collectUnattendedInput({ PI_TEAM_DIR: join(tmpdir(), "does-not-exist-" + Date.now()) });
  assert.deepEqual(input, { awaitingPlans: [], failedAssignments: [], skippedTeams: [] });
});

test("plan.json 的 sessionId 是占位 'unknown-session' 时，改投真实 lead 会话", async () => {
  // pi-team 写 plan.json 的 sessionId 也读 PI_SESSION_ID（本服务进程从不设置），所以本机
  // 每份 plan 都是 'unknown-session'，投递必然落空。改用成员会话反推的真实 lead。
  const root = await teamsRoot();
  await writeJson(join(root, "alpha", "plan.json"), {
    planId: "p1", sessionId: "unknown-session", revision: 1, state: "review_pending", updatedAt: 5,
    members: [{ id: "m1", name: "w1", runtime: { providerId: "prov", modelId: "big" } }],
  });
  await writeJson(join(root, "alpha", "config.json"), {
    name: "alpha", leadSessionId: "unknown-session",
    members: [{ agentId: "a", name: "team-lead" }, { agentId: "b", name: "w1" }],
  });
  // 成员会话的 pi-web:subagent 快照：唯一可靠的 lead 证据。
  const memberFile = join(root, "alpha", "w1-session.jsonl");
  await writeFile(memberFile, `${[
    { type: "session", version: 3, id: "child-w1", timestamp: "2026-11-05T01:00:00.000Z", cwd: "D:/proj" },
    {
      type: "custom", customType: "pi-web:subagent", id: "a1", parentId: null, timestamp: "2026-11-05T01:00:01.000Z",
      data: { version: 1, parentSessionId: "real-lead", parentSessionPath: "/s/real-lead.jsonl", parentToolCallId: "pi-team:w1", profile: "general-purpose", description: "alpha/w1", task: "干活", runInBackground: true, createdAt: "2026-11-05T01:00:01.000Z" },
    },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
  await writeJson(join(root, "alpha", "lifecycle.json"), {
    version: 1,
    members: { w1: { name: "w1", status: "parked", sessionId: "child-w1", sessionFile: memberFile, updatedAt: 1 } },
  });

  const input = await collectUnattendedInput({ PI_TEAM_DIR: root });
  assert.equal(input.awaitingPlans.length, 1);
  assert.equal(input.awaitingPlans[0].sessionId, "real-lead", "投递目标改成真实 lead 会话");
});

test("占位 lead 又反推不出来时保留原值（不静默吞掉计划）", async () => {
  const root = await teamsRoot();
  await writeJson(join(root, "alpha", "plan.json"), {
    planId: "p1", sessionId: "unknown-session", revision: 1, state: "review_pending", updatedAt: 5,
    members: [],
  });
  const input = await collectUnattendedInput({ PI_TEAM_DIR: root });
  assert.equal(input.awaitingPlans.length, 1);
  assert.equal(input.awaitingPlans[0].sessionId, "unknown-session");
});

test("settings file round-trips, defaults when missing, and tolerates garbage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-teams-fallback-cfg-"));
  const path = join(dir, "nested", "teams-fallback.json");

  const missing = readUnattendedFile(path);
  assert.equal(missing.config.enabled, true);
  assert.equal(missing.config.approvalTimeoutMs, 10 * 60_000);
  assert.equal(missing.config.maxFailureRetries, 2);
  assert.deepEqual(missing.state, { approvalNudges: {}, failureNudges: {} });

  writeUnattendedFile({
    config: { enabled: false, approvalTimeoutMs: 5000, maxFailureRetries: 1 },
    state: { approvalNudges: { p1: 2 }, failureNudges: { t1: { attempts: 1, lastAssignmentId: "a1", exhaustedNotified: false } } },
  }, path);
  const loaded = readUnattendedFile(path);
  assert.deepEqual(loaded.config, { enabled: false, approvalTimeoutMs: 5000, maxFailureRetries: 1 });
  assert.equal(loaded.state.approvalNudges.p1, 2);
  assert.equal(loaded.state.failureNudges.t1.attempts, 1);

  // writeUnattendedState keeps the on-disk config (user's thresholds) and replaces only state.
  writeUnattendedState({ approvalNudges: { p9: 1 }, failureNudges: {} }, path);
  const afterState = readUnattendedFile(path);
  assert.deepEqual(afterState.config, { enabled: false, approvalTimeoutMs: 5000, maxFailureRetries: 1 });
  assert.deepEqual(afterState.state.approvalNudges, { p9: 1 });

  await writeFile(path, "{ not json");
  const garbage = readUnattendedFile(path);
  assert.equal(garbage.config.enabled, true);

  // The real path sits next to pi-web/settings.json.
  assert.match(unattendedSettingsPath({ PI_CODING_AGENT_DIR: "/tmp/agentdir" }), /pi-web[\\/]teams-fallback\.json$/);
});

test("sanitizeTeamName matches pi-team's rule", () => {
  assert.equal(sanitizeTeamName("My Team/α"), "my-team--");
  assert.equal(sanitizeTeamName("alpha"), "alpha");
});

test("a corrupt plan.json is skipped without throwing", async () => {
  const root = await teamsRoot();
  await mkdir(join(root, "gamma"), { recursive: true });
  await writeFile(join(root, "gamma", "plan.json"), "{ broken");
  const input = await collectUnattendedInput({ PI_TEAM_DIR: root });
  assert.deepEqual(input.awaitingPlans, []);
  assert.deepEqual(input.failedAssignments, []);
  assert.deepEqual(input.skippedTeams, ["gamma"]);
});

// ── 设置面新增能力（#28）：只改 config / 只清 manualNeeds，互不越界 ──────────────

test("writeUnattendedConfig replaces config but leaves the ledger untouched", async () => {
  const path = join(await teamsRoot(), "teams-fallback.json");
  writeUnattendedFile({
    config: { enabled: true, approvalTimeoutMs: 600000, maxFailureRetries: 2 },
    state: {
      approvalNudges: { p1: 3 },
      failureNudges: { t1: { attempts: 2, lastAssignmentId: "a1", exhaustedNotified: true } },
      manualNeeds: { "plan:p1": { at: 5, reason: "投递失败" } },
    },
  }, path);

  writeUnattendedConfig({ enabled: false, approvalTimeoutMs: 120000, maxFailureRetries: 0 }, path);

  const after = readUnattendedFile(path);
  assert.deepEqual(after.config, { enabled: false, approvalTimeoutMs: 120000, maxFailureRetries: 0 });
  assert.deepEqual(after.state.approvalNudges, { p1: 3 }, "账本不被设置面清掉");
  assert.deepEqual(after.state.manualNeeds, { "plan:p1": { at: 5, reason: "投递失败" } });
});

test("clearManualNeeds removes only the named keys, keeping config and nudges", async () => {
  const path = join(await teamsRoot(), "teams-fallback.json");
  writeUnattendedFile({
    config: { enabled: true, approvalTimeoutMs: 600000, maxFailureRetries: 2 },
    state: {
      approvalNudges: { p1: 3 },
      failureNudges: { t1: { attempts: 1, lastAssignmentId: "a1", exhaustedNotified: false } },
      manualNeeds: {
        "plan:p1": { at: 5, reason: "投递失败" },
        "ticket:t9": { at: 6, reason: "已达重试上限" },
      },
    },
  }, path);

  const state = clearManualNeeds(["plan:p1"], path);
  assert.deepEqual(Object.keys(state.manualNeeds ?? {}), ["ticket:t9"]);
  const after = readUnattendedFile(path);
  assert.deepEqual(after.config, { enabled: true, approvalTimeoutMs: 600000, maxFailureRetries: 2 }, "config 不动");
  assert.deepEqual(after.state.approvalNudges, { p1: 3 }, "审批账本不动");
  assert.deepEqual(Object.keys(after.state.failureNudges), ["t1"], "失败账本不动");

  // 清空最后一条后 manualNeeds 整个消失，不留空对象
  const emptied = clearManualNeeds(["ticket:t9"], path);
  assert.equal(emptied.manualNeeds, undefined);
});

test("isUnattendedDisabledByEnv reflects PI_WEB_DISABLE_TEAMS_FALLBACK=1", () => {
  assert.equal(isUnattendedDisabledByEnv({ PI_WEB_DISABLE_TEAMS_FALLBACK: "1" }), true);
  assert.equal(isUnattendedDisabledByEnv({ PI_WEB_DISABLE_TEAMS_FALLBACK: "0" }), false);
  assert.equal(isUnattendedDisabledByEnv({}), false);
});
