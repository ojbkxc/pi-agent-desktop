import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * Campaign 驱动循环（fake session + fake verify，不碰 SDK / 真进程）。
 *
 * 核心断言：
 * - 逐项推进：每项 verify exit 0 → 全部 done → succeeded；
 * - 判据在引擎侧：模型回合「说做完了」不算，验证 exit 0 才算；
 * - 失败回喂：验证失败 → 下一轮 prompt 带上失败输出尾；
 * - 单项轮次触顶 → 该项 failed → 战役 failed；
 * - Provider 中断 → waiting-provider，且**不消耗轮次**（round / totalRounds 退回）；
 * - resume 从第 K 个非 done 项续；
 * - 成本闸 → paused；战役总轮数闸 → failed。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const store = await jiti.import("./store.ts");
const runner = await jiti.import("./runner.ts");

// resume 的驱动会走真实 rpc-manager；单测里用环境开关禁掉驱动，只验证台账行为。
process.env.PI_WEB_DISABLE_CAMPAIGN_DRIVER = "1";
after(() => { delete process.env.PI_WEB_DISABLE_CAMPAIGN_DRIVER; });

async function tempAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-campaign-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 可控的假会话：send(prompt) 后由测试决定何时发 prompt_done。 */
function makeSession(behavior = () => ({ kind: "ok" })) {
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
      const step = behavior(session.sent.filter((c) => c.type === "prompt").length);
      const kind = typeof step === "string" ? { kind: step } : step;
      if (kind.kind === "hang") return null;
      if (kind.kind === "attention") {
        queueMicrotask(() => session.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Run tests?" }));
        return null;
      }
      queueMicrotask(() => {
        if (kind.kind === "error") {
          session.emit({ type: "prompt_error", errorMessage: kind.error ?? "upstream exploded" });
        } else if (kind.kind === "aborted") {
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

function makeDeps(t, {
  agentDir,
  behaviors = () => ({ kind: "ok" }),
  verifyResults = () => ({ exitCode: 1, timedOut: false, outputTail: "boom", durationMs: 1 }),
  readSessionCost,
  ...rest
} = {}) {
  const sessions = [];
  const prompts = [];
  const verifyCalls = [];
  const deps = {
    agentDir,
    now: () => 1_700_000_000_000 + sessions.length + verifyCalls.length,
    isPidAlive: () => false,
    turnTimeoutMs: 120_000,
    verifyTimeoutMs: 120_000,
    async openSession() {
      const session = makeSession((n) => {
        const outcome = behaviors(n);
        return outcome;
      });
      sessions.push(session);
      return { session, sessionId: `session-${sessions.length}`, created: true };
    },
    async runVerify(command, cwd) {
      verifyCalls.push({ command, cwd });
      return verifyResults(verifyCalls.length);
    },
    ...(readSessionCost ? { readSessionCost } : {}),
    ...rest,
  };
  // 收集每次发出的 prompt 文本，供回喂断言。
  const originalOpen = deps.openSession;
  deps.openSession = async (campaign) => {
    const opened = await originalOpen(campaign);
    const originalSend = opened.session.send.bind(opened.session);
    opened.session.send = async (command) => {
      if (command.type === "prompt") prompts.push(command.message);
      return originalSend(command);
    };
    return opened;
  };
  return { deps, sessions, verifyCalls, prompts };
}

const baseInput = (over = {}) => ({
  objective: "把项目推进到可发布",
  cwd: "/p",
  maxTotalCostUsd: 10,
  items: [{ title: "a", instruction: "do a", verifyCommand: "npm test" }],
  ...over,
});

test("逐项推进：每项 verify exit 0 → 全部 done，战役 succeeded", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, verifyCalls } = makeDeps(t, {
    agentDir,
    verifyResults: () => ({ exitCode: 0, timedOut: false, outputTail: "green", durationMs: 1 }),
  });
  const created = store.createCampaign(baseInput({
    items: [
      { title: "a", instruction: "do a", verifyCommand: "npm run a" },
      { title: "b", instruction: "do b", verifyCommand: "npm run b", dependsOn: ["item-1"] },
    ],
  }), agentDir);

  await runner.runCampaignLoop(created.id, deps);

  const finished = store.getCampaign(created.id, agentDir);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.items.map((item) => item.status), ["done", "done"]);
  assert.equal(finished.totalRounds, 2);
  assert.equal(finished.items[0].round, 1);
  assert.equal(finished.items[1].round, 1);
  assert.equal(finished.pid, null);
  assert.ok(finished.finishedAt);
  assert.deepEqual(verifyCalls.map((call) => call.command), ["npm run a", "npm run b"]);
});

test("失败回喂：验证先失败后通过，下一轮 prompt 带上失败输出尾", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, prompts } = makeDeps(t, {
    agentDir,
    verifyResults: (n) => (n < 2
      ? { exitCode: 1, timedOut: false, outputTail: "AssertionError: expected 1 to equal 2", durationMs: 1 }
      : { exitCode: 0, timedOut: false, outputTail: "", durationMs: 1 }),
  });
  const created = store.createCampaign(baseInput(), agentDir);
  await runner.runCampaignLoop(created.id, deps);

  const finished = store.getCampaign(created.id, agentDir);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.items[0].round, 2);
  assert.deepEqual(finished.items[0].rounds.map((round) => round.status), ["verify-failed", "verify-passed"]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Round 1 of 20/);
  assert.match(prompts[0], /do a/);
  assert.doesNotMatch(prompts[0], /AssertionError/);
  assert.match(prompts[1], /Round 2 of 20/);
  assert.match(prompts[1], /AssertionError: expected 1 to equal 2/);
});

