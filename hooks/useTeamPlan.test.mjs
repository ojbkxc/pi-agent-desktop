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
const { useTeamPlan, acceptPlan, TEAM_PLAN_POLL_MS } = await jiti.import("./useTeamPlan.ts");

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

/** mount 一个 hook：返回读当前返回值 / flush effects / 重渲染 / 改参数 / 卸载的句柄。 */
function mount(hook, ...initialArgs) {
  const args = initialArgs.slice();
  let latest;
  let renders = 0;
  let cleanups = [];
  const render = () => {
    ReactFake.__beginRender();
    latest = hook(...args);
  };
  ReactFake.__setNotify(() => {
    renders += 1;
    render();
  });
  ReactFake.__reset();
  render();
  return {
    get current() { return latest; },
    /** setState 触发过的重渲染次数（用来断言「卸载后不再 setState」）。 */
    get renders() { return renders; },
    flush: () => {
      cleanups = cleanups.concat(ReactFake.__flushEffects());
    },
    /** 卸载：跑所有 effect 的 cleanup（替身不会自己跑）。 */
    unmount: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    rerender: () => { render(); return latest; },
    /** 换参数（如切换团队）后同步重渲染。 */
    setArgs: (...next) => { args.length = 0; args.push(...next); render(); return latest; },
  };
}

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realAbortTimeout = AbortSignal.timeout;

/** 造一个 Response 形状的最小对象（fetch 桩返回）。 */
function mkResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * 装 fetch / 定时器桩；responses 是队列，每次 fetch 取一个。
 * 队列项可为 `{ ok, status, body }`，或 `{ reject: Error }`（模拟超时/网络拒绝）。
 * AbortSignal.timeout 换成立即返回 undefined：hook 只用它挂 signal，桩不看信号；
 * 真定时器会拖住 node 退出。
 */
function installEnv(responses) {
  const calls = [];
  const timers = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more fetch responses queued");
    if (next.reject) throw next.reject;
    return mkResponse(next.status ?? (next.ok ? 200 : 500), next.body);
  };
  globalThis.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  globalThis.clearTimeout = () => {};
  AbortSignal.timeout = () => undefined;
  return { calls, timers };
}

/** 装一个「手动 resolve」的 fetch 桩：每次 fetch 返回未决 promise，测试自己 resolve/reject。 */
function installDeferredEnv() {
  const calls = [];
  const timers = [];
  const pending = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
  };
  globalThis.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  globalThis.clearTimeout = () => {};
  AbortSignal.timeout = () => undefined;
  return { calls, timers, pending };
}

