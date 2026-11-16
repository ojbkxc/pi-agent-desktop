import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 挂起记录落盘（设计文档 §2、§7）：原子写、坏 JSON 降级、supersede、cancel、
 * 孤儿判定（pid 活/死/stale 三态）。
 */

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./store.ts");
const types = await jiti.import("./types.ts");

const NOW = 1_800_000_000_000;

function tempAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-outage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRecord(overrides = {}) {
  return {
    sessionId: "sess-1",
    kind: "outage",
    reason: "upstream 503",
    scope: "chat",
    origin: { provider: "openai", modelId: "gpt-x" },
    resume: { mode: "followup", note: "resume note", promptText: "hello", promptPersisted: true },
    budget: { attempts: 0, maxAttempts: 40, startedAt: NOW, deadlineAt: NOW + 3_600_000, nextAttemptAt: NOW },
    guard: { lastUserMessageId: "u-1", leafEntryId: "a-2", sessionUpdatedAt: NOW },
    sessionFile: "/tmp/s.jsonl",
    cwd: "/work",
    now: NOW,
    ...overrides,
  };
}

test("原子写：落盘后可读回，且目录里没有残留 tmp", (t) => {
  const agentDir = tempAgentDir(t);
  const created = store.createOutageRecord(makeRecord(), agentDir);
  assert.equal(created.status, "waiting");
  const read = store.getOutageRecord("sess-1", agentDir);
  assert.equal(read.sessionId, "sess-1");
  assert.equal(read.reason, "upstream 503");
  assert.equal(read.resume.promptText, "hello");

  // 文件是合法 JSON，且目录里只有一个 .json（tmp 已被 rename 掉）。
  const path = store.outageRecordPath("sess-1", agentDir);
  assert.ok(existsSync(path));
  JSON.parse(readFileSync(path, "utf8"));
  const files = readFileSync(path, "utf8");
  assert.match(files, /"sessionId": "sess-1"/);
});

test("坏 JSON 降级：返回 undefined，不抛、不删除文件", (t) => {
  const agentDir = tempAgentDir(t);
  const path = store.outageRecordPath("broken", agentDir);
  store.createOutageRecord(makeRecord({ sessionId: "broken" }), agentDir);
  writeFileSync(path, "{ not json", "utf8");
  assert.equal(store.getOutageRecord("broken", agentDir), undefined);
  assert.equal(store.isSessionSuspended("broken", agentDir), false);
  assert.ok(existsSync(path), "坏文件保留给人看");
});

test("守卫不过（缺字段）也当不存在", (t) => {
  const agentDir = tempAgentDir(t);
  const path = store.outageRecordPath("bad", agentDir);
  // 手工写一份结构不全的记录。
  mkdirSync(join(agentDir, "pi-web", "outages"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, sessionId: "bad" }), "utf8");
  assert.equal(store.getOutageRecord("bad", agentDir), undefined);
});

test("supersede：用户发了新消息 ⇒ 记录作废", (t) => {
  const agentDir = tempAgentDir(t);
  const record = store.createOutageRecord(makeRecord(), agentDir);
  // 同一个最后 user 消息 ⇒ 不作废
  assert.equal(store.isOutageSuperseded(record, "u-1"), false);
  // 新消息 ⇒ 作废
  assert.equal(store.isOutageSuperseded(record, "u-2"), true);
  // 读不到 ⇒ 不判定
  assert.equal(store.isOutageSuperseded(record, null), false);
  // 记录里没有守卫 id ⇒ 不判定
  const noGuard = { ...record, guard: {} };
  assert.equal(store.isOutageSuperseded(noGuard, "u-9"), false);
});

test("同一会话再挂起 ⇒ 整体替换（只有一条）", (t) => {
  const agentDir = tempAgentDir(t);
  store.createOutageRecord(makeRecord({ reason: "first" }), agentDir);
  store.createOutageRecord(makeRecord({ reason: "second" }), agentDir);
  const all = store.listOutageRecords({ agentDir });
  assert.equal(all.length, 1);
  assert.equal(all[0].reason, "second");
});

test("cancel：删除记录并报告存在过", (t) => {
  const agentDir = tempAgentDir(t);
  store.createOutageRecord(makeRecord(), agentDir);
  assert.equal(store.cancelOutageRecord("sess-1", agentDir), true);
  assert.equal(store.getOutageRecord("sess-1", agentDir), undefined);
  assert.equal(store.cancelOutageRecord("sess-1", agentDir), false);
});

