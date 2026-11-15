import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * prompt 组装 + 验证命令执行器（spawn 打桩，不跑真进程）。
 *
 * 锁住三件事：
 * 1. 第一轮是完整指令（任务原句、cwd、验证命令、规则都在）；
 * 2. 第 2 轮起把上一轮失败摘要与输出尾喂回去；
 * 3. 验证器把 exit code 原样上报，超时会杀进程，输出只保留尾部。
 */

const jiti = createJiti(import.meta.url, { interopDefault: true });
const prompt = await jiti.import("./prompt.ts");
const verify = await jiti.import("./verify.ts");
const { EventEmitter } = await import("node:events");

test("the first prompt carries the verbatim task, cwd, command and rules", () => {
  const text = prompt.buildAutofixPrompt({
    task: "这个 bug 不修好，CI 过不去",
    cwd: "/repo",
    verifyCommand: "npm test",
    round: 1,
    maxRounds: 20,
  });
  assert.match(text, /这个 bug 不修好，CI 过不去/);
  assert.match(text, /Working directory: \/repo/);
  assert.match(text, /Verification command: npm test/);
  assert.match(text, /Round 1 of 20/);
  assert.match(text, /Do not commit, push/);
  assert.match(text, /Do not ask the user anything/);
  assert.match(text, /exit code 0/);
});

test("rounds after the first carry the failure summary and the output tail", () => {
  const text = prompt.buildAutofixPrompt({
    task: "fix it",
    cwd: "/repo",
    verifyCommand: "npm test",
    round: 3,
    maxRounds: 20,
    lastError: "Verification failed with exit code 1",
    lastOutputTail: "AssertionError: expected 1 to equal 2",
  });
  assert.match(text, /Round 3 of 20/);
  assert.match(text, /exit code 1/);
  assert.match(text, /AssertionError: expected 1 to equal 2/);
  // The task statement is not repeated on continuation rounds.
  assert.doesNotMatch(text, /Task statement from the user/);
});

test("the continuation prompt caps what it echoes back", () => {
  const text = prompt.buildAutofixContinuePrompt({
    task: "fix it",
    cwd: "/repo",
    verifyCommand: "npm test",
    round: 2,
    maxRounds: 20,
    lastOutputTail: "x".repeat(50_000),
  });
  assert.ok(text.length < 10_000, `prompt should be capped, got ${text.length}`);
});

test("session names are derived from the first line and stay short", () => {
  assert.equal(prompt.autofixSessionName("fix the login bug\nsecond line"), "Autofix · fix the login bug");
  assert.equal(prompt.autofixSessionName(""), "Autofix · bug fix");
  assert.ok(prompt.autofixSessionName("y".repeat(200)).length <= 70);
});

/** 最小 spawn 桩：脚本化 stdout/stderr/close。 */
function fakeSpawn(script) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
    };
    setImmediate(() => script(child));
    return child;
  };
}

test("runVerifyCommand reports exit code 0 as a pass with the output tail", async () => {
  const result = await verify.runVerifyCommand("npm test", "/repo", {
    spawnFn: fakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from("all good\n"));
      child.emit("close", 0);
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.outputTail, /all good/);
});

test("runVerifyCommand reports non-zero and merges stderr", async () => {
  const result = await verify.runVerifyCommand("npm test", "/repo", {
    spawnFn: fakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from("1 failing\n"));
      child.stderr.emit("data", Buffer.from("AssertionError\n"));
      child.emit("close", 1);
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.outputTail, /1 failing/);
  assert.match(result.outputTail, /AssertionError/);
});

test("runVerifyCommand keeps only the tail of huge output", async () => {
  const result = await verify.runVerifyCommand("npm test", "/repo", {
    spawnFn: fakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from("A".repeat(200_000)));
      child.stdout.emit("data", Buffer.from("THE END"));
      child.emit("close", 1);
    }),
    maxTailChars: 100,
  });
  assert.ok(result.outputTail.length <= 101);
  assert.match(result.outputTail, /THE END$/);
});

test("runVerifyCommand kills the child on timeout and reports timedOut", async () => {
  let killed = false;
  const result = await verify.runVerifyCommand("npm test", "/repo", {
    timeoutMs: 30,
    spawnFn: fakeSpawn((child) => {
      const originalKill = child.kill;
      child.kill = (...args) => {
        killed = true;
        originalKill(...args);
        setTimeout(() => child.emit("close", null), 5);
      };
    }),
  });
  assert.equal(killed, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

test("runVerifyCommand survives a spawn throw", async () => {
  const result = await verify.runVerifyCommand("npm test", "/repo", {
    spawnFn: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(result.exitCode, null);
  assert.match(result.outputTail, /ENOENT/);
});