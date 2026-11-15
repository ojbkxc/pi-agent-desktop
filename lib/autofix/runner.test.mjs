import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 自动修 Bug 的驱动循环（fake session + fake verify，不碰 SDK / 真进程）。
 *
 * 核心断言：
 * - 判据在引擎侧：模型回合「说修好了」不算，验证 exit 0 才落 succeeded；
 * - 验证失败 → 下一轮 prompt 带上失败输出尾；
 * - 撞 maxRounds → exhausted；用户 stop → stopped；
 * - 孤儿接续：pid 死 / queued 无主 → resumeAutofixTasks 接管；
 * - 认证复核：另一活的进程正在驱动 ⇒ 放弃。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const store = await jiti.import("./store.ts");
const runner = await jiti.import("./runner.ts");

// resume 的驱动会走真实 rpc-manager；单测里用环境开关禁掉驱动，只验证台账行为。
process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER = "1";
after(() => { delete process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER; });

async function tempAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-autofix-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 可控的假会话：send(prompt) 后由测试决定何时发 prompt_done。 */
function makeSession(behavior = () => "ok") {
  const listeners = new Set();
  const session = {
    events: [],
    sent: [],
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(command) {
      session.sent.push(command);
      if (command.type !== "prompt") return null;
      const kind = behavior(session.sent.filter((c) => c.type === "prompt").length);
      if (kind === "hang") return null;
      if (kind === "attention") {
        queueMicrotask(() => session.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Run tests?" }));
        return null;
      }
      queueMicrotask(() => {
        if (kind === "error") {
          session.emit({ type: "prompt_error", errorMessage: "upstream exploded" });
        } else if (kind === "aborted") {
          session.emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
        } else {
          session.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        }
        session.emit({ type: "prompt_done" });
      });
      return null;
    },
  };
  return session;
}

function makeDeps(t, { agentDir, behaviors = () => "ok", verifyResults = () => ({ exitCode: 1, timedOut: false, outputTail: "boom", durationMs: 1 }), ...rest } = {}) {
  const sessions = [];
  const verifyCalls = [];
  let promptCount = 0;
  const deps = {
    agentDir,
    now: () => 1_700_000_000_000 + sessions.length + verifyCalls.length,
    isPidAlive: () => false,
    turnTimeoutMs: 120_000,
    verifyTimeoutMs: 120_000,
    async openSession(task) {
      // 计数跨会话累加：循环每一轮都会（重新）打开会话，per-session 计数恒为 1。
      const session = makeSession(() => behaviors((promptCount += 1), task));
      session.sent = [];
      sessions.push(session);
      return { session, sessionId: `session-${sessions.length}`, created: true };
    },
    async runVerify(command, cwd) {
      verifyCalls.push({ command, cwd });
      return verifyResults(verifyCalls.length);
    },
    ...rest,
  };
  return { deps, sessions, verifyCalls };
}

test("loop stops as soon as the harness verification passes, not when the model says so", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, verifyCalls } = makeDeps(t, {
    agentDir,
    verifyResults: (n) => (n < 3
      ? { exitCode: 1, timedOut: false, outputTail: `failure ${n}`, durationMs: 1 }
      : { exitCode: 0, timedOut: false, outputTail: "all green", durationMs: 1 }),
  });
  const created = store.createAutofixTask({ task: "fix it", cwd: "/p", verifyCommand: "npm test", maxRounds: 10 }, agentDir);

  await runner.driveAutofixTask(created.id, deps);

  const finished = store.getAutofixTask(created.id, agentDir);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.round, 3);
  assert.equal(finished.pid, null);
  assert.ok(finished.finishedAt);
  assert.deepEqual(verifyCalls.map((call) => call.command), ["npm test", "npm test", "npm test"]);
  assert.deepEqual(finished.rounds.map((round) => round.status), ["verify-failed", "verify-failed", "verify-passed"]);
  assert.deepEqual(finished.rounds.map((round) => round.verifyExitCode), [1, 1, 0]);
});