test("单项轮次触顶：item maxRounds 用尽 → 该项 failed → 战役 failed", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, verifyCalls } = makeDeps(t, {
    agentDir,
    verifyResults: () => ({ exitCode: 2, timedOut: false, outputTail: "still broken", durationMs: 1 }),
  });
  const created = store.createCampaign(baseInput({
    items: [{ title: "a", instruction: "do a", verifyCommand: "npm test", maxRounds: 2 }],
  }), agentDir);
  await runner.runCampaignLoop(created.id, deps);

  const finished = store.getCampaign(created.id, agentDir);
  assert.equal(finished.status, "failed");
  assert.equal(finished.items[0].status, "failed");
  assert.equal(finished.items[0].round, 2);
  assert.equal(verifyCalls.length, 2);
  assert.match(finished.items[0].lastError, /exit code 2/);
  assert.equal(finished.items[0].rounds.length, 2);
});

test("Provider 中断：waiting-provider 且不消耗轮次（round / totalRounds 退回）", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, verifyCalls } = makeDeps(t, {
    agentDir,
    behaviors: () => ({ kind: "error", error: "503 Service Unavailable" }),
  });
  const created = store.createCampaign(baseInput(), agentDir);
  await runner.runCampaignLoop(created.id, deps);

  const finished = store.getCampaign(created.id, agentDir);
  assert.equal(finished.status, "waiting-provider");
  assert.equal(finished.totalRounds, 0);
  assert.equal(finished.items[0].round, 0);
  assert.equal(finished.items[0].status, "pending");
  assert.equal(finished.items[0].rounds.length, 0);
  assert.equal(verifyCalls.length, 0);
  assert.equal(finished.pid, null);
});

test("成本闸：spentCostUsd 触及上限 → paused（不静默继续）", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps } = makeDeps(t, {
    agentDir,
    verifyResults: () => ({ exitCode: 0, timedOut: false, outputTail: "", durationMs: 1 }),
    readSessionCost: async () => 10, // = maxTotalCostUsd，首项 done 后即触顶
  });
  const created = store.createCampaign(baseInput({
    maxTotalCostUsd: 10,
    items: [
      { title: "a", instruction: "do a", verifyCommand: "npm run a" },
      { title: "b", instruction: "do b", verifyCommand: "npm run b", dependsOn: ["item-1"] },
    ],
  }), agentDir);
  await runner.runCampaignLoop(created.id, deps);

  const finished = store.getCampaign(created.id, agentDir);
  assert.equal(finished.status, "paused");
  assert.equal(finished.spentCostUsd, 10);
  assert.equal(finished.items[0].status, "done");
  assert.equal(finished.items[1].status, "pending");
});

test("战役总轮数闸：totalRounds 触顶 → failed", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps } = makeDeps(t, {
    agentDir,
    verifyResults: () => ({ exitCode: 0, timedOut: false, outputTail: "", durationMs: 1 }),
  });
  const created = store.createCampaign(baseInput({
    maxTotalRounds: 1,
    items: [
      { title: "a", instruction: "do a", verifyCommand: "npm run a" },
      { title: "b", instruction: "do b", verifyCommand: "npm run b", dependsOn: ["item-1"] },
    ],
  }), agentDir);
  await runner.runCampaignLoop(created.id, deps);

  const finished = store.getCampaign(created.id, agentDir);
  assert.equal(finished.status, "failed");
  assert.equal(finished.totalRounds, 1);
  assert.equal(finished.items[0].status, "done");
  assert.equal(finished.items[1].status, "pending");
});

