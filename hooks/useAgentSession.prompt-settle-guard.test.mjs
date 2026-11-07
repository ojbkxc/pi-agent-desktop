import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

// The two non-SSE settlement paths of useAgentSession: the fallback that
// finishes a prompt whose terminal event never arrived (finishPromptWithoutStream)
// and the poll that watches for it (waitForPromptSettlement). Both are compiled
// straight out of the hook and driven with recorded refs, like
// useAgentSession.events-086.test.mjs does for handleAgentEvent.

function parse(file) {
  return ts.createSourceFile(
    file,
    readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
}

const source = parse("useAgentSession.ts");

// Explicit stack: a visitor that recurses inside ts.forEachChild walks the whole
// 3 000-line hook once per node and overflows the stack on this file.
function findCallback(sourceFile, name) {
  const stack = [sourceFile];
  while (stack.length > 0) {
    const node = stack.pop();
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name) {
      return node.initializer.arguments[0];
    }
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
  return undefined;
}

function compileCallback(name) {
  const callback = findCallback(source, name);
  assert.ok(callback, `callback ${name} not found`);
  return new Script(ts.transpileModule(callback.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
}

const finishPromptWithoutStreamSrc = compileCallback("finishPromptWithoutStream");
const waitForPromptSettlementSrc = compileCallback("waitForPromptSettlement");

/**
 * finishPromptWithoutStream with recorded refs. `screenSession` is what
 * sessionIdRef points at (the conversation the user is looking at), `sid` is the
 * session the settlement belongs to.
 */
function makeFinishHarness({ screenSession, runId, onLoad }) {
  const calls = { settles: 0, notified: [], agentEnd: 0, closed: [], loaded: [] };
  const refs = {
    sessionIdRef: { current: screenSession },
    promptRunIdRef: { current: runId },
    rpcPromptPendingRef: { current: true },
    sdkAgentActiveRef: { current: true },
    optimisticUserMessageKeyRef: { current: "u:hello" },
  };
  const finish = finishPromptWithoutStreamSrc.runInNewContext({
    ...refs,
    loadSession: async (loadedSid) => { calls.loaded.push(loadedSid); onLoad?.(refs); },
    settleUiStage: () => { calls.settles += 1; return true; },
    notifyPromptStage: (run) => { calls.notified.push(run); return true; },
    onAgentEnd: () => { calls.agentEnd += 1; },
    scheduleEventStreamClose: (closedSid) => { calls.closed.push(closedSid); },
  });
  return { finish, refs, calls };
}

test("a finished prompt settles the UI stage of the session it belongs to", async () => {
  const { finish, refs, calls } = makeFinishHarness({ screenSession: "s1", runId: 7 });
  await finish("s1", 7);

  assert.deepEqual(calls.loaded, ["s1"], "the transcript is re-read before settling");
  assert.equal(calls.settles, 1);
  assert.deepEqual(calls.notified, [7]);
  assert.equal(calls.agentEnd, 0, "notifyPromptStage owns the completion notification");
  assert.deepEqual(calls.closed, ["s1"]);
  assert.equal(refs.rpcPromptPendingRef.current, false);
  assert.equal(refs.sdkAgentActiveRef.current, false);
  assert.equal(refs.optimisticUserMessageKeyRef.current, null);
});

// Regression: the settle loop outlives the switch away from its session whenever
// the session moved to is running (its own prompt sets agentRunningRef again and
// its `connected` frame does too), so the stale settlement used to land on that
// session: its streaming bubble was cleared, Stop disappeared, and every later
// message_start/update/end was dropped by the `!agentRunningRef.current` guard
// until a manual reload.
test("a settlement for a session the user left does not settle the session now on screen", async () => {
  const { finish, refs, calls } = makeFinishHarness({ screenSession: "s2", runId: 7 });
  await finish("s1", 7);

  assert.equal(calls.settles, 0, "the on-screen session's run must keep its streaming stage");
  assert.deepEqual(calls.loaded, [], "and its transcript must not be re-read for s1");
  assert.deepEqual(calls.notified, [], "no completion notification for a run of the other session");
  assert.equal(calls.agentEnd, 0);
  assert.deepEqual(calls.closed, []);
  assert.equal(refs.rpcPromptPendingRef.current, true, "s2's pending-prompt flag survives");
  assert.equal(refs.sdkAgentActiveRef.current, true);
  assert.equal(refs.optimisticUserMessageKeyRef.current, "u:hello");
});

test("a switch away during the settling read cancels the settle", async () => {
  const { finish, refs, calls } = makeFinishHarness({
    screenSession: "s1",
    runId: 7,
    onLoad: (refsDuringLoad) => { refsDuringLoad.sessionIdRef.current = "s2"; },
  });
  await finish("s1", 7);

  assert.deepEqual(calls.loaded, ["s1"], "the read was already under way");
  assert.equal(calls.settles, 0, "but the settle must not follow it onto s2");
  assert.deepEqual(calls.notified, []);
  assert.deepEqual(calls.closed, []);
  assert.equal(refs.rpcPromptPendingRef.current, true);
});

test("a stale run id is still ignored, in either session", async () => {
  const same = makeFinishHarness({ screenSession: "s1", runId: 9 });
  await same.finish("s1", 7);
  assert.equal(same.calls.settles, 0);
  assert.deepEqual(same.calls.loaded, []);
  assert.equal(same.refs.rpcPromptPendingRef.current, true);

  const left = makeFinishHarness({ screenSession: "s2", runId: 9 });
  await left.finish("s1", 7);
  assert.equal(left.calls.settles, 0);
  assert.deepEqual(left.calls.loaded, []);
});

/** waitForPromptSettlement with a timers-free delay and a stubbed agent state. */
function makeWaitHarness({ screenSession, fetchRunning = false }) {
  const calls = { fetches: 0, settleArgs: [], synced: 0 };
  const refs = {
    sessionIdRef: { current: screenSession },
    promptRunIdRef: { current: 7 },
    agentRunningRef: { current: true },
  };
  const wait = waitForPromptSettlementSrc.runInNewContext({
    ...refs,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    syncLiveModel: () => { calls.synced += 1; },
    finishPromptWithoutStream: async (sid, runId) => { calls.settleArgs.push([sid, runId]); },
    fetch: async () => {
      calls.fetches += 1;
      return {
        ok: true,
        json: async () => (fetchRunning
          ? { running: true, state: { isStreaming: true } }
          : { running: false, state: undefined }),
      };
    },
    PROMPT_SETTLE_INITIAL_DELAY_MS: 0,
    PROMPT_SETTLE_POLL_MS: 5,
    PROMPT_SETTLE_MAX_MS: 200,
  });
  return { wait, refs, calls };
}

test("the settle poll finishes its own prompt once the server reports idle", async () => {
  const { wait, calls } = makeWaitHarness({ screenSession: "s1" });
  await wait("s1", 7);

  assert.equal(calls.fetches, 1);
  assert.deepEqual(calls.settleArgs, [["s1", 7]]);
});

test("the settle poll also stops when the server still reports the run as busy", async () => {
  // Negative control for the test below: the running flag alone keeps the poll
  // alive; only the session check can stop it from settling s1.
  const { wait, refs, calls } = makeWaitHarness({ screenSession: "s1", fetchRunning: true });
  const polling = wait("s1", 7);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(refs.agentRunningRef.current, true);
  assert.ok(calls.fetches > 0, "the poll must actually ask the server");
  assert.deepEqual(calls.settleArgs, []);
  refs.agentRunningRef.current = false;
  await polling;
});

test("the settle poll stops instead of polling and settling the session now on screen", async () => {
  const { wait, refs, calls } = makeWaitHarness({ screenSession: "s2" });
  await wait("s1", 7);

  assert.equal(refs.agentRunningRef.current, true, "s2 is still running");
  assert.equal(calls.fetches, 0, "no request may be made about a session the user left");
  assert.deepEqual(calls.settleArgs, []);
});
