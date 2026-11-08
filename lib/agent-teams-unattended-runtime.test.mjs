import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const runtime = await jiti.import("./agent-teams-unattended-runtime.ts");
const { runUnattendedSweep } = runtime;
const { DEFAULT_UNATTENDED_CONFIG } = await jiti.import("./agent-teams-unattended.ts");

const NOW = 1_000_000_000_000;
const baseConfig = { ...DEFAULT_UNATTENDED_CONFIG };

function makeDeps({ config = baseConfig, state = { approvalNudges: {}, failureNudges: {} }, input, deliverResult = { ok: true } } = {}) {
  const calls = { delivered: [], notified: [], written: [] };
  return {
    calls,
    now: () => NOW,
    readState: () => ({ config, state, filePath: "/tmp/teams-fallback.json" }),
    writeState: (next, filePath) => calls.written.push({ state: next, filePath }),
    collect: async () => input,
    deliver: async (sessionId, message) => { calls.delivered.push({ sessionId, message }); return deliverResult; },
    notify: async (event) => calls.notified.push(event),
    log: () => {},
  };
}

const awaitingPlan = {
  teamName: "alpha", planId: "p1", revision: 1, sessionId: "lead-1",
  updatedAt: NOW - 11 * 60_000, members: [],
};

test("a stuck approval is nudged to the lead, notified, and recorded", async () => {
  const deps = makeDeps({ input: { awaitingPlans: [awaitingPlan], failedAssignments: [], skippedTeams: [] } });
  const result = await runUnattendedSweep(deps);

  assert.deepEqual(result, { actions: 1, nudged: 1, failed: 0, notified: 0 });
  assert.equal(deps.calls.delivered.length, 1);
  assert.equal(deps.calls.delivered[0].sessionId, "lead-1");
  assert.match(deps.calls.delivered[0].message, /无人值守提醒/);
  assert.equal(deps.calls.notified.length, 1);
  assert.equal(deps.calls.notified[0].kind, "nudged");
  assert.equal(deps.calls.written.length, 1);
  assert.equal(deps.calls.written[0].state.approvalNudges.p1, 1);
});

test("no actions means no delivery, no notification, and no write", async () => {
  const deps = makeDeps({ input: { awaitingPlans: [], failedAssignments: [], skippedTeams: [] } });
  const result = await runUnattendedSweep(deps);
  assert.deepEqual(result, { actions: 0, nudged: 0, failed: 0, notified: 0 });
  assert.deepEqual(deps.calls.delivered, []);
  assert.deepEqual(deps.calls.notified, []);
  assert.deepEqual(deps.calls.written, []);
});

test("an undeliverable nudge is flagged for a human and still recorded (no per-tick spam)", async () => {
  const deps = makeDeps({
    input: { awaitingPlans: [awaitingPlan], failedAssignments: [], skippedTeams: [] },
    deliverResult: { ok: false, reason: "找不到 lead 会话文件（可能已被删除）" },
  });
  const result = await runUnattendedSweep(deps);

  assert.deepEqual(result, { actions: 1, nudged: 0, failed: 1, notified: 0 });
  assert.equal(deps.calls.notified.length, 1);
  assert.equal(deps.calls.notified[0].kind, "needs-human");
  assert.match(deps.calls.notified[0].detail, /需人工|人工处理/);
  // The ledger still advances so the same nudge is not re-sent every tick.
  assert.equal(deps.calls.written[0].state.approvalNudges.p1, 1);
  assert.ok(deps.calls.written[0].state.manualNeeds["plan:p1"]);
});

test("exhausted retries notify the user and never re-deliver", async () => {
  const state = { approvalNudges: {}, failureNudges: { t1: { attempts: 2, lastAssignmentId: "a2", exhaustedNotified: false } } };
  const deps = makeDeps({
    state,
    config: { ...baseConfig, maxFailureRetries: 2 },
    input: {
      awaitingPlans: [],
      failedAssignments: [{
        teamName: "alpha", sessionId: "lead-1", ticketId: "t1", ticketSubject: "登录",
        assignmentId: "a3", member: "w1", providerId: "p", modelId: "m", error: "boom", updatedAt: NOW - 1000,
      }],
      skippedTeams: [],
    },
  });
  const result = await runUnattendedSweep(deps);

  assert.deepEqual(result, { actions: 1, nudged: 0, failed: 0, notified: 1 });
  assert.deepEqual(deps.calls.delivered, []);
  assert.equal(deps.calls.notified[0].kind, "exhausted");
  assert.ok(deps.calls.written[0].state.manualNeeds["ticket:t1"]);
});

test("an overrunning sweep is not re-entered by the next tick (D3-2)", async () => {
  const deps = makeDeps({ input: { awaitingPlans: [awaitingPlan], failedAssignments: [], skippedTeams: [] } });
  let releaseDeliver;
  // 一轮拖过 60s 的最小复现：deliver 挂起（线上对应复活 lead / 慢 MCP / 慢推送）。
  deps.deliver = (sessionId, message) => new Promise((resolve) => {
    deps.calls.delivered.push({ sessionId, message });
    releaseDeliver = () => resolve({ ok: true });
  });

  const first = runUnattendedSweep(deps);
  // 第一轮还在途（账本尚未落盘），下一个 tick 重入：必须被护栏跳过，
  // 否则会在旧账本上重复决策、向 lead 重复投递同一提醒。
  const second = await runUnattendedSweep(deps);
  assert.deepEqual(second, { actions: 0, nudged: 0, failed: 0, notified: 0 });

  releaseDeliver();
  const result = await first;

  assert.deepEqual(result, { actions: 1, nudged: 1, failed: 0, notified: 0 });
  assert.equal(deps.calls.delivered.length, 1, "护栏生效时不得重复投递同一提醒");
});

test("the in-flight guard clears after a sweep settles, so the next tick runs (D3-2)", async () => {
  const deps = makeDeps({ input: { awaitingPlans: [awaitingPlan], failedAssignments: [], skippedTeams: [] } });
  await runUnattendedSweep(deps);
  assert.equal(deps.calls.delivered.length, 1);

  // 护栏必须已放开：新一轮照常决策（这里给空账本，同一 plan/revision 会照常再提醒——
  // 若护栏卡死不释放，这轮会返回零动作，永久哑火）。
  const again = makeDeps({ input: { awaitingPlans: [awaitingPlan], failedAssignments: [], skippedTeams: [] } });
  const result = await runUnattendedSweep(again);
  assert.deepEqual(result, { actions: 1, nudged: 1, failed: 0, notified: 0 }, "护栏必须释放，不得永久哑火");
  assert.equal(again.calls.delivered.length, 1);
});
