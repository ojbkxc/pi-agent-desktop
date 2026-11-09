import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * useTeamPlan（B3 计划卡数据源）行为测试。
 *
 * 仓库没有 DOM 渲染器，无法用真实 React 跑 hook；这里用 `hooks/__fixtures__/fake-react.mjs`
 * 这个极简 hooks 替身（jiti alias 把 "react" 换掉），手动 mount + flush effect，真实执行
 * hook 的 effect 体：轮询 fetch、错误分支、approve 的 POST 组装。fetch / setTimeout 均打桩。
 */

const jiti = createJiti(import.meta.url, {
  alias: { react: fileURLToPath(new URL("./__fixtures__/fake-react.mjs", import.meta.url)) },
});
const ReactFake = await jiti.import("react");
const { useTeamPlan, TEAM_PLAN_POLL_MS } = await jiti.import("./useTeamPlan.ts");

const PLAN = {
  planId: "p-1",
  sessionId: "s-lead",
  teamName: "demo",
  incarnationId: "inc-1",
  state: "review_pending",
  revision: 3,
  leaderRuntime: { providerId: "openai", modelId: "gpt-5" },
  members: [],
  tasks: [],
  updatedAt: 0,
};

/** mount 一个 hook：返回读当前返回值 / flush effects / 重渲染 的句柄。 */
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
    rerender: () => { render(); return latest; },
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
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("teamName=null → 零 fetch", (t) => {
  const env = installEnv([]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, null, 0);
  h.flush();
  assert.equal(env.calls.length, 0, "不拉取");
  assert.equal(h.current.plan, null);
  assert.equal(h.current.error, null);
});

test("成功 → plan 落地，并按 TEAM_PLAN_POLL_MS 排下一次拉取", async (t) => {
  const env = installEnv([{ ok: true, body: { plan: PLAN } }]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();              // 执行 effect → load()
  await flush();          // fetch + setPlan 落地
  assert.equal(env.calls.length, 1);
  assert.match(env.calls[0].url, /\/api\/teams\/demo\/plan$/);
  assert.equal(env.calls[0].init.cache, "no-store");
  assert.equal(h.current.plan.planId, "p-1", "plan 落地");
  assert.equal(h.current.error, null);
  assert.equal(env.timers.length, 1, "排了一次轮询");
  assert.equal(env.timers[0].delay, TEAM_PLAN_POLL_MS, "轮询间隔 = 2s");
});

test("HTTP 非 ok → error 文案，plan 保持空", async (t) => {
  installEnv([{ ok: false, status: 503, body: {} }]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  assert.equal(h.current.plan, null);
  assert.match(h.current.error, /503/);
});

test("approve 的 POST body 四字段齐全 + 确定性 requestId（服务端生成）", async (t) => {
  const env = installEnv([
    { ok: true, body: { plan: PLAN } },
    { ok: true, status: 200, body: { ok: true, requestId: "desktop-approve-p-1-r3" } },
  ]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();

  const result = await h.current.approve();
  assert.equal(result.ok, true);

  const post = env.calls.find((call) => call.init && call.init.method === "POST");
  assert.ok(post, "发出了 POST");
  assert.match(post.url, /\/api\/teams\/demo\/plan\/approve$/);
  const body = JSON.parse(post.init.body);
  assert.deepEqual(
    Object.keys(body).sort(),
    ["expectedRevision", "incarnationId", "planId", "sessionId"],
    "只带 identity 四字段；requestId 由服务端确定性生成，客户端不传",
  );
  assert.equal(body.planId, "p-1");
  assert.equal(body.sessionId, "s-lead");
  assert.equal(body.incarnationId, "inc-1");
  assert.equal(body.expectedRevision, 3);
});

test("approve 失败 → { ok:false, reason }", async (t) => {
  installEnv([
    { ok: true, body: { plan: PLAN } },
    { ok: false, status: 502, body: { ok: false, reason: "lead 会话正在运行，跳过以免打断" } },
  ]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();

  const result = await h.current.approve();
  assert.equal(result.ok, false);
  assert.match(result.reason, /正在运行/);
});

test("无 plan 时 approve → 不 fetch，返回 { ok:false }", async (t) => {
  const env = installEnv([]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();  // fetch 返回 undefined？—— 队列空会抛，故 load() 进 catch；这里只断言 approve 不新增 fetch
  const before = env.calls.length;
  const result = await h.current.approve();
  assert.equal(result.ok, false);
  assert.equal(env.calls.length, before, "approve 前无 plan：不发请求");
});