test("a failing verification feeds its own output tail into the next round", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, sessions } = makeDeps(t, {
    agentDir,
    verifyResults: (n) => (n < 2
      ? { exitCode: 1, timedOut: false, outputTail: "AssertionError: expected 1 to equal 2", durationMs: 1 }
      : { exitCode: 0, timedOut: false, outputTail: "", durationMs: 1 }),
  });
  const created = store.createAutofixTask({ task: "fix the assertion", cwd: "/p", verifyCommand: "npm test", maxRounds: 5 }, agentDir);
  await runner.driveAutofixTask(created.id, deps);

  const prompts = sessions.flatMap((session) => session.sent.filter((c) => c.type === "prompt").map((c) => c.message));
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Round 1 of 5/);
  assert.match(prompts[0], /fix the assertion/);
  assert.doesNotMatch(prompts[0], /AssertionError/);
  assert.match(prompts[1], /Round 2 of 5/);
  assert.match(prompts[1], /AssertionError: expected 1 to equal 2/);
});

test("hitting maxRounds records exhausted with the last failure", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, verifyCalls } = makeDeps(t, {
    agentDir,
    verifyResults: () => ({ exitCode: 2, timedOut: false, outputTail: "still broken", durationMs: 1 }),
  });
  const created = store.createAutofixTask({ task: "never fixed", cwd: "/p", verifyCommand: "npm test", maxRounds: 3 }, agentDir);
  await runner.driveAutofixTask(created.id, deps);

  const finished = store.getAutofixTask(created.id, agentDir);
  assert.equal(finished.status, "exhausted");
  assert.equal(finished.round, 3);
  assert.equal(verifyCalls.length, 3);
  assert.match(finished.lastError, /exit code 2/);
  assert.equal(finished.rounds.length, 3);
});

test("an agent error is recorded and the loop retries the next round", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps } = makeDeps(t, {
    agentDir,
    behaviors: (n) => (n === 1 ? "error" : "ok"),
    verifyResults: () => ({ exitCode: 0, timedOut: false, outputTail: "", durationMs: 1 }),
  });
  const created = store.createAutofixTask({ task: "flaky model", cwd: "/p", verifyCommand: "npm test", maxRounds: 5 }, agentDir);
  await runner.driveAutofixTask(created.id, deps);

  const finished = store.getAutofixTask(created.id, agentDir);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.rounds.map((round) => round.status), ["agent-error", "verify-passed"]);
  assert.match(finished.rounds[0].error, /upstream exploded/);
});

test("a blocking extension dialog stops the run instead of hanging", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps } = makeDeps(t, { agentDir, behaviors: () => "attention" });
  const created = store.createAutofixTask({ task: "asks a question", cwd: "/p", verifyCommand: "npm test", maxRounds: 5 }, agentDir);
  await runner.driveAutofixTask(created.id, deps);

  const finished = store.getAutofixTask(created.id, agentDir);
  assert.equal(finished.status, "stopped");
  assert.match(finished.lastError, /waiting for an answer/);
});

test("an aborted turn means stopped, not a failure round", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps } = makeDeps(t, { agentDir, behaviors: () => "aborted" });
  const created = store.createAutofixTask({ task: "user hits stop", cwd: "/p", verifyCommand: "npm test", maxRounds: 5 }, agentDir);
  await runner.driveAutofixTask(created.id, deps);

  const finished = store.getAutofixTask(created.id, agentDir);
  assert.equal(finished.status, "stopped");
  assert.equal(finished.rounds.length, 0);
});

test("drive refuses a task another live process is running", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, verifyCalls } = makeDeps(t, { agentDir });
  deps.isPidAlive = (pid) => pid === 4242;
  const created = store.createAutofixTask({ task: "someone else owns it", cwd: "/p", verifyCommand: "npm test" }, agentDir);
  store.updateAutofixTask(created.id, (task) => ({ ...task, status: "running", pid: 4242 }), agentDir);

  await runner.driveAutofixTask(created.id, deps);
  assert.equal(verifyCalls.length, 0);
  assert.equal(store.getAutofixTask(created.id, agentDir).pid, 4242);
});

