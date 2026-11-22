import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

// ── 回归：记录读不到时也必须杀进程 ──────────────────────────────
// 缺陷：finish() 先 readJob()，失败就 return，killProcessTree 永远不执行。
// 后果：进程继续跑，settled 已置位、句柄已删，之后 stop 永远返回 null —— 永久孤儿。
test("job 记录被删掉后 stop 仍然杀掉进程（读盘失败不能跳过杀进程）", async () => {
  const { job } = runtime.startBackgroundJob({
    sessionId: "test-session-none",
    toolCallId: "call-10",
    command: process.platform === "win32" ? "ping -n 60 127.0.0.1" : "sleep 60",
    cwd: dir,
    label: "leak-regression",
  });
  assert.ok(job.pid, "job 必须有 pid 才能验证");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 模拟记录损坏/被清理：直接删掉落盘记录。
  rmSync(store.jobRecordPath(job.id), { force: true });

  const stopped = runtime.stopBackgroundJob(job.id);
  assert.equal(stopped, null, "记录没了，返回不了终态，但进程必须已经被杀");

  // 轮询直到进程消失（Windows taskkill 是异步的）。
  const deadline = Date.now() + 15_000;
  let alive = true;
  while (Date.now() < deadline && alive) {
    try {
      process.kill(job.pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "记录读不到时进程仍存活 = 进程泄漏");
});

test("killProcessTree 对不存在的 pid 不抛异常（taskkill 失败不能崩服务）", () => {
  assert.doesNotThrow(() => runtime.killProcessTree(2_147_483_000));
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

// ── 回归：spawn 同步抛错时不能留下空的输出文件 ──────────────────────
// 缺陷：createOutputFile() 先建好 `.log`，随后 spawn 同步抛（命令里带 NUL，
// Node 直接 ERR_INVALID_ARG_VALUE）。catch 只清了内存里的字节计数，没有删文件，
// 而这条路径不写 job 记录，pruneJobs() 只扫已知 id，于是空的 `.log` 永久留在
// jobs/ 里。这里断言失败路径不留新文件。
test("spawn 同步失败：抛 BackgroundJobError，且不留下孤儿输出文件", () => {
  const jobs = store.jobsDir();
  const before = new Set(existsSync(jobs) ? readdirSync(jobs) : []);
  assert.throws(
    () => runtime.startBackgroundJob({
      sessionId: "test-session-none",
      toolCallId: "call-nul",
      command: "echo before\u0000after",
      cwd: dir,
      label: "nul",
    }),
    (error) => error?.code === "spawn",
  );
  const after = existsSync(jobs) ? readdirSync(jobs) : [];
  const leaked = after.filter((name) => name.endsWith(".log") && !before.has(name));
  assert.deepEqual(leaked, [], `spawn 失败留下了孤儿输出文件: ${leaked.join(", ")}`);
});