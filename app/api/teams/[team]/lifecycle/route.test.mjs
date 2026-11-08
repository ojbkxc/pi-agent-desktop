import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");
const { sanitizeTeamName } = await jiti.import("@/lib/agent-teams-swimlane-store.ts");
const { getLifecycle } = await jiti.import("pi-team");

/**
 * 路由层：HTTP 契约（200/400/404/409）+ 与 pi-team 进程级生命周期 registry 的真实接线。
 * 这里只在 globalThis.__piTeamLifecycles 里放**假实例**（不 import pi-team 的真实类），
 * 以验证「key 用原始团队名、实例不存在必须失败、reclaim 强顺序」三条硬要求。
 */

const RAW_NAME = "前端重构队";
const DIR_NAME = sanitizeTeamName(RAW_NAME); // "-----"

function fakeLifecycle({ failFor = [], silentFailFor = [], staleFor = [] } = {}) {
  const calls = [];
  const entries = new Map();
  return {
    calls,
    entries,
    async get(name) {
      return entries.get(name);
    },
    async release(name, options) {
      calls.push({ name, options });
      if (failFor.includes(name)) throw new Error(`host stop failed: ${name}`);
      const before = entries.get(name) ?? { name, status: "idle", generation: 1 };
      const after = silentFailFor.includes(name)
        ? { ...before, status: "idle", generation: before.generation + 1 }
        : staleFor.includes(name)
          ? { ...before, status: "parked", generation: before.generation }
          : { ...before, status: options?.tombstone ? "aborted" : "parked", generation: before.generation + 1 };
      entries.set(name, after);
      return after;
    },
    dispose() {},
  };
}

async function setup(t, { rawName = RAW_NAME, members, lifecycleEntries = {}, instance = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-lifecycle-"));
  const previousDir = process.env.PI_TEAM_DIR;
  const previousRegistry = globalThis.__piTeamLifecycles;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previousDir;
    if (previousRegistry === undefined) delete globalThis.__piTeamLifecycles;
    else globalThis.__piTeamLifecycles = previousRegistry;
    await rm(root, { recursive: true, force: true });
  });

  const dir = join(root, DIR_NAME);
  await mkdir(join(dir, "inboxes"), { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({
    name: rawName,
    members: members ?? [
      { agentId: "m-impl", name: "impl", joinedAt: 1, cwd: "" },
      { agentId: "m-qa", name: "qa", joinedAt: 1, cwd: "" },
    ],
  }));
  await writeFile(join(dir, "lifecycle.json"), JSON.stringify({
    version: 1,
    members: lifecycleEntries,
  }));

  const lifecycle = fakeLifecycle();
  // 假实例的 entries 必须与磁盘 lifecycle.json 同源（真实 pi-team 的 registry 条目
  // 就是从磁盘装载的同一份账）：release 回执校验比较的 before 是磁盘读数，假实例
  // 脱节会让「代数前进」比较两套账，永远对不上。
  if (Object.keys(lifecycleEntries).length > 0) {
    for (const [name, entry] of Object.entries(lifecycleEntries)) {
      lifecycle.entries.set(name, { ...entry });
    }
  } else {
    lifecycle.entries.set("impl", { name: "impl", status: "idle", generation: 1 });
    lifecycle.entries.set("qa", { name: "qa", status: "running", generation: 2 });
  }
  globalThis.__piTeamLifecycles = new Map(instance ? [[rawName, lifecycle]] : []);

  return { root, dir, lifecycle };
}

