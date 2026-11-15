import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./pi-supervisor.mjs", import.meta.url));
const supervisor = await import("./pi-supervisor.mjs");

// ───────────────────────────── 纯函数 ─────────────────────────────

test("parseCommand：引号与空格不经过 shell", () => {
  assert.deepEqual(supervisor.parseCommand('node "C:/a b/pi-web.js" --no-open'), [
    "node",
    "C:/a b/pi-web.js",
    "--no-open",
  ]);
  assert.deepEqual(supervisor.parseCommand("'a b' c"), ["a b", "c"]);
  assert.deepEqual(supervisor.parseCommand('x "say \\"hi\\""'), ["x", 'say "hi"']);
  assert.throws(() => supervisor.parseCommand('"unterminated'), /Unterminated/);
  assert.throws(() => supervisor.parseCommand("   "), /Empty command/);
});

test("classifyStatus：五态与退出码", () => {
  const base = { heartbeatAgeMs: 1000, staleMs: 90_000, pidAlive: true };
  assert.deepEqual(supervisor.classifyStatus({ ...base, healthOk: true }), { verdict: "healthy", exitCode: 0 });
  assert.deepEqual(supervisor.classifyStatus({ ...base, healthOk: true, stopped: true }), { verdict: "stopped", exitCode: 3 });
  assert.deepEqual(supervisor.classifyStatus({ ...base, healthOk: true, enabled: false }), { verdict: "disabled", exitCode: 0 });
  assert.deepEqual(supervisor.classifyStatus({ ...base, healthOk: true, heartbeatAgeMs: 120_000 }), { verdict: "stale", exitCode: 1 });
  assert.deepEqual(supervisor.classifyStatus({ ...base, healthOk: false }), { verdict: "unreachable", exitCode: 1 });
  assert.deepEqual(supervisor.classifyStatus({ ...base, healthOk: false, pidAlive: false }), { verdict: "unreachable", exitCode: 1 });
  assert.deepEqual(
    supervisor.classifyStatus({ ...base, healthOk: false, offline: true, offlineIsRemote: true }),
    { verdict: "offline", exitCode: 1 },
  );
  // 本机 loopback 不受断网影响：offline 标记不该掩盖本机服务故障。
  assert.equal(
    supervisor.classifyStatus({ ...base, healthOk: false, offline: true, offlineIsRemote: false }).verdict,
    "unreachable",
  );
  // 允许心跳文件缺失（旧版本/keeper 未启动）：只要 /health 通就算健康。
  assert.deepEqual(
    supervisor.classifyStatus({ ...base, healthOk: true, heartbeatAgeMs: null }),
    { verdict: "healthy", exitCode: 0 },
  );
});

test("restartBudget：只数最近一小时，达到上限即耗尽", () => {
  const now = 1_800_000_000_000;
  const recent = [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000];
  assert.equal(supervisor.restartBudget({ restartTimes: recent, now, maxRestarts: 5 }).exhausted, true);
  const mixed = [...recent, now - 2 * 3_600_000];
  const budget = supervisor.restartBudget({ restartTimes: mixed, now, maxRestarts: 5 });
  assert.equal(budget.recent.length, 5);
  assert.equal(budget.exhausted, true);
  assert.equal(supervisor.restartBudget({ restartTimes: [now - 2 * 3_600_000], now, maxRestarts: 5 }).exhausted, false);
});

test("计划任务/launchd/systemd 的生成模板包含关键判据", () => {
  const wrapper = supervisor.buildWindowsWrapper({
    nodePath: "C:/Program Files/nodejs/node.exe",
    scriptPath: "C:/repo/scripts/pi-supervisor.mjs",
    port: 30141,
  });
  assert.match(wrapper, /check --respect-stop --port 30141/);
  assert.match(wrapper, /"C:\/Program Files\/nodejs\/node\.exe"/);

  const args = supervisor.buildWindowsSchtasksArgs({ wrapperPath: "C:/state/pi-supervisor-task.cmd", minutes: 5 });
  assert.ok(args.includes("/SC") && args.includes("MINUTE"));
  assert.equal(args[args.indexOf("/MO") + 1], "5");
  assert.equal(args[args.indexOf("/TN") + 1], supervisor.TASK_NAME_WINDOWS);
  assert.match(args[args.indexOf("/TR") + 1], /pi-supervisor-task\.cmd/);

  const plist = supervisor.buildLaunchdPlist({
    nodePath: "/usr/bin/node",
    scriptPath: "/repo/scripts/pi-supervisor.mjs",
    port: 30141,
    intervalSeconds: 300,
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log",
  });
  assert.match(plist, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(plist, /--respect-stop/);

  const units = supervisor.buildSystemdUnits({
    nodePath: "/usr/bin/node",
    scriptPath: "/repo/scripts/pi-supervisor.mjs",
    port: 30141,
    intervalSeconds: 300,
  });
  assert.match(units.service, /Type=oneshot/);
  assert.match(units.service, /check --respect-stop --port 30141/);
  assert.match(units.timer, /OnUnitActiveSec=300/);
});

test("resolvePort：env PORT → 设置文件 serverPort → 30141", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-supervisor-port-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settingsPath = join(dir, "settings.json");

  assert.equal(supervisor.resolvePort({ env: {}, settingsPath: join(dir, "none.json") }), supervisor.DEFAULT_PORT);
  writeFileSync(settingsPath, JSON.stringify({ serverPort: 40141 }));
  assert.equal(supervisor.resolvePort({ env: {}, settingsPath }), 40141);
  assert.equal(supervisor.resolvePort({ env: { PORT: "50141" }, settingsPath }), 50141);
  writeFileSync(settingsPath, JSON.stringify({ serverPort: "nope" }));
  assert.equal(supervisor.resolvePort({ env: {}, settingsPath }), supervisor.DEFAULT_PORT);
});

