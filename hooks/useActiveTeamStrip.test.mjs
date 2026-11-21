import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// 会话头部团队条（B1）单测：显示态派生、进度口径、活跃期判定，并用 fake-react 手动驱动
// hook 的轮询 effect（无 DOM）。只用一个 jiti 实例——两个交互实例会共享 Node 的模块缓存，
// 第二次 import 会复用首次绑定的真实 react，hook 驱动就失效了。
const jiti = createJiti(import.meta.url, {
  alias: {
    react: fileURLToPath(new URL("./__fixtures__/fake-react.mjs", import.meta.url)),
    "@": process.cwd(),
  },
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const ReactFake = await jiti.import("react");
const {
  deriveTeamStripPhase,
  deriveTeamStripProgress,
  isActiveTeamPhase,
  useActiveTeamStrip,
  TEAM_STRIP_POLL_MS,
  TEAM_STRIP_RETRY_MS,
} = await jiti.import("./useActiveTeamStrip.ts");

/** 最小成员（投影层 member.status 不含 "failed"）。 */
function member(name, status = "idle") {
  return {
    id: name,
    name,
    role: "member",
    model: null,
    providerName: null,
    color: "blue",
    status,
    activity: "idle",
    sessionId: null,
    cwd: "",
    worktreePath: null,
    lastError: null,
    joinedAt: "",
  };
}

/** 最小票；outcome 非空时带一条 ended 派活（用于 failed 口径）。 */
function ticket(id, status, outcome) {
  return {
    id,
    subject: id,
    description: "",
    ownerId: null,
    status,
    dependencies: [],
    assignments: outcome
      ? [{
        id: `${id}-1`,
        status: "ended",
        memberId: null,
        assignee: "x",
        sessionId: null,
        startedAt: null,
        lastActivityAt: null,
        result: null,
        outcome,
      }]
      : [],
    source: "plan",
    createdAt: "",
  };
}

function snapshot({ members, tickets = [], status = "running" }) {
  return {
    version: 1,
    generatedAt: "",
    team: {
      id: "t",
      name: "t",
      description: "",
      createdAt: "",
      leadSessionId: null,
      status,
      incarnationId: "t",
    },
    members,
    tickets,
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
  };
}

test("无快照 / 空名册 → none（条不渲染、不占位）", () => {
  assert.equal(deriveTeamStripPhase(null), "none");
  assert.equal(deriveTeamStripPhase(snapshot({ members: [] })), "none");
});

test("团队阶段直通", () => {
  assert.equal(deriveTeamStripPhase(snapshot({ members: [member("lead", "running")], status: "running" })), "running");
  assert.equal(deriveTeamStripPhase(snapshot({ members: [member("lead")], status: "completed" })), "completed");
});

test("失败派活 → failed（红），优先于 interrupted", () => {
  const members = [member("lead"), member("w1", "aborted")];
  const tickets = [ticket("t1", "ended", "failed")];
  assert.equal(deriveTeamStripPhase(snapshot({ members, tickets })), "failed");
});

test("成员被中止 → interrupted（黄）", () => {
  const members = [member("lead"), member("w1", "aborted")];
  assert.equal(deriveTeamStripPhase(snapshot({ members })), "interrupted");
});

test("进度：completed 只认紧急度真源（失败票不计入完成）", () => {
  const tickets = [ticket("t1", "ended"), ticket("t2", "ended", "failed"), ticket("t3", "open")];
  assert.deepEqual(
    deriveTeamStripProgress(snapshot({ members: [member("lead")], tickets })),
    { completed: 1, total: 3 },
  );
  assert.deepEqual(deriveTeamStripProgress(null), { completed: 0, total: 0 });
});

test("isActiveTeamPhase 仅活跃期", () => {
  assert.equal(isActiveTeamPhase("forming"), true);
  assert.equal(isActiveTeamPhase("running"), true);
  assert.equal(isActiveTeamPhase("finishing"), true);
  assert.equal(isActiveTeamPhase("completed"), false);
  assert.equal(isActiveTeamPhase("ended"), false);
  assert.equal(isActiveTeamPhase(undefined), false);
});

// ── state.md P2：refreshKey（消息计数）不能把已显示的团队条清空再挂回 ─────────
// 无 DOM 渲染器，hook 的 effect 驱动不了；这里钉住接线形状：setSnapshot(null) 必须
// 在只依赖 sessionId 的独立 effect 里，主轮询 effect 的开头不得再无条件清空。
test("接线：setSnapshot(null) 只在 sessionId 变化时执行（refreshKey 只补拉，不清旧快照）", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("./useActiveTeamStrip.ts", import.meta.url), "utf8");
  const source = raw.replace(/\r\n/g, "\n");

  // 独立的清空 effect：依赖数组里只有 sessionId（快照与 error 一并随换会话清掉）。
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*\n\s*setSnapshot\(null\);\s*\n\s*setError\(null\);\s*\n\s*\}, \[sessionId\]\);/,
    "setSnapshot(null)/setError(null) 必须住在只依赖 sessionId 的 effect 里",
  );
  // 主轮询 effect 的依赖仍是 sessionId + refreshKey（refreshKey 继续触发补拉）。
  assert.match(source, /\}, \[sessionId, refreshKey\]\);/);
  // 主 effect 开头不得再无条件清空（旧缺陷：每发一条消息条就闪一次）。
  const mainEffect = source.slice(source.indexOf("if (!sessionId) return;"));
  const head = mainEffect.slice(0, mainEffect.indexOf("let stopped"));
  assert.doesNotMatch(head, /setSnapshot\(null\)/, "主 effect 开头不得清空快照");
});

