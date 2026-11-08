import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const core = await jiti.import("./agent-teams-unattended.ts");
const { DEFAULT_UNATTENDED_CONFIG, planUnattendedActions, formatWaited, buildApprovalPrompt, buildFailurePrompt, approvalRequestId, describeAction } = core;

const NOW = 1_000_000_000_000;
const cfg = (over = {}) => ({ ...DEFAULT_UNATTENDED_CONFIG, ...over });
const emptyState = () => ({ approvalNudges: {}, failureNudges: {} });

function plan(over = {}) {
  return {
    teamName: "alpha",
    planId: "p1",
    revision: 1,
    sessionId: "lead-1",
    updatedAt: NOW - 11 * 60_000,
    members: [{ id: "m1", name: "w1", providerId: "prov", modelId: "big-model" }],
    ...over,
  };
}

function failed(over = {}) {
  return {
    teamName: "alpha",
    sessionId: "lead-1",
    ticketId: "t1",
    ticketSubject: "实现登录",
    assignmentId: "a1",
    member: "w1",
    providerId: "prov",
    modelId: "big-model",
    error: "boom",
    updatedAt: NOW - 60_000,
    ...over,
  };
}

test("disabled config emits nothing and leaves the ledger untouched", () => {
  const state = emptyState();
  const out = planUnattendedActions({ now: NOW, config: cfg({ enabled: false }), awaitingPlans: [plan()], failedAssignments: [failed()], state });
  assert.deepEqual(out.actions, []);
  assert.equal(out.state, state);
});

test("approval waits below threshold, then nudges once per revision", () => {
  const fresh = plan({ updatedAt: NOW - 60_000 });
  const belowThreshold = planUnattendedActions({ now: NOW, config: cfg(), awaitingPlans: [fresh], failedAssignments: [], state: emptyState() });
  assert.deepEqual(belowThreshold.actions, []);

  const first = planUnattendedActions({ now: NOW, config: cfg(), awaitingPlans: [plan()], failedAssignments: [], state: emptyState() });
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].kind, "nudge-approval");
  assert.equal(first.actions[0].planId, "p1");
  assert.equal(first.actions[0].waitedMs, 11 * 60_000);
  assert.equal(first.state.approvalNudges.p1, 1);

  // Same revision: no repeat.
  const again = planUnattendedActions({ now: NOW, config: cfg(), awaitingPlans: [plan()], failedAssignments: [], state: first.state });
  assert.deepEqual(again.actions, []);

  // A revised plan gets one fresh nudge.
  const revised = planUnattendedActions({ now: NOW, config: cfg(), awaitingPlans: [plan({ revision: 2 })], failedAssignments: [], state: first.state });
  assert.equal(revised.actions.length, 1);
  assert.equal(revised.state.approvalNudges.p1, 2);
});

test("a plan without a lead session is skipped", () => {
  const out = planUnattendedActions({ now: NOW, config: cfg(), awaitingPlans: [plan({ sessionId: "" })], failedAssignments: [], state: emptyState() });
  assert.deepEqual(out.actions, []);
});

test("approval prompt carries the wait, plan id, the flash rule and a reporting demand", () => {
  const text = buildApprovalPrompt(plan(), 11 * 60_000);
  assert.match(text, /11 分钟/);
  assert.match(text, /p1/);
  assert.match(text, /flash/i);
  assert.match(text, /同一 provider/);
  assert.match(text, /approve/);
  assert.match(text, /汇报/);
  assert.match(text, /不要硬批/);
});

test("approval prompt declares itself a system message, not the user", () => {
  const text = buildApprovalPrompt(plan(), 11 * 60_000);
  // 首句（第一行）必须自我声明，且明确不是用户本人。
  const firstLine = text.split("\n")[0];
  assert.match(firstLine, /系统自动/);
  assert.match(firstLine, /不是你本人/);
  assert.doesNotMatch(firstLine, /【/, "自我声明应是身份声明，而不是一个标签");
});

