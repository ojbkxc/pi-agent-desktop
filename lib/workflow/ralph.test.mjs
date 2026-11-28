import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Ralph 循环：**每轮一个全新 worker**，长期记忆在工作区，不在上下文里。
 *
 * 关键语义（写错任何一条，这条循环就退化成「同一个会话多跑几轮」）：
 * - 每轮 `runtime.start` 一次，且 `inheritContext: false`；
 * - 只把「目标 + 工作区约定 + 上一轮那份有界报告」交给 worker；
 * - 只有报告里明确写 `STATUS: complete` 才算完成——解析不出来绝不猜成完成；
 * - 同一个 blocker 连续 3 次就停（再跑也一样），换 blocker 说明还在推进，继续。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const ralph = await jiti.import("./ralph.ts");

const { runRalphLoop, parseRalphReport, buildRalphPrompt, normalizeRalphRounds, RALPH_REPEAT_BLOCKER_LIMIT } = ralph;

/** 一个按脚本回话的假 runtime：每次 start 取队列里下一个回复。 */
function fakeRuntime(replies) {
  const calls = [];
  let index = 0;
  return {
    calls,
    start(request) {
      calls.push(request);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      const run = {
        sessionId: `s${index}`,
        status: reply.status ?? "completed",
        profile: "general-purpose",
        description: request.description,
        runInBackground: false,
        result: reply.text ?? "",
        ...(reply.error ? { error: reply.error } : {}),
      };
      return Promise.resolve({ run, completion: Promise.resolve(run) });
    },
  };
}

test("every round starts a fresh worker with no inherited context", async () => {
  const runtime = fakeRuntime([{ text: "STATUS: continue\nDID: step 1\nNEXT: step 2\nBLOCKER: none" }]);
  const result = await runRalphLoop({
    objective: "ship it",
    maxRounds: 3,
    parentContext: {},
    runtime,
  });
  assert.equal(result.rounds.length, 3);
  assert.equal(runtime.calls.length, 3, "one worker per round, never a reused conversation");
  for (const call of runtime.calls) {
    assert.equal(call.inheritContext, false, "fresh context is the whole point");
    assert.equal(call.runInBackground, false, "the loop waits for each round");
  }
});

test("the round prompt carries the objective, the workspace rule and the previous report", () => {
  const prompt = buildRalphPrompt({
    objective: "make tests green",
    round: 2,
    maxRounds: 5,
    previous: { index: 1, status: "continue", sessionId: "s1", report: { did: "fixed a", next: "fix b", blocker: "", complete: false } },
  });
  assert.match(prompt, /make tests green/);
  assert.match(prompt, /The workspace is the memory/);
  assert.match(prompt, /did: fixed a/);
  assert.match(prompt, /next: fix b/);
  assert.match(prompt, /Round 2 of 5/);
});

test("only an explicit STATUS: complete stops the loop as done", async () => {
  const runtime = fakeRuntime([
    { text: "STATUS: continue\nDID: a\nNEXT: b\nBLOCKER: none" },
    { text: "STATUS: complete\nDID: b\nNEXT: none\nBLOCKER: none" },
  ]);
  const result = await runRalphLoop({ objective: "o", maxRounds: 5, parentContext: {}, runtime });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.rounds.length, 2);
});

test("an unparseable report is never read as done", async () => {
  const report = parseRalphReport("I think I finished everything, looks good to me.");
  assert.equal(report.complete, false, "guessing `complete` is the dangerous failure mode");
  assert.equal(report.did, "");
});

test("the round budget is the fallback brake", async () => {
  const runtime = fakeRuntime([{ text: "STATUS: continue\nDID: x\nNEXT: y\nBLOCKER: none" }]);
  const result = await runRalphLoop({ objective: "o", maxRounds: 4, parentContext: {}, runtime });
  assert.equal(result.stopReason, "rounds");
  assert.equal(result.rounds.length, 4);
});

test("the same blocker repeated stops the loop; a new one does not", async () => {
  // 注意：这里用 `STATUS: continue` + `BLOCKER:`，不是 `STATUS: blocked`——
  // worker 声明 blocked 会直接早停（见下一个测试），只有「说继续但留了 blocker」
  // 才走连续同 blocker 重复计数分支。
  const blocked = { text: "STATUS: continue\nDID: x\nNEXT: y\nBLOCKER: missing credentials" };
  const other = { text: "STATUS: continue\nDID: x\nNEXT: y\nBLOCKER: flaky network" };
  const sameRuntime = fakeRuntime([blocked]);
  const same = await runRalphLoop({ objective: "o", maxRounds: 10, parentContext: {}, runtime: sameRuntime });
  assert.equal(same.stopReason, "blocked");
  assert.equal(same.rounds.length, RALPH_REPEAT_BLOCKER_LIMIT, "repeating the same blocker must stop early");

  const mixedRuntime = fakeRuntime([blocked, other, blocked, other]);
  const mixed = await runRalphLoop({ objective: "o", maxRounds: 4, parentContext: {}, runtime: mixedRuntime });
  assert.equal(mixed.rounds.length, 4, "changing blockers counts as progress");
});

test("`STATUS: blocked` with a blocker stops immediately, not after repeating", async () => {
  // L2：worker 写 `STATUS: blocked` 就是它的结论，直接早停，不必等 blocker 重复。
  // 改前要求 `blocked && !blocker` 才早停，于是同时写 blocked + BLOCKER 时落进
  // 「连续同 blocker 重复计数」分支，还要再跑 2 轮同 blocker 才停。
  const runtime = fakeRuntime([
    { text: "STATUS: blocked\nDID: x\nNEXT: y\nBLOCKER: missing credentials" },
  ]);
  const result = await runRalphLoop({ objective: "o", maxRounds: 10, parentContext: {}, runtime });
  assert.equal(result.stopReason, "blocked");
  assert.equal(result.rounds.length, 1, "worker 声明 blocked 即早停，不必等 blocker 重复");
});

test("a failed worker round ends the loop and keeps its error", async () => {
  const runtime = fakeRuntime([{ status: "failed", error: "provider down" }]);
  const result = await runRalphLoop({ objective: "o", maxRounds: 5, parentContext: {}, runtime });
  assert.equal(result.stopReason, "blocked");
  assert.equal(result.rounds[0].status, "failed");
  assert.match(result.rounds[0].error ?? "", /provider down/);
});

test("round counts are clamped to a sane range", () => {
  assert.equal(normalizeRalphRounds(undefined), 8);
  assert.equal(normalizeRalphRounds(0), 8);
  assert.equal(normalizeRalphRounds(999), 50);
  assert.equal(normalizeRalphRounds(3), 3);
});

test("cancelling the signal stops before the next round starts", async () => {
  const controller = new AbortController();
  const runtime = fakeRuntime([{ text: "STATUS: continue\nDID: a\nNEXT: b\nBLOCKER: none" }]);
  const inner = runtime.start.bind(runtime);
  runtime.start = (request) => {
    controller.abort();
    return inner(request);
  };
  const result = await runRalphLoop({ objective: "o", maxRounds: 10, parentContext: {}, runtime, signal: controller.signal });
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.rounds.length, 1);
});