// ── T9：hook 轮询的失败/超时出口（fake-react 手动驱动 effect）──────────────────
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realAbortTimeout = AbortSignal.timeout;

function installEnv(responses) {
  const calls = [];
  const timers = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more fetch responses queued");
    if (next.reject) throw next.reject;
    return { ok: next.ok !== false, status: next.status ?? (next.ok === false ? 500 : 200), json: async () => next.body };
  };
  globalThis.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  globalThis.clearTimeout = () => {};
  AbortSignal.timeout = () => undefined;
  return { calls, timers };
}
function installDeferredEnv() {
  const timers = [];
  const pending = [];
  globalThis.fetch = (url, init) => {
    pending.push({ url: String(url), init });
    return new Promise((resolve, reject) => { pending.at(-1).resolve = resolve; pending.at(-1).reject = reject; });
  };
  globalThis.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  globalThis.clearTimeout = () => {};
  AbortSignal.timeout = () => undefined;
  return { timers, pending };
}
function restoreEnv() {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  AbortSignal.timeout = realAbortTimeout;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mountHook(...initialArgs) {
  const args = initialArgs.slice();
  let latest;
  const render = () => {
    ReactFake.__beginRender();
    latest = useActiveTeamStrip(...args);
  };
  ReactFake.__setNotify(() => render());
  ReactFake.__reset();
  render();
  return {
    get current() { return latest; },
    flush: () => ReactFake.__flushEffects(),
    setArgs: (...next) => { args.length = 0; args.push(...next); render(); return latest; },
  };
}

test("hook：成功拉到活跃团队 → 快照落地、error 清空、按 POLL 排期", async (t) => {
  const env = installEnv([{
    ok: true,
    body: snapshot({ members: [member("lead", "running")], status: "running" }),
  }]);
  t.after(restoreEnv);
  const h = mountHook("s1", 0);
  h.flush();
  await flush();
  assert.equal(env.calls.length, 1);
  assert.match(env.calls[0].url, /\/api\/teams\/session\/s1\/workbench$/);
  assert.equal(h.current.snapshot.team.name, "t", "快照落地");
  assert.equal(h.current.error, null);
  assert.equal(env.timers.at(-1).delay, TEAM_STRIP_POLL_MS, "活跃期按 POLL 排期");
});

test("hook：超时/网络失败 → error 落地并按 RETRY 重排（不会永久停摆）", async (t) => {
  const env = installEnv([{ reject: Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }) }]);
  t.after(restoreEnv);
  const h = mountHook("s1", 0);
  h.flush();
  await flush();
  assert.ok(h.current.error, "超时必须暴露 error");
  assert.match(h.current.error, /timed out|Timeout/i);
  assert.equal(env.timers.at(-1).delay, TEAM_STRIP_RETRY_MS, "失败后仍重排重试");
});

test("hook：HTTP 非 ok → error 落地并重排 RETRY", async (t) => {
  const env = installEnv([{ ok: false, status: 500, body: {} }]);
  t.after(restoreEnv);
  const h = mountHook("s1", 0);
  h.flush();
  await flush();
  assert.match(h.current.error, /500/);
  assert.equal(env.timers.at(-1).delay, TEAM_STRIP_RETRY_MS);
});

test("hook：同会话 refreshKey 补拉不闪空旧快照；失败也保留最后一次快照", async (t) => {
  const env = installDeferredEnv();
  t.after(restoreEnv);
  const h = mountHook("s1", 0);
  h.flush();
  await flush();
  env.pending[0].resolve({
    ok: true,
    status: 200,
    json: async () => snapshot({ members: [member("lead", "running")], status: "running" }),
  });
  await flush();
  assert.ok(h.current.snapshot);

  h.setArgs("s1", 1); // 同会话，refreshKey 变化
  h.flush();
  await flush();
  assert.equal(env.pending.length, 2, "补拉发出新请求");
  assert.ok(h.current.snapshot, "补拉期间旧快照仍在（不闪空）");

  env.pending[1].resolve({ ok: false, status: 500, json: async () => ({}) });
  await flush();
  assert.match(h.current.error, /500/);
  assert.ok(h.current.snapshot, "失败也保留最后一次快照");
});

