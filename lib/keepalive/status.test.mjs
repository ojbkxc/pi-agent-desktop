import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/keepalive` 的状态装配：开关、心跳年龄、autofix 汇总、守护脚本记录、
 * 仓库内脚本路径探测（打包版没有 = null）。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { buildKeepaliveStatus, supervisorScriptPath } = await jiti.import("./status.ts");
const store = await jiti.import("./store.ts");

const T0 = new Date("2026-11-15T09:00:00.000Z");

function setup(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-keepalive-status-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return agentDir;
}

test("默认：关闭、无心跳、autofix 未启用、无守护记录", (t) => {
  const agentDir = setup(t);
  const status = buildKeepaliveStatus({ agentDir, now: () => T0, cwd: agentDir });
  assert.equal(status.version, 1);
  assert.equal(status.enabled, false);
  assert.equal(status.server.pid, process.pid);
  assert.equal(status.server.heartbeatAt, null);
  assert.equal(status.server.heartbeatAgeMs, null);
  assert.equal(status.server.heartbeatStale, false);
  assert.equal(status.autofix, null);
  assert.equal(status.supervisor.record, null);
  assert.equal(status.supervisor.stopped, false);
  assert.equal(status.supervisor.scriptPath, null, "临时 cwd 下找不到脚本");
  assert.equal(status.supervisor.installSupported, false);
  assert.deepEqual(status.history, []);
});

test("心跳年龄与陈旧判定：30s 内新鲜，超过 90s 判 stale", (t) => {
  const agentDir = setup(t);
  store.writeKeepaliveSettings({ enabled: true }, agentDir);
  const write = (heartbeatAt) => store.writeKeepaliveState({
    version: 1,
    pid: process.pid,
    startedAt: new Date(T0.getTime() - 120_000).toISOString(),
    heartbeatAt,
    uptimeMs: 120_000,
    enabled: true,
    runningSessions: ["s-9"],
    interrupted: null,
    resume: { lastAt: null, runs: 1, examined: 0, resumed: [], lastError: null },
    history: [{ at: heartbeatAt, kind: "start", detail: "x" }],
  }, agentDir);

  write(new Date(T0.getTime() - 30_000).toISOString());
  let status = buildKeepaliveStatus({ agentDir, now: () => T0, cwd: agentDir });
  assert.equal(status.server.heartbeatAgeMs, 30_000);
  assert.equal(status.server.heartbeatStale, false);
  assert.equal(status.server.startedAt, new Date(T0.getTime() - 120_000).toISOString());
  assert.deepEqual(status.runningSessionIds, ["s-9"]);

  write(new Date(T0.getTime() - 120_000).toISOString());
  status = buildKeepaliveStatus({ agentDir, now: () => T0, cwd: agentDir });
  assert.equal(status.server.heartbeatStale, true);
});

test("autofix 汇总来自只读扫描；有任务文件就不再是 null", (t) => {
  const agentDir = setup(t);
  const tasksDir = join(agentDir, "autofix", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "a.json"), JSON.stringify({
    status: "running",
    pid: 999_999,
    updatedAt: T0.getTime() - 30 * 60_000,
  }));
  const status = buildKeepaliveStatus({ agentDir, now: () => T0, cwd: agentDir });
  assert.deepEqual(status.autofix, { total: 1, active: 0, stuck: 1, succeeded: 0, failed: 0 });
});

test("守护记录与停止标记透出；repo cwd 能找到 scripts/pi-supervisor.mjs", (t) => {
  const agentDir = setup(t);
  store.writeSupervisorRecord({
    version: 1,
    platform: "win32",
    installed: true,
    installTarget: "PiAgentKeepalive",
    lastCheckAt: T0.toISOString(),
    lastAction: "spawned",
    lastError: null,
    restarts: 2,
    lastRestartAt: T0.toISOString(),
    spawnedPid: 4242,
    health: "healthy",
    logPath: null,
  }, agentDir);
  store.writeKeepaliveStopMarker("stop", agentDir);

  const status = buildKeepaliveStatus({ agentDir, now: () => T0 });
  assert.equal(status.supervisor.record.installed, true);
  assert.equal(status.supervisor.record.restarts, 2);
  assert.equal(status.supervisor.stopped, true);
  assert.ok(status.supervisor.scriptPath?.endsWith("pi-supervisor.mjs"));
  assert.equal(status.supervisor.installSupported, true);
});

test("supervisorScriptPath：仓库根有脚本，空目录没有", (t) => {
  assert.ok(supervisorScriptPath().endsWith("scripts/pi-supervisor.mjs".replace("/", process.platform === "win32" ? "\\" : "/")));
  const empty = setup(t);
  assert.equal(supervisorScriptPath(empty), null);
});
