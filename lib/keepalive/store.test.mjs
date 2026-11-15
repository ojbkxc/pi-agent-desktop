import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 挂机保活的落盘层：settings / state / stop marker / supervisor record。
 * 全部用临时目录隔离，断言读磁盘上的真文件（不靠返回值自证）。
 */

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./store.ts");

function dir(t, prefix = "pi-web-keepalive-") {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("settings：缺文件默认关闭；写入后读回；坏 JSON 回落默认", (t) => {
  const agentDir = dir(t);
  const initial = store.readKeepaliveSettings(agentDir);
  assert.equal(initial.enabled, false);
  assert.equal(initial.version, 1);

  const written = store.writeKeepaliveSettings({ enabled: true }, agentDir);
  assert.equal(written.enabled, true);
  const onDisk = JSON.parse(readFileSync(join(agentDir, "keepalive", "settings.json"), "utf8"));
  assert.equal(onDisk.enabled, true);
  assert.equal(store.readKeepaliveSettings(agentDir).enabled, true);

  writeFileSync(join(agentDir, "keepalive", "settings.json"), "{not json");
  assert.equal(store.readKeepaliveSettings(agentDir).enabled, false);
});

test("stop marker：先写标记再停服务的语义载体", (t) => {
  const agentDir = dir(t);
  assert.equal(store.isKeepaliveStopped(agentDir), false);
  store.writeKeepaliveStopMarker("stop", agentDir);
  assert.equal(store.isKeepaliveStopped(agentDir), true);
  const marker = store.readKeepaliveStopMarker(agentDir);
  assert.equal(marker.reason, "stop");
  assert.ok(marker.at);
  store.clearKeepaliveStopMarker(agentDir);
  assert.equal(store.isKeepaliveStopped(agentDir), false);
});

test("state：完整往返 + 损坏文件返回 null", (t) => {
  const agentDir = dir(t);
  assert.equal(store.readKeepaliveState(agentDir), null);

  const state = {
    version: 1,
    pid: 4242,
    startedAt: "2026-11-15T01:00:00.000Z",
    heartbeatAt: "2026-11-15T01:00:15.000Z",
    uptimeMs: 15_000,
    enabled: true,
    runningSessions: ["s-1"],
    interrupted: {
      at: "2026-11-15T01:00:00.000Z",
      sessionIds: ["s-0"],
      previousPid: 1111,
      previousHeartbeatAt: "2026-11-14T23:59:00.000Z",
    },
    resume: { lastAt: "2026-11-15T01:00:00.000Z", runs: 2, examined: 3, resumed: [], lastError: null },
    history: [{ at: "2026-11-15T01:00:00.000Z", kind: "start", detail: "ok" }],
  };
  store.writeKeepaliveState(state, agentDir);
  const read = store.readKeepaliveState(agentDir);
  assert.equal(read.pid, 4242);
  assert.equal(read.enabled, true);
  assert.deepEqual(read.runningSessions, ["s-1"]);
  assert.deepEqual(read.interrupted.sessionIds, ["s-0"]);
  assert.equal(read.resume.runs, 2);
  assert.equal(read.history.length, 1);

  writeFileSync(join(agentDir, "keepalive", "state.json"), JSON.stringify({ pid: "nope" }));
  assert.equal(store.readKeepaliveState(agentDir), null);
});

test("state 写入时历史封顶（超出上限截断到最新 N 条）", (t) => {
  const agentDir = dir(t);
  const history = Array.from({ length: 80 }, (_, index) => ({
    at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    kind: "resume",
    detail: `e${index}`,
  }));
  store.writeKeepaliveState({
    version: 1,
    pid: 1,
    startedAt: "2026-11-15T00:00:00.000Z",
    heartbeatAt: "2026-11-15T00:00:00.000Z",
    uptimeMs: 1,
    enabled: false,
    runningSessions: [],
    interrupted: null,
    resume: { lastAt: null, runs: 0, examined: 0, resumed: [], lastError: null },
    history,
  }, agentDir);
  const read = store.readKeepaliveState(agentDir);
  assert.equal(read.history.length, 50);
  assert.equal(read.history.at(-1).detail, "e79");
});

test("appendKeepaliveEvent：追加并保留最新 N 条", () => {
  let history = [];
  for (let index = 0; index < 5; index += 1) {
    history = store.appendKeepaliveEvent(
      history,
      { at: `t${index}`, kind: "resume", detail: "x" },
      3,
    );
  }
  assert.deepEqual(history.map((event) => event.at), ["t2", "t3", "t4"]);
});

test("supervisor record：缺文件 null；写后读回并纠正非法枚举", (t) => {
  const agentDir = dir(t);
  assert.equal(store.readSupervisorRecord(agentDir), null);

  const record = {
    version: 1,
    platform: "win32",
    installed: true,
    installTarget: "PiAgentKeepalive",
    lastCheckAt: "2026-11-15T02:00:00.000Z",
    lastAction: "spawned",
    lastError: null,
    restarts: 3,
    lastRestartAt: "2026-11-15T01:59:00.000Z",
    spawnedPid: 777,
    health: "healthy",
    logPath: "C:/logs/a.log",
  };
  store.writeSupervisorRecord(record, agentDir);
  const read = store.readSupervisorRecord(agentDir);
  assert.equal(read.installed, true);
  assert.equal(read.installTarget, "PiAgentKeepalive");
  assert.equal(read.restarts, 3);
  assert.equal(read.health, "healthy");

  writeFileSync(
    join(agentDir, "keepalive", "supervisor.json"),
    JSON.stringify({ lastAction: "explode", health: "banana", restarts: "many" }),
  );
  const sanitized = store.readSupervisorRecord(agentDir);
  assert.equal(sanitized.lastAction, "none");
  assert.equal(sanitized.health, null);
  assert.equal(sanitized.restarts, 0);
});

test("keepalivePaths：目录布局稳定", (t) => {
  const agentDir = dir(t);
  const paths = store.keepalivePaths(agentDir);
  assert.equal(paths.dir, join(agentDir, "keepalive"));
  assert.ok(paths.settings.endsWith("settings.json"));
  assert.ok(paths.stopMarker.endsWith("manually-stopped"));
  assert.equal(existsSync(paths.dir), false);
  store.writeKeepaliveSettings({ enabled: false }, agentDir);
  assert.equal(existsSync(paths.dir), true);
});