// ───────────────────────────── CLI（status/check/stop） ─────────────────────────────

function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-supervisor-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSettings(dir, enabled) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, enabled, updatedAt: new Date().toISOString() }));
}

function writeHeartbeat(dir, { pid = process.pid, ageMs = 0 } = {}) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    version: 1,
    pid,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - ageMs).toISOString(),
    uptimeMs: 60_000,
    enabled: true,
    runningSessions: [],
  }));
}

function runCli(args) {
  // 异步 spawn：健康检查服务器跑在本进程里，spawnSync 会阻塞父进程事件循环，
  // 服务端永远答不上来，探测就只剩 timeout（会造出「探活坏了」的假红）。
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, PI_AGENT_HOME: tmpdir() },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

async function healthServer(t, body = { status: "ok", gatewayId: "test-gateway" }) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${server.address().port}/health`;
}

async function deadHealthUrl() {
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${port}/health`;
}

test("CLI status：未启用 = 0/disabled", async (t) => {
  const dir = makeDir(t);
  writeSettings(dir, false);
  const result = await runCli(["status", "--dir", dir, "--url", "http://127.0.0.1:9/health", "--timeout", "500"]);
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.verdict, "disabled");
  assert.equal(body.enabled, false);
});

test("CLI status：启用但服务不可达 = 1/unreachable", async (t) => {
  const dir = makeDir(t);
  writeSettings(dir, true);
  const url = await deadHealthUrl();
  const result = await runCli(["status", "--dir", dir, "--url", url, "--timeout", "500"]);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).verdict, "unreachable");
});

test("CLI status：/health 通 + 心跳新鲜 = 0/healthy；心跳陈旧 = 1/stale", async (t) => {
  const dir = makeDir(t);
  writeSettings(dir, true);
  writeHeartbeat(dir);
  const url = await healthServer(t);

  const healthy = await runCli(["status", "--dir", dir, "--url", url, "--timeout", "2000"]);
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).verdict, "healthy");

  writeHeartbeat(dir, { ageMs: 120_000 });
  const stale = await runCli(["status", "--dir", dir, "--url", url, "--timeout", "2000"]);
  assert.equal(stale.code, 1, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).verdict, "stale");
});

test("CLI status/check：停止标记 = 3/stopped，check 不拉起", async (t) => {
  const dir = makeDir(t);
  writeSettings(dir, true);
  writeFileSync(join(dir, "manually-stopped"), JSON.stringify({ at: new Date().toISOString(), reason: "stop" }));
  const url = await deadHealthUrl();

  const status = await runCli(["status", "--dir", dir, "--url", url, "--timeout", "500"]);
  assert.equal(status.code, 3, status.stderr);
  assert.equal(JSON.parse(status.stdout).verdict, "stopped");

  const check = await runCli(["check", "--respect-stop", "--dir", dir, "--url", url, "--timeout", "500", "--start-timeout", "1000"]);
  assert.equal(check.code, 3, check.stderr);
  assert.equal(JSON.parse(check.stdout).verdict, "stopped");
  assert.equal(existsSync(join(dir, "service.json")), false, "尊重停止标记：不得拉起服务");
});

test("CLI check：重启预算耗尽 = 2/degraded 且不动手", async (t) => {
  const dir = makeDir(t);
  writeSettings(dir, true);
  const now = Date.now();
  writeFileSync(join(dir, "supervisor.json"), JSON.stringify({
    version: 1,
    lastAction: "none",
    restartTimes: [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000],
  }));
  const url = await deadHealthUrl();
  const result = await runCli([
    "check", "--dir", dir, "--url", url, "--max-restarts", "5", "--timeout", "500", "--start-timeout", "1000",
  ]);
  assert.equal(result.code, 2, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.verdict, "degraded");
  assert.match(body.error, /Restart budget exhausted/);
  assert.equal(existsSync(join(dir, "service.json")), false);
  const record = JSON.parse(readFileSync(join(dir, "supervisor.json"), "utf8"));
  assert.equal(record.health, "degraded");
  assert.match(record.lastError, /Restart budget/);
});

test("CLI check：未启用开关 = 0/disabled，不探测不拉起", async (t) => {
  const dir = makeDir(t);
  writeSettings(dir, false);
  const result = await runCli(["check", "--dir", dir, "--url", "http://127.0.0.1:9/health", "--timeout", "500"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verdict, "disabled");
});

test("CLI stop：先写标记再清理死进程记录，不强杀", async (t) => {
  const dir = makeDir(t);
  writeFileSync(join(dir, "service.json"), JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
  const result = await runCli(["stop", "--dir", dir, "--stop-timeout", "1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(dir, "manually-stopped")), true);
  assert.equal(existsSync(join(dir, "service.json")), false);
  const output = JSON.parse(result.stdout);
  assert.equal(output.stopped, true);
});

test("CLI install --dry-run：返回将执行的命令，不改标记为已安装", async (t) => {
  const dir = makeDir(t);
  const result = await runCli(["install", "--dir", dir, "--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.dryRun, true);
  assert.equal(typeof body.platform, "string");
  const record = JSON.parse(readFileSync(join(dir, "supervisor.json"), "utf8"));
  assert.equal(record.installed, false);
});

test("CLI 无动作/未知动作：返回 2 并打印用法", async () => {
  const none = await runCli([]);
  assert.equal(none.code, 2);
  assert.match(none.stdout, /pi-agent-desktop/);
  const unknown = await runCli(["nonsense"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown action/);
});
