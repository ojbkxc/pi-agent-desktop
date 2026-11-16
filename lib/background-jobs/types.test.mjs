import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const types = await jiti.import("./types.ts");
const store = await jiti.import("./store.ts");

const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function job(patch = {}) {
  return {
    version: 1,
    id: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-a",
    toolCallId: "call-1",
    command: "npm run build",
    cwd: "/tmp",
    label: "build",
    status: "running",
    startedAt: "2026-11-16T00:00:00.000Z",
    outputPath: "/tmp/job.log",
    outputTruncated: false,
    timeoutSec: 100,
    ...patch,
  };
}

// ── 纯逻辑 ──────────────────────────────────────────────

test("退出码 → 终态：0 是 completed，非 0 与「被信号杀死」都是 failed", () => {
  assert.equal(types.statusFromExit(0, null), "completed");
  assert.equal(types.statusFromExit(1, null), "failed");
  assert.equal(types.statusFromExit(null, "SIGTERM"), "failed");
});

test("超时收敛：非法/非正落到默认，超过硬顶压到硬顶", () => {
  assert.equal(types.clampTimeoutSec(undefined), types.BACKGROUND_JOB_DEFAULT_TIMEOUT_SEC);
  assert.equal(types.clampTimeoutSec(0), types.BACKGROUND_JOB_DEFAULT_TIMEOUT_SEC);
  assert.equal(types.clampTimeoutSec(-5), types.BACKGROUND_JOB_DEFAULT_TIMEOUT_SEC);
  assert.equal(types.clampTimeoutSec("abc"), types.BACKGROUND_JOB_DEFAULT_TIMEOUT_SEC);
  assert.equal(types.clampTimeoutSec(30), 30);
  assert.equal(types.clampTimeoutSec(types.BACKGROUND_JOB_MAX_TIMEOUT_SEC + 1), types.BACKGROUND_JOB_MAX_TIMEOUT_SEC);
});

test("尾部摘要：短输出原样，长输出只留末尾并标注省略量", () => {
  assert.equal(types.jobTail("hello", 100), "hello");
  const long = "a".repeat(150);
  const tailed = types.jobTail(long, 100);
  assert.ok(tailed.includes("已省略"), "must say how much was dropped");
  assert.ok(tailed.endsWith("a".repeat(100)));
  assert.ok(tailed.length < long.length + 60);
});

test("注入正文明确「这是工具输出、不是用户指令」（压缩时不会被当成新目标）", () => {
  const text = types.backgroundJobNotificationText(job({ status: "completed", tail: "build ok" }));
  assert.ok(text.startsWith(types.BACKGROUND_JOB_NOTIFICATION_PREFIX));
  assert.ok(text.includes("build ok"));
  assert.ok(text.includes("/tmp/job.log"), "must point at the full log");
});

test("遗留结算：running → interrupted，终态原样不动", () => {
  const settled = types.settleOrphanedJob(job(), "2026-11-16T01:00:00.000Z");
  assert.equal(settled.status, "interrupted");
  assert.equal(settled.finishedAt, "2026-11-16T01:00:00.000Z");
  assert.equal(types.settleOrphanedJob(job({ status: "completed" }), "2026-11-16T01:00:00.000Z"), null);
});

test("保留策略：终态按时间保留 N 条，running 一律不丢", () => {
  const jobs = [
    job({ id: "a", status: "completed", finishedAt: "2026-11-16T03:00:00.000Z" }),
    job({ id: "b", status: "completed", finishedAt: "2026-11-16T02:00:00.000Z" }),
    job({ id: "c", status: "completed", finishedAt: "2026-11-16T01:00:00.000Z" }),
    job({ id: "d", status: "running" }),
  ];
  assert.deepEqual(types.selectJobsToPrune(jobs, 2), ["c"]);
  assert.deepEqual(types.selectJobsToPrune(jobs, 10), []);
});

// ── 存储 ────────────────────────────────────────────────

test("job id 形状校验挡住路径穿越", () => {
  assert.equal(store.isJobId("11111111-1111-1111-1111-111111111111"), true);
  for (const bad of ["../etc/passwd", "..", "abc", "", null, 42]) {
    assert.equal(store.isJobId(bad), false, JSON.stringify(bad));
  }
});

test("写盘 → 读回往返一致；非法 id 读成 null 而不是拼路径", () => {
  const record = job({ id: "22222222-2222-2222-2222-222222222222", tail: "done" });
  store.writeJob(record, dir);
  assert.deepEqual(store.readJob(record.id, dir), record);
  assert.equal(store.readJob("../../etc/passwd", dir), null);
  assert.equal(store.readJob("33333333-3333-3333-3333-333333333333", dir), null);
});

test("坏记录被跳过，不阻断整张列表", () => {
  const good = job({ id: "44444444-4444-4444-4444-444444444444", status: "completed", finishedAt: "2026-11-16T02:00:00.000Z" });
  store.writeJob(good, dir);
  writeFileSync(join(store.jobsDir(dir), "55555555-5555-5555-5555-555555555555.json"), "{ not json");
  const list = store.listJobs(dir);
  assert.ok(list.some((item) => item.id === good.id));
  assert.ok(list.every((item) => store.isJobId(item.id)));
});

test("输出追加超过上限后停止写入并报截断", () => {
  const id = "66666666-6666-6666-6666-666666666666";
  store.createOutputFile(id, dir);
  assert.equal(store.appendOutput(id, "hello", dir), false);
  assert.equal(store.readOutput(id, dir), "hello");
  // 用一个比上限还大的块：必须只写上限内的部分并返回 true。
  const huge = "x".repeat(types.BACKGROUND_JOB_MAX_OUTPUT_BYTES + 1_000);
  assert.equal(store.appendOutput(id, huge, dir), true);
  assert.ok(Buffer.byteLength(store.readOutput(id, dir), "utf8") <= types.BACKGROUND_JOB_MAX_OUTPUT_BYTES);
  store.forgetOutputBytes(id);
});

test("只读尾部不把整个大文件读进内存", () => {
  const id = "77777777-7777-7777-7777-777777777777";
  store.createOutputFile(id, dir);
  store.appendOutput(id, `${"a".repeat(10_000)}TAIL`, dir);
  const tail = store.readOutput(id, dir, 4);
  assert.equal(tail, "TAIL");
  store.forgetOutputBytes(id);
});

test("遗留结算会真的改写落盘记录", () => {
  // 独立目录：前面的用例故意留下过 running 记录，共用目录会把它们一起结算。
  const own = mkdtempSync(join(tmpdir(), "pi-bgjobs-settle-"));
  try {
    const id = "88888888-8888-8888-8888-888888888888";
    store.writeJob(job({ id }), own);
    const settled = store.settleOrphanedJobs(own);
    assert.equal(settled.length, 1);
    assert.equal(store.readJob(id, own).status, "interrupted");
    assert.deepEqual(store.settleOrphanedJobs(own), [], "second pass is a no-op");
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});