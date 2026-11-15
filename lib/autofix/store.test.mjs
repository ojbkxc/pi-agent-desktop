import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 「自动修 Bug」落盘 + 纯判定（孤儿/汇总）+ 验证命令探测。
 *
 * 全部走临时 agentDir，不碰真实 ~/.pi/agent。孤儿口径与 keepalive 约定：
 * pid 活着 ⇒ 永不孤儿；pid 死亡 ⇒ 立即孤儿；pid 缺失 ⇒ 只有 queued 或超时才孤儿。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const store = await jiti.import("./store.ts");
const types = await jiti.import("./types.ts");
const detect = await jiti.import("./detect.ts");

const baseInput = (over = {}) => ({
  task: "这个 bug 不修好，CI 过不去",
  cwd: "/tmp/project",
  verifyCommand: "npm test",
  ...over,
});

async function tempDir(t, label = "pi-web-autofix-store-") {
  const dir = await mkdtemp(join(tmpdir(), label));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("createAutofixTask writes a queued task and lists it", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createAutofixTask(baseInput({ maxRounds: 7 }), agentDir);

  assert.equal(created.version, 1);
  assert.match(created.id, /^[0-9a-f-]{36}$/i);
  assert.equal(created.status, "queued");
  assert.equal(created.round, 0);
  assert.equal(created.maxRounds, 7);
  assert.equal(created.lastError, null);
  assert.equal(created.sessionId, null);
  assert.equal(created.pid, null);
  assert.equal(created.finishedAt, null);
  assert.deepEqual(created.rounds, []);
  assert.ok(created.createdAt > 0);

  const raw = JSON.parse(await readFile(join(agentDir, "autofix", "tasks", `${created.id}.json`), "utf8"));
  assert.equal(raw.task, baseInput().task);

  const listed = store.listAutofixTasks(agentDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.deepEqual(store.getAutofixTask(created.id, agentDir), created);
});

test("createAutofixTask validates every input with an i18n key", async (t) => {
  const agentDir = await tempDir(t);
  const reject = (input, key) => assert.throws(
    () => store.createAutofixTask(input, agentDir),
    (error) => error.name === "AutofixValidationError" && error.key === key,
  );
  reject(baseInput({ task: "   " }), "autofix.error.taskRequired");
  reject(baseInput({ task: "x".repeat(types.AUTOFIX_TASK_MAX_LENGTH + 1) }), "autofix.error.taskTooLong");
  reject(baseInput({ cwd: "" }), "autofix.error.cwdRequired");
  reject(baseInput({ verifyCommand: "  " }), "autofix.error.verifyRequired");
  // 尾部空白会被 trim 掉，用中间带内容的超长命令来撞长度闸。
  reject(baseInput({ verifyCommand: `npm test ${"x".repeat(types.AUTOFIX_VERIFY_MAX_LENGTH)}` }), "autofix.error.verifyTooLong");
  reject(baseInput({ maxRounds: 0 }), "autofix.error.maxRoundsRange");
  reject(baseInput({ maxRounds: types.AUTOFIX_MAX_ROUNDS + 1 }), "autofix.error.maxRoundsRange");
  reject(baseInput({ maxRounds: 2.5 }), "autofix.error.maxRoundsRange");
  assert.equal(store.listAutofixTasks(agentDir).length, 0);
});

test("list skips corrupt files without deleting them", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createAutofixTask(baseInput(), agentDir);
  const corrupt = join(agentDir, "autofix", "tasks", "00000000-0000-4000-8000-000000000000.json");
  await writeFile(corrupt, "{not json", "utf8");
  const bogus = join(agentDir, "autofix", "tasks", "not-a-uuid.json");
  await writeFile(bogus, "{}", "utf8");

  const listed = store.listAutofixTasks(agentDir);
  assert.deepEqual(listed.map((task) => task.id), [created.id]);
  assert.equal(store.getAutofixTask("00000000-0000-4000-8000-000000000000", agentDir), undefined);
  assert.equal(store.getAutofixTask("../escape", agentDir), undefined);
  // Corrupt file survives (a newer build may understand it).
  assert.equal(await readFile(corrupt, "utf8"), "{not json");
});