test("a dead owner's task is claimed, a terminal task is left alone", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, verifyCalls } = makeDeps(t, {
    agentDir,
    verifyResults: () => ({ exitCode: 0, timedOut: false, outputTail: "", durationMs: 1 }),
  });
  deps.isPidAlive = () => false;
  const created = store.createAutofixTask({ task: "orphan", cwd: "/p", verifyCommand: "npm test", maxRounds: 2 }, agentDir);
  store.updateAutofixTask(created.id, (task) => ({ ...task, status: "running", pid: 999_999 }), agentDir);

  await runner.driveAutofixTask(created.id, deps);
  assert.equal(store.getAutofixTask(created.id, agentDir).status, "succeeded");
  assert.equal(verifyCalls.length, 1);

  const done = store.createAutofixTask({ task: "already done", cwd: "/p", verifyCommand: "npm test" }, agentDir);
  store.updateAutofixTask(done.id, (task) => ({ ...task, status: "succeeded" }), agentDir);
  await runner.driveAutofixTask(done.id, deps);
  assert.equal(verifyCalls.length, 1);
});

test("resumeAutofixTasks requeues orphans and is idempotent", async (t) => {
  const agentDir = await tempAgentDir(t);
  const created = store.createAutofixTask({ task: "orphan me", cwd: "/p", verifyCommand: "npm test" }, agentDir);
  store.updateAutofixTask(created.id, (task) => ({ ...task, status: "running", pid: 4321 }), agentDir);

  const first = await runner.resumeAutofixTasks({ agentDir, now: 10_000_000 });
  assert.equal(first.examined, 1);
  assert.deepEqual(first.resumed, [created.id]);
  const requeued = store.getAutofixTask(created.id, agentDir);
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.pid, null);

  // Already queued with no pid: still "resumable" (waits for a driver), but a
  // second call must not duplicate anything beyond the same single id.
  const second = await runner.resumeAutofixTasks({ agentDir, now: 10_000_000 });
  assert.deepEqual(second.resumed, [created.id]);
});

test("resumeAutofixTasks leaves live-owner and terminal tasks untouched", async (t) => {
  const agentDir = await tempAgentDir(t);
  const live = store.createAutofixTask({ task: "live", cwd: "/p", verifyCommand: "npm test" }, agentDir);
  store.updateAutofixTask(live.id, (task) => ({ ...task, status: "running", pid: process.pid }), agentDir);
  const done = store.createAutofixTask({ task: "done", cwd: "/p", verifyCommand: "npm test" }, agentDir);
  store.updateAutofixTask(done.id, (task) => ({ ...task, status: "succeeded" }), agentDir);

  const result = await runner.resumeAutofixTasks({ agentDir, now: 10_000_000 });
  assert.deepEqual(result.resumed, []);
  assert.equal(store.getAutofixTask(live.id, agentDir).status, "running");
  assert.equal(store.getAutofixTask(done.id, agentDir).status, "succeeded");
});

test("summarizeAutofixTasks reads an empty directory as all zeros", async (t) => {
  const agentDir = await tempAgentDir(t);
  const empty = await runner.summarizeAutofixTasks({ agentDir });
  assert.deepEqual(empty, { total: 0, active: 0, stuck: 0, succeeded: 0, failed: 0 });
});

test("stopAutofixTask lands stopped with finishedAt and clears pid", async (t) => {
  const agentDir = await tempAgentDir(t);
  const created = store.createAutofixTask({ task: "stop me", cwd: "/p", verifyCommand: "npm test" }, agentDir);
  const stopped = await runner.stopAutofixTask(created.id, { agentDir });
  assert.equal(stopped.status, "stopped");
  assert.ok(stopped.finishedAt);
  assert.equal(stopped.pid, null);
});

test("resumeAutofixTask gives a fresh budget (round 0) and keeps succeeded tasks alone", async (t) => {
  const agentDir = await tempAgentDir(t);
  const created = store.createAutofixTask({ task: "retry me", cwd: "/p", verifyCommand: "npm test" }, agentDir);
  store.updateAutofixTask(created.id, (task) => ({
    ...task,
    status: "exhausted",
    round: 20,
    rounds: [{ round: 20, at: 1, status: "verify-failed", verifyExitCode: 1 }],
  }), agentDir);
  // Driver disabled by env in tests, so resume only rewrites the record.
  process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER = "1";
  t.after(() => { delete process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER; });
  const resumed = await runner.resumeAutofixTask(created.id, { agentDir });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.round, 0);
  assert.deepEqual(resumed.rounds, []);
  assert.equal(resumed.finishedAt, null);
});