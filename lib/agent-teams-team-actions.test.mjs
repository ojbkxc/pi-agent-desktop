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
const {
  runTeamLifecycleAction,
  readTeamConfig,
  readLifecycleSnapshot,
  removeTeamDirectory,
} = await jiti.import("./agent-teams-team-actions.ts");

/**
 * 编排逻辑用注入式 deps 全量单测（不依赖 pi-team 的真实实例）：
 * key 用原始团队名、实例缺失必须失败、reclaim 强顺序且任一失败不删目录。
 */

const MEMBERS = [
  { agentId: "m-impl", name: "impl" },
  { agentId: "m-qa", name: "qa" },
];

/** 内存 deps：记录 release 调用参数与顺序，可注入失败。 */
function makeDeps({
  rawName = "前端重构队",
  members = MEMBERS,
  instanceExists = true,
  lifecycle = {},
  releaseOutcome = {},
  removeFails = false,
  cleanup,
  cleanupThrows = false,
  running = [],
  probeThrows = false,
} = {}) {
  const calls = [];
  const runningSet = new Set(running);
  const state = { removed: false, lifecycle: { ...lifecycle }, cleaned: [] };
  const deps = {
    async readTeamConfig() {
      return { rawName, members };
    },
    async readLifecycle() {
      return state.lifecycle;
    },
    hasLifecycleInstance(name) {
      calls.push({ kind: "probe", name });
      return instanceExists;
    },
    async release(rawTeamName, memberName) {
      calls.push({ kind: "release", rawTeamName, memberName });
      const outcome = releaseOutcome[memberName];
      if (outcome?.throws) throw new Error(outcome.throws);
      const before = state.lifecycle[memberName] ?? { name: memberName, status: "idle", generation: 1 };
      const after = outcome?.after ?? {
        ...before,
        status: "parked",
        generation: (before.generation ?? 0) + 1,
      };
      state.lifecycle[memberName] = after;
      return after;
    },
    async removeTeamDir() {
      if (removeFails) throw new Error("EBUSY");
      state.removed = true;
    },
    async probeRunning(sessionId) {
      calls.push({ kind: "probeRunning", sessionId });
      if (probeThrows) throw new Error("rpc registry unavailable");
      return runningSet.has(sessionId);
    },
    async dropInstances(rawTeamName) {
      calls.push({ kind: "dropInstances", rawTeamName });
      state.cleaned.push(rawTeamName);
      if (cleanupThrows) throw new Error("registry locked");
      return cleanup ?? { lifecycle: true, bus: true };
    },
  };
  return { deps, calls, state };
}

// ── 基础 ───────────────────────────────────────────────────────────────────────

test("stop：逐成员 release，全部 stopped，不删目录", async () => {
  const { deps, calls, state } = makeDeps();
  const result = await runTeamLifecycleAction(deps, { teamDirName: "-----", action: "stop" });

  assert.equal(result.ok, true);
  assert.equal(result.removed, false);
  assert.equal(state.removed, false, "stop 绝不删目录");
  assert.deepEqual(result.results.map((r) => r.status), ["stopped", "stopped"]);

  const releases = calls.filter((call) => call.kind === "release");
  assert.deepEqual(releases.map((call) => call.memberName), ["impl", "qa"], "逐成员顺序处理");
  assert.deepEqual(releases.map((call) => call.rawTeamName), ["前端重构队", "前端重构队"]);
});

test("registry key 必须是 config.name（原始名），不是 sanitize 后的目录名", async () => {
  const { deps, calls } = makeDeps({ rawName: "前端重构队" });
  await runTeamLifecycleAction(deps, { teamDirName: "-----", action: "stop" });

  const probed = calls.filter((call) => call.kind === "probe").map((call) => call.name);
  const released = calls.filter((call) => call.kind === "release").map((call) => call.rawTeamName);
  assert.deepEqual(probed, ["前端重构队"], "探测用的是原始团队名");
  assert.ok(released.every((name) => name === "前端重构队"), "release 用的是原始团队名");
  assert.ok(!released.includes("-----"), "绝不能用目录名当 registry key");
});