function restoreEnv() {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  AbortSignal.timeout = realAbortTimeout;
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

test("approve 失败 → approveError 落地（调用方丢返回值也看得见）", async (t) => {
  installEnv([
    { ok: true, body: { plan: PLAN } },
    { ok: false, status: 502, body: { ok: false, reason: "投递失败：找不到 lead 会话" } },
  ]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();

  assert.equal(h.current.approveError, null, "初始为空");
  await h.current.approve();
  assert.match(h.current.approveError, /找不到 lead 会话/, "失败原因留在这里给界面显示");
});

test("approve 成功 → 清掉上一次的 approveError", async (t) => {
  installEnv([
    { ok: true, body: { plan: PLAN } },
    { ok: false, status: 502, body: { ok: false, reason: "boom" } },
    { ok: true, status: 200, body: { ok: true, requestId: "desktop-approve-p-1-r3" } },
  ]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();

  await h.current.approve();
  assert.equal(h.current.approveError, "boom");
  await h.current.approve();
  assert.equal(h.current.approveError, null, "重试成功后不再显示旧错误");
});

test("saveAndApprove：先 PATCH 再用保存后的 revision 投递批准", async (t) => {
  const savedPlan = { ...PLAN, revision: 4 };
  const env = installEnv([
    { ok: true, body: { plan: PLAN } },                                   // 初始 GET
    { ok: true, status: 200, body: { plan: savedPlan } },                 // PATCH
    { ok: true, status: 200, body: { ok: true, requestId: "desktop-approve-p-1-r4" } }, // POST approve
  ]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();

  const result = await h.current.saveAndApprove({
    members: [{ id: "m1", runtime: { providerId: "anthropic", modelId: "claude" } }],
    tasks: [],
  });
  assert.equal(result.ok, true);

  const patch = env.calls.find((call) => call.init?.method === "PATCH");
  const post = env.calls.find((call) => call.init?.method === "POST");
  assert.ok(patch, "先保存");
  assert.ok(post, "再批准");
  assert.equal(JSON.parse(patch.init.body).expectedRevision, 3, "PATCH 用旧 revision");
  assert.equal(JSON.parse(post.init.body).expectedRevision, 4, "批准用保存后的 revision（否则 409）");
});

test("saveAndApprove：无改动时直接批准，不发 PATCH", async (t) => {
  const env = installEnv([
    { ok: true, body: { plan: PLAN } },
    { ok: true, status: 200, body: { ok: true, requestId: "desktop-approve-p-1-r3" } },
  ]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();

  const result = await h.current.saveAndApprove(null);
  assert.equal(result.ok, true);
  assert.equal(env.calls.some((call) => call.init?.method === "PATCH"), false, "无 diff 不保存");
  const post = env.calls.find((call) => call.init?.method === "POST");
  assert.equal(JSON.parse(post.init.body).expectedRevision, 3);
});

test("saveAndApprove：保存失败时不批准", async (t) => {
  const env = installEnv([
    { ok: true, body: { plan: PLAN } },
    { ok: false, status: 500, body: { error: "写盘失败" } },
  ]);
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();

  const result = await h.current.saveAndApprove({
    members: [{ id: "m1", runtime: { providerId: "anthropic", modelId: "claude" } }],
    tasks: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /写盘失败/);
  assert.equal(env.calls.some((call) => call.init?.method === "POST"), false, "保存失败不得投递批准");
});

// ── T9：轮询竞态 / 超时 / 换团队清错误 ─────────────────────────────────────────
test("tick 补拉期间保留旧 plan，新响应经 acceptPlan 接纳后才替换", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  assert.equal(env.pending.length, 1, "首次拉取已发出");
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();
  assert.equal(h.current.plan.revision, 3);

  // 触发一次补拉（refresh → tick++ → effect 重跑）。这是「刷新」而不是「换团队」：
  // 不应清空旧 plan。
  h.current.refresh();
  h.flush();
  await flush();
  assert.equal(env.pending.length, 2, "补拉发出新请求");
  assert.equal(h.current.plan.revision, 3, "补拉期间旧 plan 必须保留（不能闪空）");

  env.pending[1].resolve(mkResponse(200, { plan: { ...PLAN, revision: 4 } }));
  await flush();
  assert.equal(h.current.plan.revision, 4, "新响应被 acceptPlan 接纳");
});

test("超时/网络失败：error 落地并按 TEAM_PLAN_POLL_MS 重排（不会永久停摆）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].reject(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }));
  await flush();
  assert.ok(h.current.error, "超时必须暴露 error（按失败处理）");
  assert.match(h.current.error, /timed out|Timeout/i);
  assert.equal(env.timers.at(-1).delay, TEAM_PLAN_POLL_MS, "失败后仍重排下一轮轮询");
});

test("换团队：清掉 plan 与 saveError/conflict/approveError（不串团队）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();
  assert.equal(h.current.plan.revision, 3);

  // 制造一次批准失败 → approveError 落地（并触发一次补拉 tick）。
  const approved = h.current.approve();
  await flush();
  env.pending[1].resolve(mkResponse(502, { ok: false, reason: "boom" }));
  await approved;
  assert.equal(h.current.approveError, "boom");

  // 切团队：重渲染跑「换团队清空」effect（不 await 新 fetch 的挂起 promise）。
  h.setArgs("other");
  h.flush();
  assert.equal(h.current.plan, null, "换团队清空 plan");
  assert.equal(h.current.approveError, null, "批准错误随团队切换清掉");
  assert.equal(h.current.saveError, null);
  assert.equal(h.current.conflict, false);
});

// ── T10：并发纪律（请求序号 / 写优先 / 卸载 / 单飞）─────────────────────────────
test("refresh 后晚到的旧请求被丢弃（请求序号），不会用陈旧数据覆盖新数据", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  assert.equal(env.pending.length, 1, "首轮拉取挂起");

  // 补拉（refresh → tick → effect 重跑）发出第二个请求。
  h.current.refresh();
  h.flush();
  await flush();
  assert.equal(env.pending.length, 2);

  // 旧请求后到，且带着一个 revision 更高的计划——acceptPlan 会照收，所以必须在落地前
  // 就按请求序号丢弃，否则它就是「旧请求回来覆盖新数据」。
  env.pending[0].resolve(mkResponse(200, { plan: { ...PLAN, revision: 99 } }));
  await flush();
  assert.equal(h.current.plan, null, "旧请求的数据一条都不能落地");

  env.pending[1].resolve(mkResponse(200, { plan: PLAN }));
  await flush();
  assert.equal(h.current.plan.revision, 3, "只有最新一轮的响应生效");
});

test("写操作在途时轮询让路（不抢读旧 revision，避免 409 / 按钮闪）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();
  assert.equal(h.current.plan.revision, 3);

  const approving = h.current.approve();
  await flush();
  assert.equal(env.calls.filter((call) => call.init?.method === "POST").length, 1, "批准已发出");
  const pendingBefore = env.pending.length;

  // 模拟 2s 到了：补拉一次。写操作在途 → 不发 GET，只重排下一轮。
  h.current.refresh();
  h.flush();
  await flush();
  assert.equal(env.pending.length, pendingBefore, "写操作在途期间不新增读请求");

  env.pending[pendingBefore - 1].resolve(mkResponse(200, { ok: true, requestId: "desktop-approve-p-1-r3" }));
  const result = await approving;
  assert.equal(result.ok, true);
  assert.equal(h.current.busy, false, "投递结束后 busy 复位");
});

test("连点批准：第二下被单飞拦下，不会重复投递（重复投递 = lead 重复 approve/launch）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  const first = h.current.approve();
  const second = await h.current.approve();
  assert.equal(second.ok, false);
  assert.match(second.reason, /进行中/);
  assert.equal(env.calls.filter((call) => call.init?.method === "POST").length, 1, "只发一次 POST");

  const postIndex = env.pending.length - 1;
  env.pending[postIndex].resolve(mkResponse(200, { ok: true, requestId: "desktop-approve-p-1-r3" }));
  assert.equal((await first).ok, true);
});

