import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// runtime 会懒加载 rpc-manager 去投递完成通知；在单测里我们只关心进程与落盘，
// 所以把投递目标造成「会话不存在」，通知路径会安静地打一行 warn 后返回。
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-bgjobs-runtime-agent-"));
const dir = mkdtempSync(join(tmpdir(), "pi-bgjobs-runtime-"));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const store = await jiti.import("./store.ts");
const runtime = await jiti.import("./runtime.ts");

after(() => {
  runtime.stopAllBackgroundJobs();
  // Windows 上子进程句柄可能还没完全释放，EPERM 不该让整个测试文件报错。
  for (const path of [dir, process.env.PI_CODING_AGENT_DIR]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // 临时目录，留给系统清理。
    }
  }
});

/** 轮询到终态，带一个硬上限——单测不能永远等。 */
async function waitTerminal(id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = store.readJob(id);
    if (job && job.status !== "running") return job;
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("启动即返回：execute 不等命令跑完", () => {
  const startedAt = Date.now();
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-1",
    command: "echo hello",
    cwd: dir,
    label: "echo",
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(job.status, "running");
  assert.ok(elapsed < 5_000, `start must return immediately, took ${elapsed}ms`);
});

test("命令跑完：输出落盘、终态为 completed、exitCode 为 0", async () => {
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-2",
    command: "echo hello-from-background",
    cwd: dir,
    label: "echo",
  });
  const done = await waitTerminal(job.id);
  assert.equal(done.status, "completed");
  assert.equal(done.exitCode, 0);
  assert.ok(done.finishedAt);
  const output = readFileSync(done.outputPath, "utf8");
  assert.ok(output.includes("hello-from-background"), output);
  assert.ok((done.tail ?? "").includes("hello-from-background"), "tail must carry the output for the notification");
});

test("非 0 退出 → failed，且错误码一并记下", async () => {
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-3",
    command: "exit 7",
    cwd: dir,
    label: "exit 7",
  });
  const done = await waitTerminal(job.id);
  assert.equal(done.status, "failed");
  assert.equal(done.exitCode, 7);
});

test("stdout 与 stderr 都进同一个输出文件", async () => {
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-4",
    command: "echo to-stdout; echo to-stderr 1>&2",
    cwd: dir,
    label: "both",
  });
  const done = await waitTerminal(job.id);
  const output = readFileSync(done.outputPath, "utf8");
  assert.ok(output.includes("to-stdout"), output);
  assert.ok(output.includes("to-stderr"), output);
});

test("stop 会真的杀掉长任务，终态是 stopped 而不是 completed", async () => {
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-5",
    command: process.platform === "win32" ? "ping -n 60 127.0.0.1" : "sleep 60",
    cwd: dir,
    label: "long",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runtime.isJobActive(job.id), true, "job should still be running");
  const stopped = runtime.stopBackgroundJob(job.id);
  assert.equal(stopped?.status, "stopped");
  assert.equal(runtime.isJobActive(job.id), false);
  // 再等一会儿，确认 exit 事件不会把终态改回 completed/failed。
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(store.readJob(job.id).status, "stopped", "a late exit must not overwrite the stop");
});

test("超时到点自己杀，终态是 timedout 并写明原因", { skip: process.platform === "win32" }, async () => {
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-6",
    command: "sleep 30",
    cwd: dir,
    label: "timeout",
    timeoutSec: 1,
  });
  const done = await waitTerminal(job.id);
  assert.equal(done.status, "timedout");
  assert.match(done.error ?? "", /超时/);
});

test("已结束的 job 再 stop 返回 null（不谎报「停掉了」）", async () => {
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-7",
    command: "echo done",
    cwd: dir,
    label: "done",
  });
  await waitTerminal(job.id);
  assert.equal(runtime.stopBackgroundJob(job.id), null);
});

test("cwd 不存在时拒绝启动，而不是跑在错误的目录里", () => {
  assert.throws(
    () => runtime.startBackgroundJob({
      sessionId: "test-session-none",
      toolCallId: "call-8",
      command: "echo x",
      cwd: join(dir, "definitely-missing"),
      label: "bad cwd",
    }),
    /Working directory does not exist/,
  );
});

test("空命令被拒绝", () => {
  assert.throws(
    () => runtime.startBackgroundJob({ sessionId: "s", toolCallId: "c", command: "   ", cwd: dir, label: "blank" }),
    /must not be empty/,
  );
});

test("服务关闭时清理会把活跃任务结算成 stopped 并清空句柄", async () => {
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-9",
    command: process.platform === "win32" ? "ping -n 60 127.0.0.1" : "sleep 60",
    cwd: dir,
    label: "shutdown",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  runtime.stopAllBackgroundJobs();
  assert.equal(store.readJob(job.id).status, "stopped");
});