test("approval prompt pins a deterministic approve request_id", () => {
  const first = buildApprovalPrompt(plan(), 11 * 60_000);
  const same = buildApprovalPrompt(plan(), 11 * 60_000);
  const id = approvalRequestId(plan());
  assert.equal(id, "unattended-p1-r1");
  assert.match(first, new RegExp(`request_id`));
  assert.ok(first.includes(id), "prompt must carry the exact request id");
  assert.ok(same.includes(id), "same planId + revision → same id");
  // 同一计划在同一 tick 之外再提醒一次也必须给同一个 id（幂等键不能随等待时长变）。
  assert.ok(buildApprovalPrompt(plan(), 3 * 3_600_000).includes(id), "id must not depend on waitedMs");

  // revision 变则 id 变。
  const revised = plan({ revision: 2 });
  assert.equal(approvalRequestId(revised), "unattended-p1-r2");
  assert.notEqual(approvalRequestId(revised), id);
  assert.ok(buildApprovalPrompt(revised, 11 * 60_000).includes("unattended-p1-r2"));

  // planId 变则 id 变。
  assert.equal(approvalRequestId(plan({ planId: "p2" })), "unattended-p2-r1");
});

test("approval prompt forbids model changes when no suitable Flash model exists", () => {
  const text = buildApprovalPrompt(plan(), 11 * 60_000);
  assert.match(text, /找不到合适的 Flash/);
  assert.match(text, /不要改模型/);
  // 「同 provider」是有条件的硬要求，而不是「优先」。
  assert.match(text, /同一 provider/);
  assert.doesNotMatch(text, /优先与成员同一 provider/, "同一 provider 不应再是软性建议");
});

test("failure recovery nudges once per distinct failure and stops after K", () => {
  const first = planUnattendedActions({ now: NOW, config: cfg({ maxFailureRetries: 2 }), awaitingPlans: [], failedAssignments: [failed()], state: emptyState() });
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].kind, "nudge-failure");
  assert.equal(first.actions[0].attempts, 1);
  assert.equal(first.state.failureNudges.t1.attempts, 1);

  // The exact same failure is never re-sent every tick.
  const sameTick = planUnattendedActions({ now: NOW, config: cfg({ maxFailureRetries: 2 }), awaitingPlans: [], failedAssignments: [failed()], state: first.state });
  assert.deepEqual(sameTick.actions, []);

  // A new failure (re-dispatch failed again) increments to the cap.
  const second = planUnattendedActions({ now: NOW, config: cfg({ maxFailureRetries: 2 }), awaitingPlans: [], failedAssignments: [failed({ assignmentId: "a2" })], state: first.state });
  assert.equal(second.actions.length, 1);
  assert.equal(second.actions[0].kind, "nudge-failure");
  assert.equal(second.actions[0].attempts, 2);

  // Beyond the cap: notify once, never retry.
  const third = planUnattendedActions({ now: NOW, config: cfg({ maxFailureRetries: 2 }), awaitingPlans: [], failedAssignments: [failed({ assignmentId: "a3" })], state: second.state });
  assert.equal(third.actions.length, 1);
  assert.equal(third.actions[0].kind, "notify-exhausted");
  assert.equal(third.actions[0].attempts, 2);

  // D4-6: a genuinely NEW failure after exhaustion refreshes the ledger instead
  // of staying silent — no push, no nudge, but the runtime gets a signal.
  const fourth = planUnattendedActions({ now: NOW, config: cfg({ maxFailureRetries: 2 }), awaitingPlans: [], failedAssignments: [failed({ assignmentId: "a4" })], state: third.state });
  assert.equal(fourth.actions.length, 1);
  assert.equal(fourth.actions[0].kind, "refresh-exhausted");
  assert.equal(fourth.actions[0].attempts, 4, "真实累计失败数");
  assert.equal(fourth.state.failureNudges.t1.exhaustedNotified, true, "不重置已通知位");
  assert.equal(fourth.state.failureNudges.t1.lastAssignmentId, "a4");

  // And that refresh fires once per new assignment, not every tick.
  const fifth = planUnattendedActions({ now: NOW, config: cfg({ maxFailureRetries: 2 }), awaitingPlans: [], failedAssignments: [failed({ assignmentId: "a4" })], state: fourth.state });
  assert.deepEqual(fifth.actions, []);
});