test("批准 409（计划已变）→ approveError + conflict（界面能出现「重新载入」）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  const approving = h.current.approve();
  await flush();
  env.pending[env.pending.length - 1].resolve(
    mkResponse(409, { ok: false, reason: "plan changed; refresh before continuing" }),
  );
  await approving;

  assert.match(h.current.approveError, /plan changed/, "原因要落到可见错误上");
  assert.equal(h.current.conflict, true, "identity 409 也是「基线过期」：要给重新载入入口");
});

test("门禁 403 的 error 字段也能显示（不只是 reason）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  const approving = h.current.approve();
  await flush();
  env.pending[env.pending.length - 1].resolve(mkResponse(403, { ok: false, error: "Untrusted API request" }));
  await approving;
  assert.match(h.current.approveError, /Untrusted API request/);
});

test("保存超时 → saveError + conflict（写入可能已生效，只能重新载入确认）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  const saving = h.current.saveAndApprove({
    members: [{ id: "m1", runtime: { providerId: "anthropic", modelId: "claude" } }],
    tasks: [],
  });
  await flush();
  env.pending[env.pending.length - 1].reject(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }));
  const result = await saving;

  assert.equal(result.ok, false);
  assert.match(h.current.saveError, /保存超时/);
  assert.equal(h.current.conflict, true, "超时无法判断是否落盘 → 必须引导重新载入");
  assert.equal(env.calls.filter((call) => call.init?.method === "POST").length, 0, "保存失败不得投递批准");
  assert.equal(h.current.busy, false);
  assert.equal(h.current.saving, false);
});