test("生命周期实例不存在：全员 failed，ok=false（不谎报成功）", async () => {
  const { deps, calls, state } = makeDeps({ instanceExists: false });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });

  assert.equal(result.ok, false);
  assert.equal(result.removed, false);
  assert.equal(result.error, "生命周期实例不存在");
  assert.deepEqual(result.results.map((r) => r.status), ["failed", "failed"]);
  assert.match(result.results[0].reason, /生命周期实例不存在/);
  assert.equal(calls.filter((call) => call.kind === "release").length, 0, "实例不在就不尝试 release");
  assert.equal(state.removed, false);
});

test("团队不存在：ok=false，error 可直接映射 404", async () => {
  const deps = { ...makeDeps().deps, readTeamConfig: async () => null };
  const result = await runTeamLifecycleAction(deps, { teamDirName: "ghost", action: "reclaim" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "团队不存在");
  assert.deepEqual(result.results, []);
});

test("config 缺 name：无法定位实例，明确报错", async () => {
  const { deps } = makeDeps({ rawName: "" });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });
  assert.equal(result.ok, false);
  assert.match(result.error, /缺少 name/);
});

// ── 回执校验 ───────────────────────────────────────────────────────────────────

test("release 抛错：该成员 failed，其余继续，整体 ok=false", async () => {
  const { deps } = makeDeps({ releaseOutcome: { impl: { throws: "host stop failed" } } });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });

  assert.equal(result.ok, false);
  const byName = Object.fromEntries(result.results.map((r) => [r.name, r]));
  assert.equal(byName.impl.status, "failed");
  assert.equal(byName.impl.reason, "host stop failed", "错误原样透传");
  assert.equal(byName.qa.status, "stopped", "一个失败不影响其余成员继续停");
});

test("release 静默失败（status 没变 parked）：回执校验判 failed，不认成功", async () => {
  // pi-team 的 release 吞掉 host.stop 异常：没抛错 ≠ 停成功。
  const { deps } = makeDeps({
    releaseOutcome: { impl: { after: { name: "impl", status: "idle", generation: 2 } } },
  });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });

  const impl = result.results.find((r) => r.name === "impl");
  assert.equal(impl.status, "failed");
  assert.match(impl.reason, /回执异常/);
  assert.equal(result.ok, false);
});

test("release 代数没前进（同一代数覆盖）：判 failed", async () => {
  const { deps } = makeDeps({
    lifecycle: { impl: { name: "impl", status: "idle", generation: 7 } },
    releaseOutcome: { impl: { after: { name: "impl", status: "parked", generation: 7 } } },
  });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });

  const impl = result.results.find((r) => r.name === "impl");
  assert.equal(impl.status, "failed");
  assert.match(impl.reason, /代数未前进/);
});

test("已 parked / aborted 的成员计入 already-stopped，不重复 release", async () => {
  const { deps, calls } = makeDeps({
    lifecycle: {
      impl: { name: "impl", status: "parked", generation: 3 },
      qa: { name: "qa", status: "aborted", generation: 4 },
    },
  });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((r) => r.status), ["already-stopped", "already-stopped"]);
  assert.equal(calls.filter((call) => call.kind === "release").length, 0, "已停成员不再 release");
});

// ── reclaim ────────────────────────────────────────────────────────────────────

test("reclaim 全部成功：删目录，removed=true", async () => {
  const { deps, state } = makeDeps();
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });

  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(state.removed, true);
  assert.deepEqual(result.results.map((r) => r.status), ["stopped", "stopped"]);
});

test("reclaim 中途失败：绝不删目录，removed=false", async () => {
  const { deps, state, calls } = makeDeps({ releaseOutcome: { qa: { throws: "boom" } } });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });

  assert.equal(result.ok, false);
  assert.equal(result.removed, false);
  assert.equal(state.removed, false, "任一成员失败 → 目录必须保留");
  assert.deepEqual(result.results.map((r) => r.status), ["stopped", "failed"]);
  assert.equal(calls.filter((call) => call.kind === "release").length, 2, "失败后不再继续，也不再删目录");
});

test("reclaim 实例不存在：不删目录", async () => {
  const { deps, state } = makeDeps({ instanceExists: false });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });

  assert.equal(result.ok, false);
  assert.equal(result.removed, false);
  assert.equal(state.removed, false);
});

