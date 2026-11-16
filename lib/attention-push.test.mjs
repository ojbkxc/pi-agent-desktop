import assert from "node:assert/strict";
import test from "node:test";

// Same loader as the neighbouring tests: lib modules import "./web-push"
// without an extension, which plain strip-types does not resolve.
async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./attention-push.ts");
}

const { createSessionStopNotifier, notifySessionStopped, stopPushEvent } = await loadSubject();

function recordingSender({ fail = false } = {}) {
  const calls = [];
  const send = async (sessionId, event, sessionName) => {
    calls.push({ sessionId, event, sessionName });
    if (fail) throw new Error("push service down");
  };
  return { calls, send };
}

test("a stop pushes a short 'stopped' event for that session", async () => {
  const { calls, send } = recordingSender();
  const notify = createSessionStopNotifier(send);

  await notify("session-1", { sessionName: "Refactor auth" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "session-1");
  assert.equal(calls[0].sessionName, "Refactor auth");
  assert.deepEqual(calls[0].event, { kind: "stopped" });
});

test("no info, null name and blank detail all stay a minimal event", async () => {
  const { calls, send } = recordingSender();
  const notify = createSessionStopNotifier(send);

  await notify("a");
  await notify("b", { sessionName: null, detail: "   " });
  await notify("c", {});

  assert.deepEqual(calls.map((call) => call.event), [
    { kind: "stopped" },
    { kind: "stopped" },
    { kind: "stopped" },
  ]);
  assert.deepEqual(calls.map((call) => call.sessionName), [undefined, undefined, undefined]);
});

test("a detail is trimmed and carried, with no independent tag", async () => {
  const { calls, send } = recordingSender();
  await createSessionStopNotifier(send)("s", { detail: "  Stopped from the phone\n" });

  assert.deepEqual(calls[0].event, { kind: "stopped", detail: "Stopped from the phone" });
  assert.equal("tag" in calls[0].event, false, "the session's own tag replaces older notices for it");
});

test("a failing sender is logged, not thrown at the run-stop path", async () => {
  const { calls, send } = recordingSender({ fail: true });
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await assert.doesNotReject(() => createSessionStopNotifier(send)("s", { sessionName: "x" }));
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 1, "the send was attempted once");
  assert.match(logged.join("\n"), /failed to send stop push: push service down/);
});

test("the exported notifier is the same never-rejecting binding", async () => {
  // Its default sender is lib/web-push's notifySessionEvent, which with no
  // subscriptions resolves without touching a push service. This test is the
  // only one that loads lib/web-push through the notifier (first import is
  // slow); a throw here would break the run-stop hook.
  assert.equal(typeof notifySessionStopped, "function");
  await assert.doesNotReject(() => notifySessionStopped("no-such-session", { sessionName: "x" }));
});

test("stopPushEvent is the same event shape for both call styles", () => {
  assert.deepEqual(stopPushEvent(), { kind: "stopped" });
  assert.deepEqual(stopPushEvent({ detail: "x" }), { kind: "stopped", detail: "x" });
});

test("the web-push payload for a stopped run is short and localized", async () => {
  const { createJiti } = await import("jiti");
  const { sessionPushPayload } = await createJiti(import.meta.url).import("./web-push.ts");

  const en = sessionPushPayload("s1", "Refactor auth", { kind: "stopped", detail: "Stopped from the phone" }, "en");
  assert.equal(en.title, "Run stopped · Refactor auth");
  assert.equal(en.body, "Stopped from the phone");
  assert.equal(en.url, "/?session=s1");
  assert.equal(en.tag, "pi-session-complete:s1", "one current notice per session");

  const zh = sessionPushPayload("s1", undefined, { kind: "stopped" }, "zh-CN");
  assert.equal(zh.title, "运行已停止");
  assert.equal(zh.body, "本次运行已被停止。");

  const tw = sessionPushPayload("s1", undefined, { kind: "stopped" }, "zh-TW");
  assert.equal(tw.title, "執行已停止");
  assert.equal(tw.body, "本次執行已被停止。");

  const long = sessionPushPayload("s1", "n", { kind: "stopped", detail: `x\n${"y".repeat(300)}` }, "en");
  assert.ok(long.body.length <= 140, "fits a lock screen");
});