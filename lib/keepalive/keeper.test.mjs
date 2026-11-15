import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 进程内保活循环：心跳落盘、重启中断快照、接续扫描节流、休眠恢复重扫、
 * 停止标记触发优雅退出。全部用临时 agentDir + 注入时钟/扫描函数，不碰真实 home。
 */

const jiti = createJiti(import.meta.url);
const { KeepaliveKeeper } = await jiti.import("./keeper.ts");
const store = await jiti.import("./store.ts");

const T0 = new Date("2026-11-15T08:00:00.000Z").getTime();

function setup(t, options = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-keepalive-keeper-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const clock = { now: T0 };
  const scans = { count: 0, summary: { total: 0, active: 0, stuck: 0, succeeded: 0, failed: 0 } };
  const exits = [];
  const keeper = new KeepaliveKeeper({
    agentDir,
    acquireOwnership: false,
    now: () => new Date(clock.now),
    runningSessions: async () => options.running ?? [],
    scanTasks: () => {
      scans.count += 1;
      return {
        tasks: [],
        summary: { ...scans.summary },
        resumableIds: [],
        unavailable: false,
      };
    },
    exit: (signal) => exits.push(signal),
    tickMs: 15_000,
    resumeIntervalMs: 5 * 60_000,
    ...options.keeper,
  });
  return { agentDir, clock, scans, exits, keeper };
}

test("tick 写心跳：pid 是本进程、heartbeatAt 跟时钟、enabled 反映开关", async (t) => {
  const { agentDir, keeper, clock } = setup(t);
  store.writeKeepaliveSettings({ enabled: true }, agentDir);
  await keeper.tick();

  const state = store.readKeepaliveState(agentDir);
  assert.equal(state.pid, process.pid);
  assert.equal(state.heartbeatAt, new Date(clock.now).toISOString());
  assert.equal(state.enabled, true);
  assert.equal(state.history[0].kind, "start");

  clock.now += 15_000;
  await keeper.tick();
  assert.equal(store.readKeepaliveState(agentDir).heartbeatAt, new Date(clock.now).toISOString());
});

test("重启中断快照：上一进程 runningSessions 非空时记 interrupted 并写事件", async (t) => {
  const { agentDir, keeper } = setup(t);
  store.writeKeepaliveSettings({ enabled: true }, agentDir);
  store.writeKeepaliveState({
    version: 1,
    pid: 777,
    startedAt: "2026-11-15T07:00:00.000Z",
    heartbeatAt: "2026-11-15T07:59:00.000Z",
    uptimeMs: 3_540_000,
    enabled: true,
    runningSessions: ["s-1", "s-2"],
    interrupted: null,
    resume: { lastAt: null, runs: 0, examined: 0, resumed: [], lastError: null },
    history: [],
  }, agentDir);

  await keeper.tick();
  const state = store.readKeepaliveState(agentDir);
  assert.deepEqual(state.interrupted.sessionIds, ["s-1", "s-2"]);
  assert.equal(state.interrupted.previousPid, 777);
  assert.equal(state.interrupted.previousHeartbeatAt, "2026-11-15T07:59:00.000Z");
  assert.ok(state.history.some((event) => event.kind === "interrupted" && event.count === 2));
});

test("接续扫描：enabled 时首 tick 立即跑，随后按 5 分钟节流", async (t) => {
  const { agentDir, keeper, scans, clock } = setup(t);
  store.writeKeepaliveSettings({ enabled: true }, agentDir);
  scans.summary = { total: 3, active: 1, stuck: 2, succeeded: 0, failed: 0 };

  await keeper.tick();
  assert.equal(scans.count, 1);
  let state = store.readKeepaliveState(agentDir);
  assert.equal(state.resume.runs, 1);
  assert.equal(state.resume.examined, 3);
  assert.equal(state.resume.lastAt, new Date(T0).toISOString());
  assert.ok(state.history.some((event) => event.kind === "resume" && event.count === 2));

  clock.now += 60_000;
  await keeper.tick();
  assert.equal(scans.count, 1, "5 分钟内不重复扫描");

  clock.now += 5 * 60_000;
  await keeper.tick();
  assert.equal(scans.count, 2);
  state = store.readKeepaliveState(agentDir);
  assert.equal(state.resume.runs, 2);
});

test("关闭开关：不扫描，resume 保持初始值", async (t) => {
  const { agentDir, keeper, scans } = setup(t);
  store.writeKeepaliveSettings({ enabled: false }, agentDir);
  await keeper.tick();
  assert.equal(scans.count, 0);
  const state = store.readKeepaliveState(agentDir);
  assert.equal(state.enabled, false);
  assert.equal(state.resume.runs, 0);
  assert.equal(state.resume.lastAt, null);
});

test("休眠恢复：tick 间隔异常放大时记 wake 事件并强制重扫", async (t) => {
  const { agentDir, keeper, scans, clock } = setup(t);
  store.writeKeepaliveSettings({ enabled: true }, agentDir);
  await keeper.tick();
  assert.equal(scans.count, 1);

  // 机器睡了 10 分钟：间隔 > max(4×tick, 心跳陈旧阈值)。
  clock.now += 10 * 60_000;
  await keeper.tick();
  const state = store.readKeepaliveState(agentDir);
  assert.ok(state.history.some((event) => event.kind === "wake"));
  assert.equal(scans.count, 2);
});

test("停止标记（reason=stop）：写 stop 事件后调 exit('SIGTERM')，并停止后续 tick", async (t) => {
  const { agentDir, keeper, exits } = setup(t);
  store.writeKeepaliveSettings({ enabled: true }, agentDir);
  store.writeKeepaliveStopMarker("stop", agentDir);

  await keeper.tick();
  assert.deepEqual(exits, ["SIGTERM"]);
  const state = store.readKeepaliveState(agentDir);
  assert.ok(state.history.some((event) => event.kind === "stop"));

  exits.length = 0;
  await keeper.tick();
  assert.deepEqual(exits, [], "停止后不再重复退出");
});

test("停止标记但 reason 不是 stop：不退出（UI 开关关闭不杀服务）", async (t) => {
  const { agentDir, keeper, exits } = setup(t);
  store.writeKeepaliveSettings({ enabled: false }, agentDir);
  store.writeKeepaliveStopMarker("paused", agentDir);

  await keeper.tick();
  assert.deepEqual(exits, []);
  assert.ok(store.readKeepaliveState(agentDir));
});

test("开关切换会记 enabled/disabled 事件", async (t) => {
  const { agentDir, keeper } = setup(t);
  store.writeKeepaliveSettings({ enabled: false }, agentDir);
  await keeper.tick();
  store.writeKeepaliveSettings({ enabled: true }, agentDir);
  await keeper.tick();
  store.writeKeepaliveSettings({ enabled: false }, agentDir);
  await keeper.tick();

  const kinds = store.readKeepaliveState(agentDir).history.map((event) => event.kind);
  assert.ok(kinds.includes("enabled"));
  assert.ok(kinds.includes("disabled"));
});