test("reclaim 停止成功但删目录失败：ok=false，但不谎报 removed", async () => {
  const { deps } = makeDeps({ removeFails: true });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });

  assert.equal(result.ok, false);
  assert.equal(result.removed, false);
  assert.match(result.error, /删除团队目录失败/);
  assert.deepEqual(result.results.map((r) => r.status), ["stopped", "stopped"], "成员停止结果如实保留");
});

test("stop 不会调用 removeTeamDir（即使全部成功）", async () => {
  const { deps, state } = makeDeps();
  await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });
  assert.equal(state.removed, false);
});

// ── idle 成员（核实 pi-team 源码后的正确期望）────────────────────────────────────
// 依据 teamLifecycle.js：`#apply` 对不在表里/未派发的成员照样建条目并 +1 generation；
// `release` 先写 parked 再 try{host.stop}catch{只记日志} —— host 的
// 「Subagent is not running」异常被吞，永不到达本模块。故 idle 成员应判 stopped，不是 failed。

test("idle 成员（在表里且 status=idle）正常落入 stopped，不误判 failed", async () => {
  const { deps } = makeDeps({
    lifecycle: { impl: { name: "impl", status: "idle", generation: 3 } },
  });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });
  const impl = result.results.find((r) => r.name === "impl");
  assert.equal(impl.status, "stopped", "release 吞掉 host.stop 异常 → idle 也能停成功");
  assert.equal(result.ok, true);
});

test("从未派发的成员（不在 lifecycle 表里）也能停成功", async () => {
  const { deps } = makeDeps({ lifecycle: {} });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });
  assert.deepEqual(result.results.map((r) => r.status), ["stopped", "stopped"]);
  assert.equal(result.ok, true);
});

// ── 运行态真验证（回执只证明已 parked，不证明已停）──────────────────────────────

test("reclaim：成员会话仍在运行 → failed、ok=false、不删目录（不留孤儿会话）", async () => {
  const { deps, calls, state } = makeDeps({
    lifecycle: { impl: { name: "impl", status: "idle", generation: 1, sessionId: "s-impl" } },
    running: ["s-impl"],
  });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });

  const impl = result.results.find((r) => r.name === "impl");
  assert.equal(impl.status, "failed");
  assert.match(impl.reason, /回执已置 parked，但会话仍在运行/);
  assert.equal(result.ok, false);
  assert.equal(result.removed, false);
  assert.equal(state.removed, false, "还在跑就绝不删目录");
  // 探测用的是 lifecycle 条目里的 sessionId（会话口径一致）。
  assert.deepEqual(
    calls.filter((c) => c.kind === "probeRunning").map((c) => c.sessionId),
    ["s-impl"],
    "只有带 sessionId 的成员被探测；无会话成员不探",
  );
});

test("stop：成员会话仍在运行同样记 failed（如实反映，不谎报已停）", async () => {
  const { deps } = makeDeps({
    lifecycle: { impl: { name: "impl", status: "idle", generation: 1, sessionId: "s-impl" } },
    running: ["s-impl"],
  });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });
  const impl = result.results.find((r) => r.name === "impl");
  assert.equal(impl.status, "failed");
  assert.equal(result.ok, false);
});

test("探测抛错 → failed 且写明「无法确认」，不当作已停", async () => {
  const { deps } = makeDeps({
    lifecycle: { impl: { name: "impl", status: "idle", generation: 1, sessionId: "s-impl" } },
    probeThrows: true,
  });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });

  const impl = result.results.find((r) => r.name === "impl");
  assert.equal(impl.status, "failed");
  assert.match(impl.reason, /无法确认会话是否已停/);
  assert.equal(result.ok, false);
  assert.equal(result.removed, false, "探不到就不许删目录");
});

test("会话不存在 / 从未派发（无 sessionId）→ 视为已停、stopped", async () => {
  // MEMBERS 默认无 sessionId；lifecycle 也没有 → 不探测，直接算停成功。
  const { deps, calls } = makeDeps();
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });
  assert.deepEqual(result.results.map((r) => r.status), ["stopped", "stopped"]);
  assert.equal(calls.filter((c) => c.kind === "probeRunning").length, 0, "无会话不发探测");
  assert.equal(result.removed, true);
});