test("updateAutofixTask caps the round history and touches updatedAt", async (t) => {
  const agentDir = await tempDir(t);
  const created = store.createAutofixTask(baseInput(), agentDir);
  const rounds = Array.from({ length: types.AUTOFIX_MAX_ROUND_RECORDS + 5 }, (_, index) => ({
    round: index + 1,
    at: 1000 + index,
    status: "verify-failed",
    verifyExitCode: 1,
    error: `e${index + 1}`,
  }));
  const updated = store.updateAutofixTask(created.id, (task) => ({ ...task, rounds }), agentDir);
  assert.equal(updated.rounds.length, types.AUTOFIX_MAX_ROUND_RECORDS);
  // Oldest records dropped, newest kept.
  assert.equal(updated.rounds[0].round, 6);
  assert.equal(updated.rounds.at(-1).round, types.AUTOFIX_MAX_ROUND_RECORDS + 5);
});

test("isAutofixTaskResumable follows the keepalive contract", () => {
  const task = (over) => ({
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    task: "t",
    cwd: "/p",
    verifyCommand: "npm test",
    status: "running",
    round: 1,
    maxRounds: 20,
    lastError: null,
    sessionId: null,
    pid: null,
    createdAt: 1,
    updatedAt: 1_000,
    finishedAt: null,
    rounds: [],
    ...over,
  });
  const alive = () => true;
  const dead = () => false;
  const now = 10_000_000;

  // pid alive -> never orphan, even if updatedAt is ancient.
  assert.equal(types.isAutofixTaskResumable(task({ pid: 123, updatedAt: 0 }), { now, isPidAlive: alive }), false);
  // pid dead -> resumable at once.
  assert.equal(types.isAutofixTaskResumable(task({ pid: 123, updatedAt: now }), { now, isPidAlive: dead }), true);
  // queued + no pid -> resumable at once (waiting for a driver).
  assert.equal(types.isAutofixTaskResumable(task({ status: "queued", pid: null, updatedAt: now }), { now, isPidAlive: alive }), true);
  // running + no pid -> only once stale.
  assert.equal(types.isAutofixTaskResumable(task({ pid: null, updatedAt: now }), { now, isPidAlive: alive }), false);
  assert.equal(
    types.isAutofixTaskResumable(task({ pid: null, updatedAt: now - types.AUTOFIX_STALE_MS - 1 }), { now, isPidAlive: alive }),
    true,
  );
  // terminal states are never resumed.
  for (const status of ["succeeded", "failed", "exhausted", "stopped"]) {
    assert.equal(types.isAutofixTaskResumable(task({ status, pid: null }), { now, isPidAlive: dead }), false);
  }
});

test("summarizeAutofixTaskList counts active/stuck/succeeded/failed", () => {
  const make = (status, over = {}) => ({
    version: 1,
    id: "00000000-0000-4000-8000-000000000002",
    task: "t",
    cwd: "/p",
    verifyCommand: "npm test",
    status,
    round: 0,
    maxRounds: 20,
    lastError: null,
    sessionId: null,
    pid: null,
    createdAt: 1,
    updatedAt: 10_000_000,
    finishedAt: null,
    rounds: [],
    ...over,
  });
  const summary = types.summarizeAutofixTaskList([
    make("queued"),
    make("running", { pid: process.pid }),
    make("succeeded"),
    make("failed"),
    make("exhausted"),
    make("stopped"),
  ], { now: 10_000_000, isPidAlive: (pid) => pid === process.pid });
  assert.deepEqual(summary, { total: 6, active: 2, stuck: 1, succeeded: 1, failed: 2 });
});

test("detectVerifyCommandFromPackage prefers test, then typecheck/check/lint", () => {
  assert.equal(detect.detectVerifyCommandFromPackage({ scripts: { test: "node --test" } }), "npm test");
  assert.equal(detect.detectVerifyCommandFromPackage({ scripts: { lint: "eslint .", typecheck: "tsc" } }), "npm run typecheck");
  assert.equal(detect.detectVerifyCommandFromPackage({ scripts: { check: "x", lint: "y" } }), "npm run check");
  assert.equal(detect.detectVerifyCommandFromPackage({ scripts: { lint: "eslint ." } }), "npm run lint");
  assert.equal(detect.detectVerifyCommandFromPackage({ scripts: { build: "next build" } }), null);
  assert.equal(detect.detectVerifyCommandFromPackage({}), null);
  assert.equal(detect.detectVerifyCommandFromPackage(null), null);
  assert.equal(detect.detectVerifyCommandFromPackage([]), null);
});

test("detectVerifyCommand reads the package.json in the directory", async (t) => {
  const dir = await tempDir(t, "pi-web-autofix-detect-");
  assert.equal(detect.detectVerifyCommand(dir), null);
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  assert.equal(detect.detectVerifyCommand(dir), "npm test");
  await writeFile(join(dir, "package.json"), "{broken", "utf8");
  assert.equal(detect.detectVerifyCommand(dir), null);
});