test("resume 从第 K 个非 done 项续：item-1 done 后选 item-2", async (t) => {
  const agentDir = await tempAgentDir(t);
  const created = store.createCampaign(baseInput({
    items: [
      { title: "a", instruction: "do a", verifyCommand: "true" },
      { title: "b", instruction: "do b", verifyCommand: "true", dependsOn: ["item-1"] },
      { title: "c", instruction: "do c", verifyCommand: "true", dependsOn: ["item-2"] },
    ],
  }), agentDir);
  store.updateCampaign(created.id, (c) => ({
    ...c,
    status: "failed",
    items: c.items.map((item, index) => (index === 0 ? { ...item, status: "done", round: 1 } : item)),
  }), agentDir);

  const resumed = await runner.resumeCampaign(created.id, { agentDir });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.currentItemId, "item-2");
  assert.equal(resumed.finishedAt, null);
  // totalRounds 保留（不白送预算）。
  assert.equal(resumed.totalRounds, 0);
});

test("resume 重试失败项：failed 项重置为 pending 且 round 归零", async (t) => {
  const agentDir = await tempAgentDir(t);
  const created = store.createCampaign(baseInput(), agentDir);
  store.updateCampaign(created.id, (c) => ({
    ...c,
    status: "failed",
    totalRounds: 5,
    items: c.items.map((item) => ({ ...item, status: "failed", round: 5 })),
  }), agentDir);

  const resumed = await runner.resumeCampaign(created.id, { agentDir });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.currentItemId, "item-1");
  assert.equal(resumed.items[0].status, "pending");
  assert.equal(resumed.items[0].round, 0);
  assert.deepEqual(resumed.items[0].rounds, []);
  assert.equal(resumed.totalRounds, 5); // 保留
});

test("stopCampaign → stopped；pauseCampaign → paused", async (t) => {
  const agentDir = await tempAgentDir(t);
  const created = store.createCampaign(baseInput(), agentDir);

  const stopped = await runner.stopCampaign(created.id, { agentDir });
  assert.equal(stopped.status, "stopped");
  assert.ok(stopped.finishedAt);
  assert.equal(stopped.pid, null);

  const paused = await runner.pauseCampaign(created.id, { agentDir });
  assert.equal(paused.status, "paused");
});

test("runCampaignLoop 拒绝另一活进程正在驱动的战役", async (t) => {
  const agentDir = await tempAgentDir(t);
  const { deps, verifyCalls } = makeDeps(t, { agentDir });
  deps.isPidAlive = (pid) => pid === 4242;
  const created = store.createCampaign(baseInput(), agentDir);
  store.updateCampaign(created.id, (c) => ({ ...c, status: "running", pid: 4242 }), agentDir);

  await runner.runCampaignLoop(created.id, deps);
  assert.equal(verifyCalls.length, 0);
  assert.equal(store.getCampaign(created.id, agentDir).pid, 4242);
});

test("sweepCampaigns：孤儿战役 requeue，活 owner 与终态不动", async (t) => {
  const agentDir = await tempAgentDir(t);
  const orphan = store.createCampaign(baseInput({ objective: "orphan" }), agentDir);
  store.updateCampaign(orphan.id, (c) => ({ ...c, status: "running", pid: 4321 }), agentDir);
  const live = store.createCampaign(baseInput({ objective: "live" }), agentDir);
  store.updateCampaign(live.id, (c) => ({ ...c, status: "running", pid: process.pid }), agentDir);
  const done = store.createCampaign(baseInput({ objective: "done" }), agentDir);
  store.updateCampaign(done.id, (c) => ({ ...c, status: "succeeded" }), agentDir);

  const result = await runner.sweepCampaigns({ agentDir, now: 10_000_000 });
  assert.ok(result.resumed.includes(orphan.id));
  assert.equal(result.resumed.includes(live.id), false);
  assert.equal(result.resumed.includes(done.id), false);
  assert.equal(store.getCampaign(orphan.id, agentDir).status, "queued");
  assert.equal(store.getCampaign(orphan.id, agentDir).pid, null);
  assert.equal(store.getCampaign(live.id, agentDir).status, "running");
  assert.equal(store.getCampaign(done.id, agentDir).status, "succeeded");
});