const post = (body, team = DIR_NAME) => route.POST(
  new Request(`http://localhost/api/teams/${encodeURIComponent(team)}/lifecycle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }),
  { params: Promise.resolve({ team }) },
);

// ── 基础 ───────────────────────────────────────────────────────────────────────

test("stop：200、逐成员 stopped、不删目录、用原始团队名取实例", async (t) => {
  const { dir, lifecycle } = await setup(t);
  const res = await post({ action: "stop" });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.removed, false);
  assert.equal(body.team, DIR_NAME, "响应里的 team 是目录名（HTTP 契约的 [team]）");
  assert.equal(body.action, "stop");
  assert.deepEqual(body.results.map((r) => r.status), ["stopped", "stopped"]);

  assert.deepEqual(lifecycle.calls.map((call) => call.name), ["impl", "qa"], "逐成员顺序停止");
  assert.ok(lifecycle.calls.every((call) => call.options?.tombstone === false), "stop 用 release(tombstone:false)，保留可复活");
  assert.ok((await readdir(dir)).includes("config.json"), "目录还在");
});

test("registry key 用 config.name：拿目录名当 key 不会有实例 → 409 而非假成功", async (t) => {
  // 只有原始名注册了实例；目录名（-----）没注册。
  const { dir } = await setup(t);
  assert.ok((await readdir(dir)).length > 0);

  const res = await post({ action: "stop" }, DIR_NAME);
  assert.equal(res.status, 200, "正常路径：路由按原始名找到了实例");

  // 反向验证：把实例注册到目录名下（错误做法）→ 按原始名查不到。v8 契约下
  // 走磁盘+probe 分支（真 rpc-manager 无这些会话 → probe=false），绝不假探错 key。
  const wrong = fakeLifecycle();
  globalThis.__piTeamLifecycles = new Map([[DIR_NAME, wrong]]);
  const bad = await post({ action: "stop" });
  assert.equal(bad.status, 200, "无实例走磁盘+probe 分支（v4 §2），不再 409");
  const body = await bad.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.results.map((r) => r.evidence), ["disk", "disk"], "成员有名无 sessionId，纯磁盘证据");
  assert.equal(wrong.calls.length, 0, "不会去动错 key 下的实例");
});

test("T1d route 层：实例完全不存在 → 磁盘+probe 判停，reclaim 删目录（重启后不再死锁）", async (t) => {
  const { dir } = await setup(t, { instance: false });
  const res = await post({ action: "reclaim" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.removed, true);
  assert.deepEqual(body.results.map((r) => r.evidence), ["disk", "disk"]);
  assert.deepEqual(await readdir(dir).catch(() => []), [], "目录已删");
});

test("团队不存在：404", async (t) => {
  await setup(t);
  const res = await post({ action: "stop" }, "ghost-team");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "团队不存在");
});

test("body 非法：400（缺 action / 未知 action / 非 JSON）", async (t) => {
  await setup(t);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ action: "nuke" })).status, 400);
  assert.equal((await post("not json")).status, 400);
});

// ── 回执校验 ───────────────────────────────────────────────────────────────────

test("成员停止抛错：409，该成员 failed 且原因原样透传", async (t) => {
  const { lifecycle } = await setup(t);
  lifecycle.release = async (name, options) => {
    lifecycle.calls.push({ name, options });
    if (name === "impl") throw new Error("host stop failed: impl");
    return { name, status: "parked", generation: 99 };
  };

  const res = await post({ action: "stop" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  const byName = Object.fromEntries(body.results.map((r) => [r.name, r]));
  assert.equal(byName.impl.status, "failed");
  assert.equal(byName.impl.reason, "host stop failed: impl");
  assert.equal(byName.qa.status, "stopped");
});

test("release 静默失败（status 未落到 parked）：409，不认成功", async (t) => {
  const { lifecycle } = await setup(t);
  const base = lifecycle.entries.get("impl");
  lifecycle.release = async (name, options) => {
    lifecycle.calls.push({ name, options });
    if (name === "impl") return { ...base, status: "idle", generation: base.generation + 1 };
    return { name, status: "parked", generation: 50 };
  };

  const res = await post({ action: "stop" });
  assert.equal(res.status, 409);
  const body = await res.json();
  const impl = body.results.find((r) => r.name === "impl");
  assert.equal(impl.status, "failed");
  assert.match(impl.reason, /回执异常/);
});

test("T2 route 层：parked 旧账不跳过 release——显式 stop 对全员执行全链", async (t) => {
  const { lifecycle } = await setup(t, {
    lifecycleEntries: { qa: { name: "qa", status: "parked", generation: 5 } },
  });
  const res = await post({ action: "stop" });
  assert.equal(res.status, 200);
  const body = await res.json();
  const byName = Object.fromEntries(body.results.map((r) => [r.name, r]));
  assert.equal(byName.qa.status, "stopped", "parked 旧账成员也被强制 release（v4 §1b）");
  assert.deepEqual(lifecycle.calls.map((call) => call.name), ["impl", "qa"], "全员 release");
});

// ── reclaim ────────────────────────────────────────────────────────────────────

test("reclaim 全部成功：200、removed=true、目录被删", async (t) => {
  const { root } = await setup(t);
  const res = await post({ action: "reclaim" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.removed, true);
  assert.deepEqual(await readdir(root), [], "团队目录已删除");
});

test("reclaim 中途失败：409、removed=false、目录完整保留", async (t) => {
  const { root, dir, lifecycle } = await setup(t);
  lifecycle.release = async (name, options) => {
    lifecycle.calls.push({ name, options });
    if (name === "qa") throw new Error("boom");
    return { name, status: "parked", generation: 10 };
  };

  const res = await post({ action: "reclaim" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.removed, false);
  assert.deepEqual(body.results.map((r) => r.status), ["stopped", "failed"]);
  assert.deepEqual(await readdir(root), [DIR_NAME], "根目录仍只有该团队");
  assert.ok((await readdir(dir)).includes("config.json"), "团队文件未被删除");
});

test("stop 即使全部成功也不删目录", async (t) => {
  const { dir } = await setup(t);
  const res = await post({ action: "stop" });
  assert.equal((await res.json()).removed, false);
  assert.ok((await readdir(dir)).includes("config.json"));
});

// ── 进程内残留实例清理（回收后同名重建的必要条件）──────────────────────────────

test("reclaim 成功：从全局注册表清理残留 lifecycle/bus 实例", async (t) => {
  const { lifecycle } = await setup(t);
  let lifecycleDisposed = false;
  let busDisposed = false;
  lifecycle.dispose = () => { lifecycleDisposed = true; };
  const previousBuses = globalThis.__piTeamBuses;
  globalThis.__piTeamBuses = new Map([[RAW_NAME, { dispose() { busDisposed = true; } }]]);
  t.after(() => {
    if (previousBuses === undefined) delete globalThis.__piTeamBuses;
    else globalThis.__piTeamBuses = previousBuses;
  });

  const res = await post({ action: "reclaim" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.cleanup, { lifecycle: true, bus: true }, "两条注册表都命中并清理");
  assert.equal(lifecycleDisposed, true, "旧 lifecycle 实例被 dispose");
  assert.equal(busDisposed, true, "旧 bus 实例被 dispose");
  assert.equal(globalThis.__piTeamLifecycles.has(RAW_NAME), false, "残留 lifecycle 键已从全局 Map 消失");
  assert.equal(globalThis.__piTeamBuses.has(RAW_NAME), false, "残留 bus 键已从全局 Map 消失");
});

test("回收后同名再建：getLifecycle 拿到的是新实例，不继承旧成员状态", async (t) => {
  const { lifecycle } = await setup(t);
  await post({ action: "reclaim" });

  const registry = globalThis.__piTeamLifecycles;
  assert.equal(registry.has(RAW_NAME), false, "旧实例键已删");

  // 再取即会新建——这是「同名重建复用已 dispose 旧实例」的根因修复点。
  const fresh = getLifecycle(RAW_NAME, {});
  assert.notEqual(fresh, lifecycle, "同名团队拿到的是新实例");
  assert.deepEqual(await fresh.list(), [], "新实例不继承旧成员状态（generation/状态都不继承）");
});

test("stop 不动进程内实例（团队仍在，实例保留）", async (t) => {
  const { lifecycle } = await setup(t);
  const res = await post({ action: "stop" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cleanup, undefined, "stop 不返回 cleanup");
  assert.equal(globalThis.__piTeamLifecycles.get(RAW_NAME), lifecycle, "实例原地保留");
});

// ── 运行态真验证（回执不证明会话已停）──────────────────────────────────────────

function withSession(t, sessionId, isRunning) {
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[sessionId, { isRunning: () => isRunning }]]);
  t.after(() => {
    if (previous === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = previous;
  });
}

test("reclaim：成员会话仍在运行 → 409、不删目录（真探运行态）", async (t) => {
  // config 给成员一个 sessionId；lifecycle 条目也带同一 sessionId（会话口径）。
  const { dir } = await setup(t, {
    members: [{ agentId: "m-impl", name: "impl", sessionId: "s-impl", joinedAt: 1, cwd: "" }],
    lifecycleEntries: { impl: { name: "impl", status: "idle", generation: 1, sessionId: "s-impl" } },
  });
  withSession(t, "s-impl", true);

  const res = await post({ action: "reclaim" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.removed, false);
  assert.equal(body.results[0].status, "failed");
  assert.match(body.results[0].reason, /仍在运行/);
  assert.ok((await readdir(dir)).includes("config.json"), "会话还在跑 → 目录必须保留");
});

test("reclaim：会话已停（isRunning=false）→ 200、正常删目录", async (t) => {
  const { root } = await setup(t, {
    members: [{ agentId: "m-impl", name: "impl", sessionId: "s-impl", joinedAt: 1, cwd: "" }],
    lifecycleEntries: { impl: { name: "impl", status: "idle", generation: 1, sessionId: "s-impl" } },
  });
  withSession(t, "s-impl", false);

  const res = await post({ action: "reclaim" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.removed, true);
  assert.deepEqual(await readdir(root), [], "确认已停后才删目录");
});

test("reclaim：会话不存在（getRpcSession 未命中）→ 视为已停、stopped", async (t) => {
  const { root } = await setup(t, {
    members: [{ agentId: "m-impl", name: "impl", sessionId: "s-ghost", joinedAt: 1, cwd: "" }],
    lifecycleEntries: { impl: { name: "impl", status: "idle", generation: 1, sessionId: "s-ghost" } },
  });
  // __piSessions 里没有 s-ghost → getRpcSession 返回 undefined → 视为已停。
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map();
  t.after(() => {
    if (previous === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = previous;
  });

  const res = await post({ action: "reclaim" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].status, "stopped");
  assert.deepEqual(await readdir(root), [], "无会话即视为已停，可删");
});