test("会话口径：lifecycle 条目的 sessionId 优先于 config 名册", async () => {
  const members = [{ agentId: "m-impl", name: "impl", sessionId: "s-config" }];
  const { deps, calls } = makeDeps({
    members,
    lifecycle: { impl: { name: "impl", status: "idle", generation: 1, sessionId: "s-lifecycle" } },
    running: ["s-lifecycle"],
  });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });
  assert.equal(result.results[0].status, "failed", "探到 lifecycle 的会话仍在跑");
  assert.deepEqual(calls.filter((c) => c.kind === "probeRunning").map((c) => c.sessionId), ["s-lifecycle"]);
});

// ── 进程内残留实例清理 ──────────────────────────────────────────────────────────

test("reclaim 成功后按原始团队名清理进程内实例，并在响应里带出 cleanup", async () => {
  const { deps, calls, state } = makeDeps({ cleanup: { lifecycle: true, bus: true } });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "-----", action: "reclaim" });

  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.deepEqual(result.cleanup, { lifecycle: true, bus: true });
  const drops = calls.filter((call) => call.kind === "dropInstances");
  assert.equal(drops.length, 1, "只清一次");
  assert.equal(drops[0].rawTeamName, "前端重构队", "清理用的 key 是原始团队名，不是目录名");
  assert.deepEqual(state.cleaned, ["前端重构队"]);
});

test("stop 不清理进程内实例（团队还在，实例必须保留）", async () => {
  const { deps, calls } = makeDeps();
  await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "stop" });
  assert.equal(calls.filter((call) => call.kind === "dropInstances").length, 0);
});

test("reclaim 回执失败：不删目录、也不清理实例", async () => {
  const { deps, calls, state } = makeDeps({ releaseOutcome: { qa: { throws: "boom" } } });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });
  assert.equal(result.ok, false);
  assert.equal(state.removed, false);
  assert.equal(calls.filter((call) => call.kind === "dropInstances").length, 0, "目录没删就不该动实例");
});

test("清理抛错：removed 仍为 true、ok 不变，但 cleanup.error 如实带出", async () => {
  const { deps } = makeDeps({ cleanupThrows: true });
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });
  assert.equal(result.ok, true, "清理失败不影响团队停止结论");
  assert.equal(result.removed, true, "目录已删是既成事实，不受清理影响");
  assert.equal(result.cleanup?.error, "registry locked");
  assert.equal(result.cleanup?.lifecycle, false);
});

test("未注入 dropInstances：reclaim 照常成功，只是没有 cleanup 字段", async () => {
  const { deps } = makeDeps();
  delete deps.dropInstances;
  const result = await runTeamLifecycleAction(deps, { teamDirName: "demo", action: "reclaim" });
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(result.cleanup, undefined);
});

// ── 磁盘默认实现 ───────────────────────────────────────────────────────────────

test("磁盘实现：readTeamConfig 带出原始名与名册，readLifecycle 读成员表，removeTeamDirectory 删目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirFor = (name) => join(root, `dir-${name}`);
  const dir = dirFor("-----");
  await mkdir(join(dir, "inboxes"), { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({
    name: "前端重构队",
    members: [
      { agentId: "m-impl", name: "impl", sessionId: "s-impl" },
      { name: "no-id" },
    ],
  }));
  await writeFile(join(dir, "lifecycle.json"), JSON.stringify({
    version: 1,
    members: { impl: { name: "impl", status: "parked", generation: 2, sessionId: "s-impl" } },
  }));

  const config = await readTeamConfig("-----", dirFor);
  assert.equal(config.rawName, "前端重构队");
  assert.deepEqual(config.members, [{ agentId: "m-impl", name: "impl", sessionId: "s-impl" }], "缺 agentId 的条目被过滤");

  const lifecycle = await readLifecycleSnapshot("-----", dirFor);
  assert.equal(lifecycle.impl.status, "parked");

  assert.equal(await readTeamConfig("ghost", dirFor), null, "团队不存在返回 null");

  await removeTeamDirectory("-----", dirFor);
  assert.deepEqual(await readdir(root), [], "目录已删除");
});

test("磁盘实现：缺 lifecycle.json 时返回空表而不是抛错", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirFor = (name) => join(root, name);
  await mkdir(dirFor("demo"), { recursive: true });
  assert.deepEqual(await readLifecycleSnapshot("demo", dirFor), {});
});