import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * usePromptHistory（ISSUE-11 跨会话 prompt 历史 hook）行为测试。
 *
 * 与 useGoalState.test.mjs 同一套做法：仓库没有 DOM 渲染器，用
 * `hooks/__fixtures__/fake-react.mjs` 替身手动 mount + flush effect，真实执行 hook 的
 * effect 体；fetch 打桩。验证：无 scope 不拉取、按项目拉取后合并、sessionOnly 隔离、
 * 拉取失败降级、上下文切换重拉。
 */

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { react: fileURLToPath(new URL("./__fixtures__/fake-react.mjs", import.meta.url)) },
});
const ReactFake = await jiti.import("react");
const { usePromptHistory } = await jiti.import("./usePromptHistory.ts");

/** mount 一个 hook：返回读当前返回值 / flush effects / 换参数重渲染的句柄。 */
function mount(hook, ...args) {
  let latest;
  let currentArgs = args;
  const render = () => {
    ReactFake.__beginRender();
    latest = hook(...currentArgs);
  };
  ReactFake.__setNotify(() => render());
  ReactFake.__reset();
  render();
  return {
    get current() { return latest; },
    setArgs(next) { currentArgs = next; render(); },
    flush: () => ReactFake.__flushEffects(),
  };
}

const realFetch = globalThis.fetch;
function installFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more fetch responses queued");
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body };
  };
  return { calls };
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("no scope (no session, no project) → no fetch, returns session entries only", (t) => {
  const env = installFetch([]);
  t.after(restoreFetch);
  const sessionEntries = [{ text: "mine", images: [] }];
  const h = mount(usePromptHistory, { sessionEntries, includeProjectHistory: true });
  h.flush();
  assert.equal(env.calls.length, 0, "no scope → no fetch");
  assert.deepEqual(h.current, [{ text: "mine", images: [] }]);
});

test("project scope → fetches and merges session + server entries, current session first", async (t) => {
  const env = installFetch([{ body: { entries: [
    { display: "mine", sessionId: "s1" },
    { display: "other-session", sessionId: "s2" },
  ] } }]);
  t.after(restoreFetch);
  const sessionEntries = [{ text: "mine", images: [] }, { text: "transcript-only", images: [] }];
  const h = mount(usePromptHistory, {
    sessionId: "s1",
    projectPath: "/proj",
    projectRoot: "/proj",
    sessionEntries,
    includeProjectHistory: true,
  });
  assert.deepEqual(h.current.map((e) => e.text), ["mine", "transcript-only"], "before fetch: session entries only");
  h.flush();
  await flush();
  assert.equal(env.calls.length, 1);
  assert.match(env.calls[0].url, /\/api\/prompt-history\?/);
  assert.match(env.calls[0].url, /project=%2Fproj/);
  assert.match(env.calls[0].url, /sessionId=s1/);
  // "mine" deduped (transcript wins); "transcript-only" then "other-session".
  assert.deepEqual(h.current.map((e) => e.text), ["mine", "transcript-only", "other-session"]);
});

test("includeProjectHistory=false → sessionOnly fetch, other-session entries excluded", async (t) => {
  const env = installFetch([{ body: { entries: [
    { display: "mine", sessionId: "s1" },
    { display: "other", sessionId: "s2" },
  ] } }]);
  t.after(restoreFetch);
  const sessionEntries = [{ text: "mine", images: [] }];
  const h = mount(usePromptHistory, {
    sessionId: "s1",
    projectPath: "/proj",
    sessionEntries,
    includeProjectHistory: false,
  });
  h.flush();
  await flush();
  assert.match(env.calls[0].url, /sessionOnly=1/);
  assert.deepEqual(h.current.map((e) => e.text), ["mine"], "other-session dropped");
});

test("fetch failure → degrades to session entries, no throw", async (t) => {
  const env = installFetch([{ ok: false, status: 500, body: {} }]);
  t.after(restoreFetch);
  const sessionEntries = [{ text: "mine", images: [] }];
  const h = mount(usePromptHistory, {
    sessionId: "s1",
    projectPath: "/proj",
    sessionEntries,
    includeProjectHistory: true,
  });
  h.flush();
  await flush();
  assert.deepEqual(h.current.map((e) => e.text), ["mine"], "failure keeps session entries");
});

test("fetch rejection → degrades to session entries", async (t) => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  t.after(restoreFetch);
  const sessionEntries = [{ text: "mine", images: [] }];
  const h = mount(usePromptHistory, {
    sessionId: "s1",
    projectPath: "/proj",
    sessionEntries,
    includeProjectHistory: true,
  });
  h.flush();
  await flush();
  assert.deepEqual(h.current.map((e) => e.text), ["mine"]);
});

test("context change (sessionId switch) → refetches and re-merges", async (t) => {
  const env = installFetch([
    { body: { entries: [{ display: "old-session", sessionId: "s1" }] } },
    { body: { entries: [{ display: "new-session", sessionId: "s2" }] } },
  ]);
  t.after(restoreFetch);
  const h = mount(usePromptHistory, {
    sessionId: "s1",
    projectPath: "/proj",
    sessionEntries: [],
    includeProjectHistory: true,
  });
  h.flush();
  await flush();
  assert.deepEqual(h.current.map((e) => e.text), ["old-session"]);
  h.setArgs([{
    sessionId: "s2",
    projectPath: "/proj",
    sessionEntries: [],
    includeProjectHistory: true,
  }]);
  h.flush();
  await flush();
  assert.equal(env.calls.length, 2, "refetched on context change");
  assert.deepEqual(h.current.map((e) => e.text), ["new-session"]);
});

test("no double-fetch: same context does not refetch", async (t) => {
  const env = installFetch([{ body: { entries: [{ display: "x", sessionId: "s1" }] } }]);
  t.after(restoreFetch);
  const h = mount(usePromptHistory, {
    sessionId: "s1",
    projectPath: "/proj",
    sessionEntries: [],
    includeProjectHistory: true,
  });
  h.flush();
  await flush();
  assert.equal(env.calls.length, 1);
  // Re-render with same args (no context change) → effect deps unchanged → no refetch.
  h.setArgs([{
    sessionId: "s1",
    projectPath: "/proj",
    sessionEntries: [{ text: "new-transcript", images: [] }],
    includeProjectHistory: true,
  }]);
  h.flush();
  await flush();
  assert.equal(env.calls.length, 1, "same context does not refetch");
  // But the merge recomputes with the new transcript entry.
  assert.deepEqual(h.current.map((e) => e.text), ["new-transcript", "x"]);
});