test("only the latest failed assignment per ticket is considered", () => {
  const older = failed({ assignmentId: "a-old", updatedAt: NOW - 500_000 });
  const newer = failed({ assignmentId: "a-new", updatedAt: NOW - 1000 });
  const out = planUnattendedActions({ now: NOW, config: cfg(), awaitingPlans: [], failedAssignments: [newer, older], state: emptyState() });
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].assignmentId, "a-new");
});

test("failure prompt names the member, model, ticket, reason, attempt and cap", () => {
  const text = buildFailurePrompt(failed(), 1, 2);
  assert.match(text, /w1/);
  assert.match(text, /prov\/big-model/);
  assert.match(text, /实现登录/);
  assert.match(text, /boom/);
  assert.match(text, /换模型重派/);
  assert.match(text, /接管/);
  assert.match(text, /1 次，上限 2 次/);
});

test("failure prompt declares itself a system message and forbids unsafe retries", () => {
  const text = buildFailurePrompt(failed(), 1, 2);
  const firstLine = text.split("\n")[0];
  assert.match(firstLine, /系统自动/);
  assert.match(firstLine, /不是你本人/);
  assert.doesNotMatch(firstLine, /【/, "自我声明应是身份声明，而不是一个标签");
  assert.match(text, /无法安全重试/);
  assert.match(text, /不要硬试/);
});

test("deterministic ordering regardless of input order", () => {
  const plans = [plan({ planId: "p2", sessionId: "lead-2", teamName: "beta" }), plan({ planId: "p1" })];
  const failures = [failed({ ticketId: "t2", assignmentId: "a2" }), failed({ ticketId: "t1", assignmentId: "a1" })];
  const run = (input) => planUnattendedActions({ now: NOW, config: cfg(), awaitingPlans: input.plans, failedAssignments: input.failures, state: emptyState() });
  const forward = run({ plans, failures }).actions.map((a) => `${a.kind}:${a.planId ?? a.ticketId}`);
  const reversed = run({ plans: [...plans].reverse(), failures: [...failures].reverse() }).actions.map((a) => `${a.kind}:${a.planId ?? a.ticketId}`);
  assert.deepEqual(forward, ["nudge-approval:p1", "nudge-approval:p2", "nudge-failure:t1", "nudge-failure:t2"]);
  assert.deepEqual(reversed, forward);
});

test("formatWaited renders minutes and hours", () => {
  assert.equal(formatWaited(0), "0 分钟");
  assert.equal(formatWaited(10 * 60_000), "10 分钟");
  assert.equal(formatWaited(60 * 60_000), "1 小时");
  assert.equal(formatWaited(95 * 60_000), "1 小时 35 分钟");
});

test("describeAction produces a user-facing line for each kind", () => {
  const approval = { kind: "nudge-approval", teamName: "alpha", sessionId: "s", planId: "p", revision: 1, waitedMs: 11 * 60_000, members: [], prompt: "" };
  const failure = { kind: "nudge-failure", teamName: "alpha", sessionId: "s", ticketId: "t", ticketSubject: "登录", assignmentId: "a", member: "w1", attempts: 1, maxRetries: 2, prompt: "" };
  const exhausted = { kind: "notify-exhausted", teamName: "alpha", sessionId: "s", ticketId: "t", ticketSubject: "登录", member: "w1", attempts: 2 };
  const refresh = { kind: "refresh-exhausted", teamName: "alpha", sessionId: "s", ticketId: "t", ticketSubject: "登录", member: "w1", attempts: 4 };
  assert.match(describeAction(approval), /alpha/);
  assert.match(describeAction(failure), /1\/2/);
  assert.match(describeAction(exhausted), /人工处理/);
  assert.match(describeAction(refresh), /累计 4 次/, "台账刷新文案报真实累计数");
});

test("default config matches the documented policy", () => {
  assert.equal(DEFAULT_UNATTENDED_CONFIG.enabled, true);
  assert.equal(DEFAULT_UNATTENDED_CONFIG.approvalTimeoutMs, 10 * 60_000);
  assert.equal(DEFAULT_UNATTENDED_CONFIG.maxFailureRetries, 2);
});
