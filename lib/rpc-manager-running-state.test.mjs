import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const rpc = await jiti.import("./rpc-manager.ts");
const { AgentSessionWrapper, subscribeRunningSessions, getRunningRpcSessionIds } = rpc;

/**
 * Mimics the pi ≥ 0.86 AgentSession event/ordering contract: `agent_end`
 * fires while the run is still active (post-run pipeline pending), and the
 * `prompt()` promise resolves only after `agent_settled` — where
 * `_isAgentRunActive` was already cleared.
 */
function makeInner() {
  const listeners = new Set();
  const state = { active: false };
  const inner = {
    sessionId: "sid-1",
    sessionFile: "/tmp/sid-1.jsonl",
    get isStreaming() { return state.active; },
    get isIdle() { return !state.active; },
    isCompacting: false,
    get isBashRunning() { return false; },
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: {} },
    settingsManager: { getDefaultTools: () => [] },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    clearQueue() { return { steering: [], followUp: [] }; },
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    dispose() { /* no-op */ },
    emit: (event) => { for (const l of listeners) l(event); },
    state,
    async prompt(_text, options) {
      state.active = true;
      inner.emit({ type: "agent_start" });
      if (options?.streamingBehavior) {
        // Steered/followUp submissions resolve at queue time; the run they
        // joined keeps going.
        return;
      }
      inner.emit({ type: "agent_end", messages: [] });
      state.active = false;
      inner.emit({ type: "agent_settled" });
    },
    abort: async () => {
      inner.emit({ type: "agent_end", messages: [] });
      state.active = false;
      inner.emit({ type: "agent_settled" });
    },
    /** Finishes the run a steered submission joined. */
    finishJoinedRun() {
      inner.emit({ type: "agent_end", messages: [] });
      state.active = false;
      inner.emit({ type: "agent_settled" });
    },
  };
  return inner;
}

function startWrapperInRegistry(inner) {
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[inner.sessionId, wrapper]]);
  return {
    wrapper,
    dispose() {
      wrapper.destroy();
      globalThis.__piSessions = previous;
    },
  };
}

async function settle() {
  await new Promise((r) => setTimeout(r, 20));
}

test("a completed prompt pushes a final running frame without the session id", async () => {
  const frames = [];
  const unsubscribe = subscribeRunningSessions((ids) => frames.push([...ids]));

  const guard = startWrapperInRegistry(makeInner());
  try {
    await guard.wrapper.send({ type: "prompt", message: "hi" });
    await settle();

    const lastFrame = frames[frames.length - 1] ?? [];
    assert.deepEqual(getRunningRpcSessionIds(), [], "server still reports the finished session as running");
    assert.deepEqual(
      lastFrame,
      [],
      `last SSE frame still contains the finished session — sidebar spinner would spin forever: ${JSON.stringify(frames)}`,
    );
    // The run must have been advertised while it was active, too.
    assert.ok(frames.some((ids) => ids.includes("sid-1")), `running phase was never broadcast: ${JSON.stringify(frames)}`);
  } finally {
    unsubscribe();
    guard.dispose();
  }
});

test("a steered submission stays running until the joined run settles", async () => {
  const frames = [];
  const unsubscribe = subscribeRunningSessions((ids) => frames.push([...ids]));

  const inner = makeInner();
  const guard = startWrapperInRegistry(inner);
  try {
    await guard.wrapper.send({ type: "prompt", message: "hi", streamingBehavior: "steer" });
    await settle();
    // Queue-time settle must NOT clear the run the message joined.
    assert.ok(getRunningRpcSessionIds().includes("sid-1"), "steered submission dropped the running id at queue time");

    inner.finishJoinedRun();
    await settle();
    assert.deepEqual(getRunningRpcSessionIds(), [], "joined run settle left the session in the running set");
    assert.deepEqual(frames[frames.length - 1], [], `no settle frame pushed: ${JSON.stringify(frames)}`);
  } finally {
    unsubscribe();
    guard.dispose();
  }
});

test("aborting a run pushes a final frame without the session id", async () => {
  const frames = [];
  const unsubscribe = subscribeRunningSessions((ids) => frames.push([...ids]));

  // A prompt whose promise never settles on its own; abort() must unblock it
  // exactly like the SDK's waitForIdle-gated abort does.
  const inner = makeInner();
  let resolvePrompt;
  inner.prompt = () => {
    inner.state.active = true;
    inner.emit({ type: "agent_start" });
    return new Promise((resolve) => { resolvePrompt = resolve; });
  };
  const realAbort = inner.abort;
  inner.abort = async () => {
    await realAbort.call(inner);
    resolvePrompt?.();
  };
  const guard = startWrapperInRegistry(inner);
  try {
    const sending = guard.wrapper.send({ type: "prompt", message: "hi" });
    await settle();
    assert.ok(getRunningRpcSessionIds().includes("sid-1"), "run was never advertised as running");

    await guard.wrapper.send({ type: "abort" });
    await sending;
    await settle();

    assert.deepEqual(getRunningRpcSessionIds(), [], "aborted session still reported as running");
    assert.deepEqual(frames[frames.length - 1], [], `no post-abort frame pushed: ${JSON.stringify(frames)}`);
  } finally {
    unsubscribe();
    guard.dispose();
  }
});
