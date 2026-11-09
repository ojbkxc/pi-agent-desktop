import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * useGoalState（/goal 进度条数据源）行为测试。
 *
 * 与 useTeamPlan.test.mjs 同一套做法：仓库没有 DOM 渲染器，用
 * `hooks/__fixtures__/fake-react.mjs` 替身手动 mount + flush effect，真实执行 hook 的
 * effect 体；fetch / setTimeout 均打桩。`document` 在 Node 下默认不存在（hook 按无 document
 * 处理），可见性分支用本地假 document 单独覆盖。
 */

const jiti = createJiti(import.meta.url, {
  alias: { react: fileURLToPath(new URL("./__fixtures__/fake-react.mjs", import.meta.url)) },
});
const ReactFake = await jiti.import("react");
const { useGoalState, GOAL_POLL_MS } = await jiti.import("./useGoalState.ts");

const GOAL = {
  sessionId: "s1",
  objective: "把 README 重写一遍",
  status: "active",
  budget: 20,
  continuations: 2,
  maxContinuations: 20,
  startedAt: 1000,
  elapsedMs: 125000,
  updatedAt: 2000,
};

/** mount 一个 hook：返回读当前返回值 / flush effects 的句柄。 */
function mount(hook, ...args) {
  let latest;
  const render = () => {
    ReactFake.__beginRender();
    latest = hook(...args);
  };
  ReactFake.__setNotify(() => render());
  ReactFake.__reset();
  render();
  return {
    get current() { return latest; },
    flush: () => ReactFake.__flushEffects(),
  };
}

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** 装 fetch / 定时器桩；responses 是队列，每次 fetch 取一个。 */
function installEnv(responses) {
  const calls = [];
  const timers = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more fetch responses queued");
    return { ok: next.ok, status: next.status ?? (next.ok ? 200 : 500), json: async () => next.body };
  };
  globalThis.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  globalThis.clearTimeout = () => {};
  return { calls, timers };
}
function restoreEnv() {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  delete globalThis.document;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("sessionId=null → 零 fetch，goal 为空", (t) => {
  const env = installEnv([]);
  t.after(restoreEnv);
  const h = mount(useGoalState, null, 0);
  h.flush();
  assert.equal(env.calls.length, 0, "不拉取");
  assert.equal(h.current.goal, null);
  assert.equal(h.current.error, null);
});

test("active → goal 落地，并按 GOAL_POLL_MS 排下一次拉取", async (t) => {
  const env = installEnv([{ ok: true, body: { goal: GOAL } }]);
  t.after(restoreEnv);
  const h = mount(useGoalState, "s1", 0);
  h.flush();
  await flush();
  assert.equal(env.calls.length, 1);
  assert.match(env.calls[0].url, /\/api\/goals\/s1$/);
  assert.equal(env.calls[0].init.cache, "no-store");
  assert.equal(h.current.goal.objective, GOAL.objective, "goal 落地");
  assert.equal(h.current.error, null);
  assert.equal(env.timers.length, 1, "排了一次轮询");
  assert.equal(env.timers[0].delay, GOAL_POLL_MS, "轮询间隔 = 2s");
});

test("paused → 拉到即停，不再排轮询（保留快照）", async (t) => {
  const env = installEnv([
    { ok: true, body: { goal: { ...GOAL, status: "paused" } } },
  ]);
  t.after(restoreEnv);
  const h = mount(useGoalState, "s1", 0);
  h.flush();
  await flush();
  assert.equal(h.current.goal.status, "paused", "paused 快照保留");
  assert.equal(env.timers.length, 0, "暂停后不再 2s 轮询");
});

test("无目标（goal:null）→ goal 为空且不再轮询", async (t) => {
  const env = installEnv([{ ok: true, body: { goal: null } }]);
  t.after(restoreEnv);
  const h = mount(useGoalState, "s1", 0);
  h.flush();
  await flush();
  assert.equal(h.current.goal, null);
  assert.equal(h.current.error, null);
  assert.equal(env.timers.length, 0);
});

test("HTTP 非 ok → error 带状态码，并按 GOAL_POLL_MS 重试", async (t) => {
  const env = installEnv([{ ok: false, status: 503, body: {} }]);
  t.after(restoreEnv);
  const h = mount(useGoalState, "s1", 0);
  h.flush();
  await flush();
  assert.equal(h.current.goal, null);
  assert.match(h.current.error, /503/);
  assert.equal(env.timers.length, 1, "失败也重试");
  assert.equal(env.timers[0].delay, GOAL_POLL_MS);
});

test("页面不可见 → 不拉取；切回可见立即补拉", async (t) => {
  const env = installEnv([{ ok: true, body: { goal: GOAL } }]);
  t.after(restoreEnv);

  const listeners = new Map();
  globalThis.document = {
    visibilityState: "hidden",
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: () => {},
  };

  const h = mount(useGoalState, "s1", 0);
  h.flush();
  await flush();
  assert.equal(env.calls.length, 0, "隐藏时不发请求");
  assert.equal(env.timers.length, 0, "也不排定时器");

  globalThis.document.visibilityState = "visible";
  for (const fn of listeners.get("visibilitychange") ?? []) fn();
  assert.equal(env.timers.length, 1, "切回前台排一次立即拉取");
  assert.equal(env.timers[0].delay, 0, "立即（0ms）而不是等 2s");
  env.timers[0].fn();
  await flush();
  assert.equal(env.calls.length, 1, "补拉发生");
  assert.equal(h.current.goal.objective, GOAL.objective);
});
