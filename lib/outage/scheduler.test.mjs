import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 调度器（设计文档 §3、§7）：假时钟 + 假会话 + 假探针。
 * 断言：前 3 次直接续跑、之后探针、探针失败记账、双闸触顶 expired、
 * supersede、别的进程拥有时不抢、autofix 记录不碰。
 */

const jiti = createJiti(import.meta.url);
const scheduler = await jiti.import("./scheduler.ts");
const store = await jiti.import("./store.ts");

const NOW = 1_800_000_000_000;

function tempAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-outage-sched-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(agentDir, overrides = {}) {
  return store.createOutageRecord({
    sessionId: "s-1",
    kind: "outage",
    reason: "upstream 503",
    scope: "chat",
    origin: { provider: "p", modelId: "m" },
    resume: { mode: "followup", note: "n", promptText: "hi", promptPersisted: true },
    budget: {
      attempts: 0,
      maxAttempts: 40,
      startedAt: NOW,
      deadlineAt: NOW + 6 * 3_600_000,
      nextAttemptAt: NOW,
      ...(overrides.budget ?? {}),
    },
    guard: { lastUserMessageId: "u-1" },
    pid: process.pid,
    now: NOW,
    ...overrides,
  }, agentDir);
}

function fakeSession(sent) {
  return {
    isAlive: () => true,
    isRunning: () => false,
    async send(command) { sent.push(command); return null; },
  };
}

function deps(agentDir, overrides = {}) {
  return {
    now: () => NOW,
    getSession: () => undefined,
    openSession: async () => fakeSession(overrides.sent ?? []),
    probe: async () => true,
    lastUserMessageId: () => "u-1",
    agentDir,
    ...overrides,
  };
}

test("第一次到点：直接发 prompt 续跑（不探针），attempts+1、排下一次", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir);
  const sent = [];
  let probed = 0;
  const actions = await scheduler.runOutageTick(deps(agentDir, {
    sent,
    probe: async () => { probed += 1; return true; },
  }));
  assert.equal(actions[0].outcome, "resumed");
  assert.equal(probed, 0, "前 3 次不探针");
  assert.equal(sent.length, 1);
  // 必须是 prompt 而不是 follow_up：SDK 1.5.0 的空闲会话 followUp 只入队、不启动
  // turn（agent.followUp() 仅 enqueue），而挂起记录产生时 turn 早已结束 ⇒ 发
  // follow_up 会让会话永远等下去。streamingBehavior 保证会话恰好还在跑时也排得进去。
  assert.equal(sent[0].type, "prompt");
  assert.equal(sent[0].streamingBehavior, "followUp");
  assert.match(sent[0].message, /outage/i);

  const record = store.getOutageRecord("s-1", agentDir);
  assert.equal(record.budget.attempts, 1);
  assert.ok(record.budget.nextAttemptAt > NOW);
});

test("第 4 次起先探针：探针失败 ⇒ probe-unavailable、记账、不续跑", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir, { budget: { attempts: 3, maxAttempts: 40, startedAt: NOW, deadlineAt: NOW + 6 * 3_600_000, nextAttemptAt: NOW } });
  const sent = [];
  const actions = await scheduler.runOutageTick(deps(agentDir, {
    sent,
    probe: async () => false,
  }));
  assert.equal(actions[0].outcome, "probe-unavailable");
  assert.equal(sent.length, 0);
  const record = store.getOutageRecord("s-1", agentDir);
  assert.equal(record.budget.attempts, 4);
  assert.equal(record.lastError, "Provider still unavailable");
});

test("第 4 次探针成功 ⇒ 续跑", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir, { budget: { attempts: 3, maxAttempts: 40, startedAt: NOW, deadlineAt: NOW + 6 * 3_600_000, nextAttemptAt: NOW } });
  const sent = [];
  const actions = await scheduler.runOutageTick(deps(agentDir, {
    sent,
    probe: async () => true,
  }));
  assert.equal(actions[0].outcome, "resumed");
  assert.equal(sent.length, 1);
});