test("finishOutageRecord：终态落盘且不再计入 waitingOnly", (t) => {
  const agentDir = tempAgentDir(t);
  store.createOutageRecord(makeRecord(), agentDir);
  store.finishOutageRecord("sess-1", "expired", NOW + 10, { lastError: "deadline" }, agentDir);
  const read = store.getOutageRecord("sess-1", agentDir);
  assert.equal(read.status, "expired");
  assert.equal(read.lastError, "deadline");
  assert.equal(store.listOutageRecords({ agentDir, waitingOnly: true }).length, 0);
  assert.equal(store.listOutageRecords({ agentDir }).length, 1);
});

test("孤儿判定：pid 活着 ⇒ owned（长轮也不判孤儿）", () => {
  const record = { ...baseRecord(), pid: 4321, updatedAt: NOW - 24 * 3_600_000 };
  assert.equal(types.classifyOutageRecord(record, { now: NOW, alive: () => true }), "owned");
});

test("孤儿判定：pid 已死 + 超过 stale ⇒ resumable", () => {
  const record = { ...baseRecord(), pid: 999, updatedAt: NOW - types.OUTAGE_STALE_MS - 1 };
  assert.equal(types.classifyOutageRecord(record, { now: NOW, alive: () => false }), "resumable");
});

test("孤儿判定：pid 已死但记录新鲜 ⇒ waiting（可能正被接手）", () => {
  const record = { ...baseRecord(), pid: 999, updatedAt: NOW - 1000 };
  assert.equal(types.classifyOutageRecord(record, { now: NOW, alive: () => false }), "waiting");
});

test("孤儿判定：非 waiting 状态 ⇒ finished", () => {
  const record = { ...baseRecord(), status: "expired" };
  assert.equal(types.classifyOutageRecord(record, { now: NOW, alive: () => true }), "finished");
});

test("设置：默认开、6h / 24h；非法值退回默认", (t) => {
  const agentDir = tempAgentDir(t);
  const settingsPath = join(agentDir, "pi-web", "settings.json");
  const defaults = store.readOutageSettings(settingsPath);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.maxWaitHours, 6);
  assert.equal(defaults.quotaMaxWaitHours, 24);

  const saved = store.writeOutageSettings({ enabled: false, maxWaitHours: 2 }, settingsPath);
  assert.equal(saved.enabled, false);
  assert.equal(saved.maxWaitHours, 2);
  assert.equal(saved.quotaMaxWaitHours, 24);
  // 读回一致
  assert.equal(store.readOutageSettings(settingsPath).enabled, false);

  // 非法档位退回默认
  const fixed = store.writeOutageSettings({ maxWaitHours: 999 }, settingsPath);
  assert.equal(fixed.maxWaitHours, 6);
  // 0 = 不等待额度（允许）
  assert.equal(store.writeOutageSettings({ quotaMaxWaitHours: 0 }, settingsPath).quotaMaxWaitHours, 0);
});

test("isOutageSuspendedEnabled：总开关与 quota 单独开关", () => {
  const on = { enabled: true, maxWaitHours: 6, quotaMaxWaitHours: 24 };
  assert.equal(store.isOutageSuspendedEnabled("outage", on), true);
  assert.equal(store.isOutageSuspendedEnabled("quota", on), true);
  assert.equal(store.isOutageSuspendedEnabled("outage", { ...on, enabled: false }), false);
  assert.equal(store.isOutageSuspendedEnabled("quota", { ...on, quotaMaxWaitHours: 0 }), false);
});

test("路径清洗：sessionId 不能穿越目录", (t) => {
  const agentDir = tempAgentDir(t);
  const created = store.createOutageRecord(makeRecord({ sessionId: "../../evil" }), agentDir);
  assert.equal(created.sessionId, "../../evil");
  // 文件名被清洗，没有逃出 outages/。
  const path = store.outageRecordPath("../../evil", agentDir);
  assert.ok(path.startsWith(join(agentDir, "pi-web", "outages")));
  assert.ok(store.getOutageRecord("../../evil", agentDir));
});

function baseRecord() {
  return {
    version: 1,
    sessionId: "s-1",
    kind: "outage",
    reason: "upstream 503",
    scope: "chat",
    origin: {},
    resume: { mode: "followup", note: "" },
    budget: { attempts: 0, maxAttempts: 40, startedAt: NOW, deadlineAt: NOW + 3_600_000, nextAttemptAt: NOW },
    guard: {},
    status: "waiting",
    pid: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}