test("卸载后晚到的响应不再 setState（不 setState after unmount）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  assert.equal(env.pending.length, 1);

  const rendersBefore = h.renders;
  h.unmount();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();
  assert.equal(h.renders, rendersBefore, "没有任何重渲染");
  assert.equal(h.current.plan, null, "计划没有落地");
});

// ── T11：计划退场 / 读空确认 ─────────────────────────────────────────────────
/** 跑「最近一次」定时器（替身只记录，不执行）。 */
function runLastTimer(env) {
  const timer = env.timers.at(-1);
  assert.ok(timer, "应有排队的定时器");
  timer.fn();
}

test("一次读空不清空计划（写盘的瞬时窗口不能让卡片闪一下），连续两次才认", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  // 第一次 null：保留旧计划，并排一次「确认」轮询（250ms，比常规 2s 快）。
  h.current.refresh();
  h.flush();
  await flush();
  env.pending[env.pending.length - 1].resolve(mkResponse(200, { plan: null }));
  await flush();
  assert.equal(h.current.plan.revision, 3, "单次 null 保留旧计划");
  const lastTimer = env.timers.at(-1);
  assert.ok(lastTimer.delay < TEAM_PLAN_POLL_MS, "确认轮询要比常规轮询更快");

  // 第二次 null：确认「计划真的没了」→ 清空。
  runLastTimer(env);
  await flush();
  env.pending[env.pending.length - 1].resolve(mkResponse(200, { plan: null }));
  await flush();
  assert.equal(h.current.plan, null, "连续两次 null 才清空");
});

test("计划消失 → 连带清掉 saveError / conflict / approveError（不把 A 计划的错误挂在空卡上）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  // 制造一次批准 409 → approveError + conflict。
  const approving = h.current.approve();
  await flush();
  env.pending[env.pending.length - 1].resolve(mkResponse(409, { ok: false, reason: "plan changed" }));
  await approving;
  assert.equal(h.current.conflict, true);

  // 计划被删：连续两次 null。
  h.current.refresh();
  h.flush();
  await flush();
  env.pending[env.pending.length - 1].resolve(mkResponse(200, { plan: null }));
  await flush();
  runLastTimer(env);
  await flush();
  env.pending[env.pending.length - 1].resolve(mkResponse(200, { plan: null }));
  await flush();

  assert.equal(h.current.plan, null);
  assert.equal(h.current.approveError, null, "旧错误不能留在空卡上");
  assert.equal(h.current.conflict, false);
  assert.equal(h.current.saveError, null);
});

test("计划离开 review_pending（→ launching）→ 清掉保存/批准错误：已进入派发阶段，错误无从修复", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  const approving = h.current.approve();
  await flush();
  env.pending[env.pending.length - 1].resolve(mkResponse(502, { ok: false, reason: "lead 会话正在运行" }));
  await approving;
  assert.match(h.current.approveError, /正在运行/);

  // 补拉拿到 launching（lead 已经自己批了/派发中）。
  h.current.refresh();
  h.flush();
  await flush();
  env.pending[env.pending.length - 1].resolve(mkResponse(200, { plan: { ...PLAN, state: "launching", revision: 4 } }));
  await flush();
  assert.equal(h.current.plan.state, "launching");
  assert.equal(h.current.approveError, null, "退场后不留残影");
});

