import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentTeamHost, createUnavailableTeamHost } = await jiti.import("./pi-team-host.ts");
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");

// ── 需求4（暂停 → 重新执行）宿主桥回归 ──────────────────────────────────────
// pi-team 的复活链路：team_message → bus → lifecycle.ensureLive → host.revive →
// 本桥 controller.extensionRuntime.resume。这里钉住桥的契约：默认任务文本、
// runInBackground、parentToolCallId 口径、stop 直通 abort、wake 走 __piSessions。

function revivedChildEntries() {
  return [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "lead",
      parentSessionPath: "/tmp/lead.jsonl",
      parentToolCallId: "pi-team:impl",
      profile: "general-purpose",
      description: "old task",
      task: "old task",
      runInBackground: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    // 暂停（release tombstone:false）后的成员：运行被 abort，落盘终态 aborted，sessionFile 保留。
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "aborted", completedAt: "2026-01-01T00:01:00.000Z",
    } },
  ];
}

function reviveFixture({ running = false } = {}) {
  const prompts = [];
  const aborts = [];
  const entries = revivedChildEntries();
  const childInner = {
    sessionId: "child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: {
      getEntries: () => entries,
      appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    },
    prompt: async (task) => { prompts.push(task); },
    getLastAssistantText: () => "resumed and done",
    abort: async () => { aborts.push("child"); },
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => running, waitUntilReady: async () => {} };
  const lead = { inner: { sessionManager: { getSessionId: () => "lead" } }, sessionFile: "/tmp/lead.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => (id === "child" ? child : id === "lead" ? lead : undefined),
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const context = { sessionManager: { getSessionId: () => "lead" } };
  const host = createSubagentTeamHost(controller, { getContext: () => context });
  return { host, prompts, aborts, child };
}

test("revive 复活已停成员：走 resume，带默认续跑任务与 runInBackground（需求4 重新执行链）", async () => {
  const { host, prompts } = reviveFixture();
  const finished = [];
  host.onFinish((handle) => finished.push(handle));

  const handle = await host.revive({ sessionId: "child", name: "impl", description: "复活成员 impl" });

  // 首个句柄：resume 入队返回（execute 同步前缀可能已置 running，只钉会话身份）。
  assert.equal(handle.sessionId, "child");
  assert.ok(["queued", "running"].includes(handle.status), `unexpected initial status: ${handle.status}`);
  // 完成回执经 onFinish 回到 pi-team 生命周期（onRunFinished → idle）。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].sessionId, "child");
  assert.equal(finished[0].status, "completed");
  assert.equal(finished[0].resumed, true);
  // pi-team 的 revive 不带任务文本：桥必须兜底「继续你之前的任务」，成员从保存的会话续跑。
  assert.deepEqual(prompts, ["继续你之前的任务，并把结果回报给团队。"]);
});

test("revive 缺会话上下文：明确报错，不静默（requireContext）", async () => {
  const { host } = reviveFixture();
  const unbound = createSubagentTeamHost(
    { extensionRuntime: {} },
    { getContext: () => undefined },
  );
  await assert.rejects(
    unbound.revive({ sessionId: "child", name: "impl" }),
    /团队宿主尚未绑定会话上下文/,
  );
  assert.ok(host, "fixture sanity");
});

test("stop 直通 controller.abort：运行中的成员被真停（需求4 暂停链的宿主半边）", async () => {
  const { host, aborts } = reviveFixture({ running: true });
  await host.stop("child");
  assert.deepEqual(aborts, ["child"]);
});

test("wake：命中 __piSessions 的存活会话按 followUp 注入；不在表里返回 false", async () => {
  const { host } = reviveFixture();
  const delivered = [];
  const fakeSession = {
    isAlive: () => true,
    isRunning: () => false,
    inner: { sendCustomMessage: async (message, options) => delivered.push({ message, options }) },
  };
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([["child", fakeSession]]);
  try {
    assert.equal(await host.wake({ sessionId: "child", text: "继续处理工单" }), true);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].message.customType, "pi-team:message");
    assert.equal(delivered[0].message.content, "继续处理工单");
    assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });

    assert.equal(await host.wake({ sessionId: "missing", text: "x" }), false, "会话不在注册表 → false，调用方按未投递处理");
  } finally {
    if (previous === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = previous;
  }
});

test("降级桥（内置子 agent 未启用）：start/revive/stop 明确抛错，wake 恒 false", async () => {
  const host = createUnavailableTeamHost();
  await assert.rejects(host.start({ name: "a", profile: "general-purpose", task: "t" }), /内置子 agent/);
  await assert.rejects(host.revive({ sessionId: "s" }), /内置子 agent/);
  await assert.rejects(host.stop("s"), /内置子 agent/);
  assert.equal(await host.wake({ sessionId: "s", text: "x" }), false);
  assert.equal(typeof host.onFinish(() => {}), "function");
});
