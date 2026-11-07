import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const store = await jiti.import("./agent-teams-unattended-store.ts");
const { collectUnattendedInput, readUnattendedFile, writeUnattendedFile, writeUnattendedState, sanitizeTeamName, unattendedSettingsPath } = store;

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