test("saveAndApprove 期间 busy 覆盖「保存 + 投递」两段（按钮不会闪回可用）", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  const running = h.current.saveAndApprove({
    members: [{ id: "m1", runtime: { providerId: "anthropic", modelId: "claude" } }],
    tasks: [],
  });
  await flush();
  assert.equal(h.current.busy, true, "PATCH 阶段就是 busy");
  assert.equal(h.current.saving, true);

  // PATCH 回来：revision +1，紧接着投递批准。
  env.pending[env.pending.length - 1].resolve(mkResponse(200, { plan: { ...PLAN, revision: 4 } }));
  await flush();
  assert.equal(h.current.saving, false);
  assert.equal(h.current.busy, true, "投递阶段仍是 busy");

  const post = env.calls.filter((call) => call.init?.method === "POST").at(-1);
  assert.equal(JSON.parse(post.init.body).expectedRevision, 4, "用保存后的 revision 投递");
  env.pending[env.pending.length - 1].resolve(mkResponse(200, { ok: true, requestId: "desktop-approve-p-1-r4" }));
  assert.equal((await running).ok, true);
  assert.equal(h.current.busy, false);
});

test("saveAndApprove 的 PATCH 409 → conflict + saveError + approveError（点批准也有可见原因），不投递", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mount(useTeamPlan, "demo", 0);
  h.flush();
  await flush();
  env.pending[0].resolve(mkResponse(200, { plan: PLAN }));
  await flush();

  const running = h.current.saveAndApprove({
    members: [{ id: "m1", runtime: { providerId: "anthropic", modelId: "claude" } }],
    tasks: [],
  });
  await flush();
  env.pending[env.pending.length - 1].resolve(
    mkResponse(409, { error: "plan changed; refresh before continuing" }),
  );
  const result = await running;

  assert.equal(result.ok, false);
  assert.equal(h.current.conflict, true, "409 要给「重新载入」入口");
  assert.match(h.current.saveError, /plan changed/);
  assert.match(h.current.approveError, /批准没有发出/, "批准区也要有原因（按钮点下去不能像没反应）");
  assert.equal(env.calls.filter((call) => call.init?.method === "POST").length, 0, "保存冲突不得投递批准");
  assert.equal(h.current.busy, false);
});

test("acceptPlan：同世系里更小的 revision 被忽略（轮询不能回退刚保存的计划）", () => {
  const newer = { ...PLAN, revision: 5 };
  const stale = { ...PLAN, revision: 3 };
  assert.equal(acceptPlan(newer, stale), newer, "陈旧轮询响应被丢弃");
  assert.equal(acceptPlan(stale, newer), newer, "更新的照收");

  // 同 revision 的重复内容必须保住**对象身份**：PlanEditor 以 plan 为依赖重置草稿，
  // 若每 2s 都换新对象，用户正在编辑、尚未保存的内容会被周期性地清空。
  const sameContentDifferentObject = { ...PLAN, revision: 5 };
  assert.notEqual(sameContentDifferentObject, newer);
  assert.equal(acceptPlan(newer, sameContentDifferentObject), newer, "同 revision 保留原对象身份");

  // 换世系（新计划 / 换团队）：revision 从 1 重来也必须接受。
  const nextPlan = { ...PLAN, planId: "p-2", incarnationId: "inc-2", revision: 1 };
  assert.equal(acceptPlan(newer, nextPlan), nextPlan, "换 planId 一律接受");
  const nextIncarnation = { ...PLAN, incarnationId: "inc-9", revision: 1 };
  assert.equal(acceptPlan(newer, nextIncarnation), nextIncarnation, "换 incarnation 一律接受");

  // 服务端说没有计划 → 清空。
  assert.equal(acceptPlan(newer, null), null);
  assert.equal(acceptPlan(null, PLAN), PLAN);
  assert.equal(acceptPlan(newer, { ...newer, revision: 6 }).revision, 6, "更高 revision 照收");
});
