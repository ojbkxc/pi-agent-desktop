import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const core = await jiti.import("./agent-teams-unattended.ts");
const {
  DEFAULT_UNATTENDED_CONFIG,
  normalizePlanTimestamp,
  waitingMsFor,
  planUnattendedActions,
  formatWaited,
  buildApprovalPrompt,
  buildFailurePrompt,
  approvalRequestId,
  describeAction,
} = core;

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

// ─────────────────────────────────────────────────────────────────────────────
// 本轮修复：plan.json 的时间戳语义（旧实现把「认不出的时间」当 0 → 刚提交就催批）。
// ─────────────────────────────────────────────────────────────────────────────

test("normalizePlanTimestamp：毫秒 / 秒 / ISO / 数字字符串都归一，认不出的返回 null", () => {
  assert.equal(normalizePlanTimestamp(NOW), NOW, "epoch 毫秒原样");
  assert.equal(normalizePlanTimestamp(NOW / 1000), NOW, "epoch 秒按量级判 → 毫秒");
  assert.equal(normalizePlanTimestamp("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:00.000Z"), "ISO 字符串");
  assert.equal(normalizePlanTimestamp(String(NOW / 1000)), NOW, "数字字符串按同一套量级判");
  // 认不出来的一律 null —— 绝不用 0 兜底（0 会被算成「等了 55 年」）。
  assert.equal(normalizePlanTimestamp(undefined), null);
  assert.equal(normalizePlanTimestamp(null), null);
  assert.equal(normalizePlanTimestamp(0), null);
  assert.equal(normalizePlanTimestamp(-5), null);
  assert.equal(normalizePlanTimestamp(""), null);
  assert.equal(normalizePlanTimestamp("   "), null);
  assert.equal(normalizePlanTimestamp("不是时间"), null);
  assert.equal(normalizePlanTimestamp(Number.NaN), null);
  assert.equal(normalizePlanTimestamp(Number.POSITIVE_INFINITY), null);
});

test("waitingMsFor：等待时长以最后一次写盘为准；时间未知或已批过时返回 null", () => {
  assert.equal(waitingMsFor({ updatedAt: NOW - 11 * 60_000 }, NOW), 11 * 60_000);
  assert.equal(waitingMsFor({ updatedAt: NOW - 11 * 60_000, approvedAt: null }, NOW), 11 * 60_000);
  // 已批过（review_pending 上的 approvedAt 是过期快照）：不再催，避免重复批准。
  assert.equal(waitingMsFor({ updatedAt: NOW - 11 * 60_000, approvedAt: NOW - 60_000 }, NOW), null);
  // 时间认不出来 = 无法判定：不催（旧实现 here 会算出 now - 0 ≈ 55 年）。
  assert.equal(waitingMsFor({ updatedAt: 0 }, NOW), null);
  assert.equal(waitingMsFor({ updatedAt: undefined }, NOW), null);
  // 未来时间戳（时钟回拨/跨机写盘）夹到 0：等于「刚刚写过」。
  assert.equal(waitingMsFor({ updatedAt: NOW + 60_000 }, NOW), 0);
  // 秒级 / ISO 写者同样能判。
  assert.equal(waitingMsFor({ updatedAt: (NOW - 11 * 60_000) / 1000 }, NOW), 11 * 60_000);
  assert.equal(
    waitingMsFor({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }, NOW),
    11 * 60_000,
  );
});

test("刚提交的计划不被误判为久等（updatedAt 缺失/为 0 时不再立刻催批）", () => {
  // 旧行为：updatedAt 缺失 → store 落 0 → waited = now - 0 ≈ 55 年 → 立刻 nudge-approval。
  const missing = planUnattendedActions({
    now: NOW,
    config: cfg(),
    awaitingPlans: [plan({ updatedAt: 0 })],
    failedAssignments: [],
    state: emptyState(),
  });
  assert.deepEqual(missing.actions, [], "时间未知时不催");
  assert.deepEqual(missing.state.approvalNudges, {}, "也没写账本（下次 tick 仍可提醒）");

  // 秒级写者：等待时长按毫秒算，仍要越过阈值才提醒（11 分钟 > 10 分钟 → 提醒）。
  const seconds = planUnattendedActions({
    now: NOW,
    config: cfg(),
    awaitingPlans: [plan({ updatedAt: (NOW - 11 * 60_000) / 1000 })],
    failedAssignments: [],
    state: emptyState(),
  });
  assert.equal(seconds.actions.length, 1);
  assert.equal(seconds.actions[0].waitedMs, 11 * 60_000, "秒级时间戳不得把等待算成 55 年");
  assert.match(seconds.actions[0].prompt, /11 分钟/);

  // ISO 字符串写者：刚提交（1 分钟）→ 不提醒。
  const iso = planUnattendedActions({
    now: NOW,
    config: cfg(),
    awaitingPlans: [plan({ updatedAt: new Date(NOW - 60_000).toISOString() })],
    failedAssignments: [],
    state: emptyState(),
  });
  assert.deepEqual(iso.actions, [], "刚提交（ISO 时间戳）不催");
});

test("静态：判定链不再用「近似 submittedAt」的 0 兜底，也不再直接 now - updatedAt", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./agent-teams-unattended.ts", import.meta.url), "utf8");
  assert.match(source, /export function waitingMsFor/, "等待时长判定收敛到单一函数");
  assert.match(source, /export function normalizePlanTimestamp/, "时间戳归一化导出可测");
  assert.doesNotMatch(source, /Number\.isFinite\(plan\.updatedAt\)/, "旧的裸 isFinite 过滤已移除");
  assert.doesNotMatch(source, /const waitedMs = input\.now - plan\.updatedAt/, "不再直接相减");
  assert.doesNotMatch(source, /近似 submittedAt/g, "注释不再把 updatedAt 说成「近似 submittedAt」");
});
