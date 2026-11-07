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
} = {}) {
  const calls = [];
  const state = { removed: false, lifecycle: { ...lifecycle } };
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