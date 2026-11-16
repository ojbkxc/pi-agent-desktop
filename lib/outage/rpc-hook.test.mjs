import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * rpc-hook：一次 agent_settled 的失败分类 → 建/不建挂起记录（设计文档 §7）。
 *
 * 注入 `agentDir` 与 `sessionFile`，不碰真实 ~/.pi；设置写进同一个临时 agent dir，
 * 所以「设置关闭」用例不依赖本机配置。
 */

const jiti = createJiti(import.meta.url);
const hook = await jiti.import("./rpc-hook.ts");
const store = await jiti.import("./store.ts");

const NOW = 1_800_000_000_000;

function tempAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-outage-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSessionFile(dir, sessionId, entries) {
  const file = join(dir, `${sessionId}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: sessionId, timestamp: new Date(NOW).toISOString(), cwd: "/work" },
    ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(file, lines, "utf8");
  return file;
}

function userEntry(id, text) {
  return { type: "message", id, parentId: null, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantEntry(id, parentId, { stopReason, errorMessage, provider, model }) {
  return {
    type: "message",
    id,
    parentId,
    message: {
      role: "assistant",
      content: [],
      provider,
      model,
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    },
  };
}

async function settled(agentDir, sessionFile, outcome, extra = {}) {
  return hook.onAgentRunSettled({
    sessionId: "sess-hook",
    outcome,
    sessionFile,
    cwd: "/work",
    agentDir,
    now: NOW,
    ...extra,
  });
}

test("outage 类失败 ⇒ 建记录，status=waiting，origin 从会话尾部 assistant 推断", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [
    userEntry("u-1", "fix the build"),
    assistantEntry("a-1", "u-1", { stopReason: "error", errorMessage: "upstream 503 service unavailable", provider: "zenmux", model: "claude-x" }),
  ]);

  const result = await settled(agentDir, sessionFile, { status: "failed", error: "upstream 503 service unavailable" });
  assert.equal(result.suspended, true);
  assert.equal(result.kind, "outage");

  const record = store.getOutageRecord("sess-hook", agentDir);
  assert.ok(record, "记录已落盘");
  assert.equal(record.status, "waiting");
  assert.equal(record.kind, "outage");
  assert.equal(record.origin.provider, "zenmux");
  assert.equal(record.origin.modelId, "claude-x");
  assert.equal(record.guard.lastUserMessageId, "u-1");
  assert.equal(record.resume.promptText, "fix the build");
  assert.equal(record.resume.promptPersisted, true);
  // 不是「失败」：lastRunOutcome 由 rpc-manager 自己维护，hook 不改它。
});

test("aborted ⇒ 不建记录", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [userEntry("u-1", "hi")]);
  const result = await settled(agentDir, sessionFile, { status: "failed", error: "upstream 503" }, { aborted: true });
  assert.equal(result.suspended, false);
  assert.equal(store.getOutageRecord("sess-hook", agentDir), undefined);
});

test("terminal（401）⇒ 不建记录", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [userEntry("u-1", "hi")]);
  const result = await settled(agentDir, sessionFile, { status: "failed", error: "401 Unauthorized: invalid api key" });
  assert.equal(result.suspended, false);
  assert.equal(result.kind, "terminal");
  assert.equal(store.getOutageRecord("sess-hook", agentDir), undefined);
});

test("transient（429 短限流）⇒ 不建记录", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [userEntry("u-1", "hi")]);
  const result = await settled(agentDir, sessionFile, { status: "failed", error: "429 Too Many Requests" });
  assert.equal(result.suspended, false);
  assert.equal(store.getOutageRecord("sess-hook", agentDir), undefined);
});

test("done ⇒ 不建记录", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [userEntry("u-1", "hi")]);
  const result = await settled(agentDir, sessionFile, { status: "done" });
  assert.equal(result.suspended, false);
  assert.equal(store.getOutageRecord("sess-hook", agentDir), undefined);
});

test("设置关闭 ⇒ 不建记录", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [userEntry("u-1", "hi")]);
  store.writeOutageSettings({ enabled: false }, join(agentDir, "pi-web", "settings.json"));
  const result = await settled(agentDir, sessionFile, { status: "failed", error: "upstream 503" });
  assert.equal(result.suspended, false);
  assert.equal(store.getOutageRecord("sess-hook", agentDir), undefined);
});

test("已有等待记录 + 再次 outage ⇒ 回等待，不新建（attempts 不重复计）", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [
    userEntry("u-1", "go"),
    assistantEntry("a-1", "u-1", { stopReason: "error", errorMessage: "502 bad gateway" }),
  ]);
  await settled(agentDir, sessionFile, { status: "failed", error: "502 bad gateway" });
  const first = store.getOutageRecord("sess-hook", agentDir);
  assert.ok(first);

  const result = await settled(agentDir, sessionFile, { status: "failed", error: "stream was interrupted" });
  assert.equal(result.suspended, true);
  const second = store.getOutageRecord("sess-hook", agentDir);
  assert.equal(second.status, "waiting");
  assert.equal(second.budget.attempts, first.budget.attempts, "hook 不推进 attempts");
});

test("已有等待记录 + terminal ⇒ 判 failed，收起记录", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [userEntry("u-1", "go")]);
  await settled(agentDir, sessionFile, { status: "failed", error: "upstream 503" });
  const result = await settled(agentDir, sessionFile, { status: "failed", error: "401 Unauthorized" });
  assert.equal(result.suspended, false);
  const record = store.getOutageRecord("sess-hook", agentDir);
  assert.equal(record.status, "failed");
});

test("retryOutageNow / cancelOutage / isSessionWaitingForProvider", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionFile = writeSessionFile(agentDir, "sess-hook", [userEntry("u-1", "go")]);
  await settled(agentDir, sessionFile, { status: "failed", error: "upstream 503" });

  assert.equal(hook.isSessionWaitingForProvider("sess-hook", agentDir), true);
  assert.equal(hook.countWaitingOutages(agentDir), 1);

  assert.equal(hook.retryOutageNow("sess-hook", NOW + 5_000, agentDir), true);
  const due = store.getOutageRecord("sess-hook", agentDir);
  assert.equal(due.budget.nextAttemptAt, NOW + 5_000);

  assert.equal(hook.cancelOutage("sess-hook", agentDir), true);
  assert.equal(hook.isSessionWaitingForProvider("sess-hook", agentDir), false);
});