test("双闸触顶（attempts 已到 max）⇒ expired", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir, { budget: { attempts: 40, maxAttempts: 40, startedAt: NOW, deadlineAt: NOW + 6 * 3_600_000, nextAttemptAt: NOW } });
  const sent = [];
  const actions = await scheduler.runOutageTick(deps(agentDir, { sent }));
  assert.equal(actions[0].outcome, "expired");
  assert.equal(sent.length, 0);
  assert.equal(store.getOutageRecord("s-1", agentDir).status, "expired");
});

test("死线已到 ⇒ expired", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir, { budget: { attempts: 1, maxAttempts: 40, startedAt: NOW - 10, deadlineAt: NOW - 1, nextAttemptAt: NOW } });
  const actions = await scheduler.runOutageTick(deps(agentDir));
  assert.equal(actions[0].outcome, "expired");
  assert.equal(store.getOutageRecord("s-1", agentDir).status, "expired");
});

test("未到 nextAttemptAt ⇒ skipped-not-due", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir, { budget: { attempts: 1, maxAttempts: 40, startedAt: NOW, deadlineAt: NOW + 6 * 3_600_000, nextAttemptAt: NOW + 60_000 } });
  const actions = await scheduler.runOutageTick(deps(agentDir));
  assert.equal(actions[0].outcome, "skipped-not-due");
});

test("supersede：会话最后 user 消息已变 ⇒ 记录作废、不续跑", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir);
  const sent = [];
  const actions = await scheduler.runOutageTick(deps(agentDir, {
    sent,
    lastUserMessageId: () => "u-NEW",
  }));
  assert.equal(actions[0].outcome, "superseded");
  assert.equal(sent.length, 0);
  assert.equal(store.getOutageRecord("s-1", agentDir).status, "superseded");
});

test("别的活进程拥有 ⇒ skipped-other-process，不动记录", async (t) => {
  const agentDir = tempAgentDir(t);
  // pid 是别的进程，且「活着」
  seed(agentDir, { pid: 424242 });
  const sent = [];
  const actions = await scheduler.runOutageTick({
    ...deps(agentDir, { sent }),
    // classifyOutageRecord 用真实 process.kill；这里 pid 424242 大概率不存在，
    // 但为了确定性，让 getSession 返回 running 的假会话会走 skipped-busy 分支，
    // 所以直接用一个不存在的 pid + 新鲜 updatedAt ⇒ waiting ⇒ skipped-owned。
  });
  // 该 pid 不存在且记录新鲜 ⇒ waiting ⇒ skipped-owned（不是本进程拥有）。
  assert.equal(actions[0].outcome, "skipped-owned");
  assert.equal(sent.length, 0);
});

test("会话正在跑 ⇒ skipped-busy", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir, { pid: process.pid });
  const actions = await scheduler.runOutageTick(deps(agentDir, {
    getSession: () => ({ isAlive: () => true, isRunning: () => true, send: async () => null }),
  }));
  assert.equal(actions[0].outcome, "skipped-busy");
});

test("scope=autofix 的记录：调度器只读不驱动", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir, { scope: "autofix" });
  const sent = [];
  const actions = await scheduler.runOutageTick(deps(agentDir, { sent }));
  assert.equal(actions[0].outcome, "skipped-autofix");
  assert.equal(sent.length, 0);
  assert.equal(store.getOutageRecord("s-1", agentDir).status, "waiting");
});

test("openSession 抛错 ⇒ resume-error、记账、保留等待", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir);
  const actions = await scheduler.runOutageTick(deps(agentDir, {
    openSession: async () => { throw new Error("session file gone"); },
  }));
  assert.equal(actions[0].outcome, "resume-error");
  const record = store.getOutageRecord("s-1", agentDir);
  assert.equal(record.status, "waiting");
  assert.equal(record.budget.attempts, 1);
  assert.equal(record.lastError, "session file gone");
});

test("设置关闭 ⇒ 不推进任何记录", async (t) => {
  const agentDir = tempAgentDir(t);
  seed(agentDir);
  store.writeOutageSettings({ enabled: false }, join(agentDir, "pi-web", "settings.json"));
  const sent = [];
  const actions = await scheduler.runOutageTick(deps(agentDir, { sent }));
  assert.deepEqual(actions, []);
  assert.equal(sent.length, 0);
  assert.equal(store.getOutageRecord("s-1", agentDir).status, "waiting");
});