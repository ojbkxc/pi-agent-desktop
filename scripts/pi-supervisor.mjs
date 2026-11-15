#!/usr/bin/env node
/**
 * pi-agent-desktop 的跨平台守护脚本（挂机保活的进程级半边）。
 *
 * 进程内那半边（lib/keepalive/keeper.ts）只能写心跳、接续任务、报状态 —— 它自己
 * 死了就什么也做不了。本脚本由 OS 的调度器反复执行（Windows 计划任务 / launchd /
 * systemd user timer），负责「服务死了/假死 → 拉起」以及 start/stop/install。
 *
 * 语义照 dsh-superagent 的 scripts/dsh-superagent（tmux 守护）：
 * - 退出码 0 正常；1 可重启修复（未运行/失联/心跳陈旧）；2 需人工（重启修不好，
 *   例如重启预算耗尽/进程拉不起来）；3 已按用户意图停止（manually-stopped 标记）。
 * - stop 先写 `manually-stopped` 标记再优雅停机，**从不强杀**（--force 才强杀）。
 * - 标记存在时监控不自动复活；start 会清标记。
 * - 起服务前独占 `operation.lock`，并发巡检只让一个动手。
 *
 * 心跳判据：server 的 keeper 每 15s 写 `~/.pi/agent/keepalive/state.json`；`/health`
 * 可达但心跳超过 `--stale`（默认 90s）没更新 ⇒ 假死（事件循环被卡住），重启可修。
 *
 * 用法：
 *   node scripts/pi-supervisor.mjs status
 *   node scripts/pi-supervisor.mjs check [--respect-stop]
 *   node scripts/pi-supervisor.mjs start | stop [--force] | restart
 *   node scripts/pi-supervisor.mjs install | uninstall [--dry-run]
 *   node scripts/pi-supervisor.mjs run [--interval 60]
 *
 * 计划任务（每 5 分钟巡检一次）：
 *   node scripts/pi-supervisor.mjs install
 *   手工登记（等价）：schtasks /Create /SC MINUTE /MO 5 /TN PiAgentKeepalive
 *     /TR "\"C:\Program Files\nodejs\node.exe\" \"<repo>\scripts\pi-supervisor.mjs\" check --respect-stop" /F
 *
 * 选项：
 *   --url <url>        健康检查地址（默认 http://127.0.0.1:<port>/health）
 *   --port <n>         服务端口（默认 env PORT → 设置文件 serverPort → 30141）
 *   --dir <path>       保活状态目录（默认 ~/.pi/agent/keepalive）
 *   --command <cmd>    拉起服务的命令（默认 "<node> <repo>/bin/pi-web.js --no-open"）
 *   --cwd <path>       服务工作目录（默认脚本所在仓库根）
 *   --interval <sec>   run 的巡检间隔 / install 的计划周期（默认 300s）
 *   --timeout <ms>     健康探测超时（默认 3000）
 *   --start-timeout <ms> 拉起后等待健康的时限（默认 60000）
 *   --stop-timeout <sec> 优雅停机等待（默认 30）
 *   --stale <ms>       心跳陈旧阈值（默认 90000）
 *   --max-restarts <n> 一小时内重启上限（默认 5）
 *   --net-probe        远端 URL 探测失败时，再探一次外网以区分「断网」和「服务挂」
 *   --force            stop 时在优雅等待超时后强杀（默认不强杀，报错让人处理）
 *   --dry-run          install/uninstall 只打印将执行的命令
 *   --json             status 的机器可读输出（默认就是 JSON）
 */

import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXIT_OK = 0;
export const EXIT_RESTARTABLE = 1;
export const EXIT_ATTENTION = 2;
export const EXIT_STOPPED = 3;

export const DEFAULT_PORT = 30141;
export const DEFAULT_INTERVAL_SECONDS = 300;
export const TASK_NAME_WINDOWS = "PiAgentKeepalive";
export const LAUNCHD_LABEL = "dev.pi-agent.keepalive";
const LOCK_STALE_MS = 5 * 60_000;
const KEEP_LOGS = 20;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = dirname(dirname(SCRIPT_PATH));

// ───────────────────────────── 纯函数（可单测） ─────────────────────────────

/** 拆命令行为 argv：支持单/双引号与反斜杠转义，不做 shell 展开。 */
export function parseCommand(command) {
  const argv = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) throw new Error(`Unterminated quote in command: ${command}`);
  if (started) argv.push(current);
  if (argv.length === 0) throw new Error("Empty command");
  return argv;
}

export function userHome(env = process.env) {
  return env.PI_AGENT_HOME || homedir();
}

export function agentDir(env = process.env) {
  const configured = typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR.trim() : "";
  if (!configured) return join(userHome(env), ".pi", "agent");
  if (configured === "~") return userHome(env);
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return join(userHome(env), configured.slice(2));
  }
  return configured;
}

export function keepaliveDir(env = process.env) {
  return join(agentDir(env), "keepalive");
}

function piWebSettingsPath(env = process.env) {
  return join(agentDir(env), "pi-web", "settings.json");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 端口解析：env PORT → 设置文件 serverPort → 30141（与 bin/pi-web-settings.js 同口径）。 */
export function resolvePort({ env = process.env, settingsPath = piWebSettingsPath(env) } = {}) {
  const envPort = Number(env.PORT);
  if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) return envPort;
  const stored = readJson(settingsPath);
  const saved = stored && typeof stored === "object" ? stored.serverPort : null;
  if (Number.isInteger(saved) && saved >= 1024 && saved <= 65535) return saved;
  return DEFAULT_PORT;
}

/**
 * 状态判定（纯函数）：给定「/health 是否可达 + 心跳年龄 + pid 是否活着 + 标记/开关」，
 * 给出 verdict 与退出码。offline 只用于远端 URL（本机 loopback 不受断网影响）。
 */
export function classifyStatus({
  healthOk,
  heartbeatAgeMs,
  staleMs,
  pidAlive,
  stopped = false,
  enabled = true,
  offline = false,
  offlineIsRemote = false,
}) {
  if (stopped) return { verdict: "stopped", exitCode: EXIT_STOPPED };
  if (!enabled) return { verdict: "disabled", exitCode: EXIT_OK };
  if (healthOk && (heartbeatAgeMs === null || heartbeatAgeMs <= staleMs)) {
    return { verdict: "healthy", exitCode: EXIT_OK };
  }
  if (healthOk) return { verdict: "stale", exitCode: EXIT_RESTARTABLE };
  if (offline && offlineIsRemote) return { verdict: "offline", exitCode: EXIT_RESTARTABLE };
  if (!pidAlive) return { verdict: "unreachable", exitCode: EXIT_RESTARTABLE };
  return { verdict: "unreachable", exitCode: EXIT_RESTARTABLE };
}

/** 重启预算：一小时内重启次数已达上限 ⇒ 不再动手，报需人工（2）。 */
export function restartBudget({ restartTimes = [], now = Date.now(), maxRestarts = 5 }) {
  const recent = restartTimes.filter((time) => Number.isFinite(time) && now - time < 3_600_000);
  return { recent, exhausted: recent.length >= maxRestarts };
}

export function buildWindowsWrapper({ nodePath, scriptPath, port, env = {} }) {
  const envLines = Object.entries(env)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `set "${key}=${value}"`);
  return [
    "@echo off",
    "rem Generated by scripts/pi-supervisor.mjs install",
    ...envLines,
    `"${nodePath}" "${scriptPath}" check --respect-stop --port ${port}`,
    "",
  ].join("\r\n");
}

export function buildWindowsSchtasksArgs({ taskName = TASK_NAME_WINDOWS, wrapperPath, minutes = 5 }) {
  return [
    "/Create",
    "/F",
    "/SC",
    "MINUTE",
    "/MO",
    String(Math.max(1, Math.round(minutes))),
    "/TN",
    taskName,
    "/TR",
    `"${wrapperPath}"`,
  ];
}

export function buildLaunchdPlist({
  label = LAUNCHD_LABEL,
  nodePath,
  scriptPath,
  port,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  stdoutPath,
  stderrPath,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>check</string>
    <string>--respect-stop</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${stdoutPath}</string>
  <key>StandardErrorPath</key><string>${stderrPath}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnits({
  nodePath,
  scriptPath,
  port,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
}) {
  const service = `[Unit]
Description=Pi Agent keepalive supervisor (one check)

[Service]
Type=oneshot
ExecStart="${nodePath}" "${scriptPath}" check --respect-stop --port ${port}
`;
  const timer = `[Unit]
Description=Run the Pi Agent keepalive check every ${intervalSeconds}s

[Timer]
OnBootSec=60
OnUnitActiveSec=${intervalSeconds}
AccuracySec=10s
Unit=pi-agent-keepalive.service

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.");
  } catch {
    return true;
  }
}

// ───────────────────────────── IO 辅助 ─────────────────────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function probeHealth(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok && body?.status === "ok",
      status: response.status,
      gatewayId: body?.gatewayId ?? null,
      error: null,
    };
  } catch (error) {
    return { ok: false, status: null, gatewayId: null, error: error?.name === "AbortError" ? "timeout" : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeNetwork(timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    // 只发一个 HEAD 到公共 DNS 的 https 端口；失败就当断网（不重启、继续等）。
    const response = await fetch("https://1.1.1.1/", {
      method: "HEAD",
      signal: controller.signal,
      cache: "no-store",
    });
    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function readHeartbeat(paths) {
  const state = readJson(paths.state);
  if (!state || typeof state !== "object") return { pid: null, heartbeatAt: null, ageMs: null };
  const heartbeatAt = typeof state.heartbeatAt === "string" ? state.heartbeatAt : null;
  const time = heartbeatAt ? new Date(heartbeatAt).getTime() : Number.NaN;
  return {
    pid: typeof state.pid === "number" ? state.pid : null,
    heartbeatAt,
    ageMs: Number.isFinite(time) ? Math.max(0, Date.now() - time) : null,
  };
}

function readSettings(paths) {
  const settings = readJson(paths.settings);
  return { enabled: settings?.enabled === true };
}

function readService(paths) {
  const raw = readJson(paths.service);
  if (!raw || typeof raw !== "object" || typeof raw.pid !== "number") return null;
  return {
    pid: raw.pid,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    command: typeof raw.command === "string" ? raw.command : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    logPath: typeof raw.logPath === "string" ? raw.logPath : null,
  };
}

function writeService(paths, value) {
  writeFileSync(paths.service, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readSupervisor(paths) {
  const raw = readJson(paths.supervisor);
  const record = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    platform: process.platform,
    installed: record.installed === true,
    installTarget: typeof record.installTarget === "string" ? record.installTarget : null,
    lastCheckAt: typeof record.lastCheckAt === "string" ? record.lastCheckAt : null,
    lastAction: typeof record.lastAction === "string" ? record.lastAction : "none",
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    restarts: typeof record.restarts === "number" ? record.restarts : 0,
    lastRestartAt: typeof record.lastRestartAt === "string" ? record.lastRestartAt : null,
    spawnedPid: typeof record.spawnedPid === "number" ? record.spawnedPid : null,
    health: typeof record.health === "string" ? record.health : null,
    logPath: typeof record.logPath === "string" ? record.logPath : null,
    restartTimes: Array.isArray(record.restartTimes)
      ? record.restartTimes.filter((time) => typeof time === "number")
      : [],
  };
}

function writeSupervisor(paths, record) {
  writeFileSync(paths.supervisor, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * 独占一次操作（file lock）。并发巡检只让一个动手；锁主进程已死或锁超过 5 分钟
 * 视为残留，清掉重试一次。返回 null 表示「另一轮正在跑，本次跳过」。
 */
async function withLock(paths, run) {
  const lockPath = paths.lock;
  const acquire = () => {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!acquire()) {
    const raw = readJson(lockPath);
    let stale = true;
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
        || !pidAlive(raw?.pid);
    } catch {
      stale = true;
    }
    if (!stale) return null;
    rmSync(lockPath, { force: true });
    if (!acquire()) return null;
  }
  try {
    return await run();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

function pruneLogs(logsDir) {
  try {
    const logs = readdirSync(logsDir)
      .filter((name) => /^pi-web-.*\.log$/.test(name))
      .map((name) => join(logsDir, name))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    for (const path of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) {
      rmSync(path, { force: true });
    }
  } catch {
    // Logs dir missing: nothing to prune.
  }
}

// ───────────────────────────── 命令行/配置 ─────────────────────────────

export function parseArgs(argv) {
  const options = {
    action: null,
    url: null,
    port: null,
    dir: null,
    command: null,
    cwd: null,
    interval: DEFAULT_INTERVAL_SECONDS,
    timeout: 3000,
    startTimeout: 60_000,
    stopTimeout: 30,
    stale: 90_000,
    maxRestarts: 5,
    respectStop: false,
    netProbe: false,
    force: false,
    dryRun: false,
  };
  const actions = new Set(["status", "check", "start", "stop", "restart", "install", "uninstall", "run"]);
  const valueOptions = {
    "--url": "url",
    "--port": "port",
    "--dir": "dir",
    "--command": "command",
    "--cwd": "cwd",
    "--interval": "interval",
    "--timeout": "timeout",
    "--start-timeout": "startTimeout",
    "--stop-timeout": "stopTimeout",
    "--stale": "stale",
    "--max-restarts": "maxRestarts",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--respect-stop") options.respectStop = true;
    else if (arg === "--net-probe") options.netProbe = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (valueOptions[arg]) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[valueOptions[arg]] = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.action) {
      if (!actions.has(arg)) throw new Error(`Unknown action: ${arg}`);
      options.action = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  for (const key of ["port", "interval", "timeout", "startTimeout", "stopTimeout", "stale", "maxRestarts"]) {
    if (options[key] !== null && typeof options[key] === "string") {
      const parsed = Number(options[key]);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive number`);
      options[key] = parsed;
    }
  }
  return options;
}

function resolvePaths(options) {
  const dir = options.dir ? resolve(options.dir) : keepaliveDir();
  return {
    dir,
    settings: join(dir, "settings.json"),
    state: join(dir, "state.json"),
    supervisor: join(dir, "supervisor.json"),
    service: join(dir, "service.json"),
    stopMarker: join(dir, "manually-stopped"),
    logsDir: join(dir, "logs"),
    lock: join(dir, "operation.lock"),
  };
}

function resolveServer(options) {
  const cwd = options.cwd ? resolve(options.cwd) : ROOT_DIR;
  if (options.command) return { cwd, argv: parseCommand(options.command), command: options.command };
  const entry = join(cwd, "bin", "pi-web.js");
  if (!existsSync(entry)) {
    throw Object.assign(
      new Error(
        `No server entry at ${entry}. Pass --command "<cmd>" (the packaged desktop app should point at its own executable).`,
      ),
      { exitCode: EXIT_STOPPED },
    );
  }
  const argv = [process.execPath, entry, "--no-open"];
  return { cwd, argv, command: argv.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ") };
}

function healthUrl(options) {
  if (options.url) return options.url;
  const port = options.port ?? resolvePort();
  return `http://127.0.0.1:${port}/health`;
}

// ───────────────────────────── 动作 ─────────────────────────────

async function probeAll(options, paths) {
  const url = healthUrl(options);
  const [health, heartbeat, settings, service, stopped] = [
    await probeHealth(url, options.timeout),
    readHeartbeat(paths),
    readSettings(paths),
    readService(paths),
    existsSync(paths.stopMarker),
  ];
  const alive = pidAlive(service?.pid) || pidAlive(heartbeat.pid);
  let offline = false;
  if (!health.ok && options.netProbe && !isLoopbackUrl(url)) {
    offline = !(await probeNetwork(options.timeout));
  }
  const classification = classifyStatus({
    healthOk: health.ok,
    heartbeatAgeMs: heartbeat.ageMs,
    staleMs: options.stale,
    pidAlive: alive,
    stopped,
    enabled: settings.enabled,
    offline,
    offlineIsRemote: !isLoopbackUrl(url),
  });
  return { url, health, heartbeat, settings, service, alive, stopped, offline, ...classification };
}

function baseRecord(paths) {
  const record = readSupervisor(paths);
  record.platform = process.platform;
  record.lastCheckAt = new Date().toISOString();
  return record;
}

async function statusAction(options, paths) {
  const record = readSupervisor(paths);
  const state = await probeAll(options, paths);
  return {
    exitCode: state.exitCode,
    record,
    payload: {
      verdict: state.verdict,
      exitCode: state.exitCode,
      health: state.health,
      heartbeat: state.heartbeat,
      service: state.service,
      stopped: state.stopped,
      enabled: state.settings.enabled,
      installed: record.installed,
      installTarget: record.installTarget,
      restarts: record.restarts,
      lastCheckAt: record.lastCheckAt,
      lastError: record.lastError,
    },
  };
}

async function stopAction(options, paths, { intentional = true } = {}) {
  // 先写标记再停（dsh 语义）：即使优雅停机超时，监控也不会把服务复活。
  if (intentional) {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.stopMarker, `${JSON.stringify({ at: new Date().toISOString(), reason: "stop" })}\n`, { mode: 0o600 });
  }
  const service = readService(paths);
  const heartbeat = readHeartbeat(paths);
  const pid = service?.pid ?? heartbeat.pid;
  if (!pid || !pidAlive(pid)) {
    rmSync(paths.service, { force: true });
    return { stopped: true, pid: null, forced: false };
  }

  // Windows 上 process.kill 是强杀，绝不这么停；进程内的 keeper 每 15s 看到标记会
  // 自己走 SIGTERM 优雅路径。POSIX 上也只发 SIGTERM（优雅），不强杀。
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + options.stopTimeout * 1000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (pidAlive(pid)) {
    if (!options.force) {
      throw new Error(
        `Graceful stop timed out after ${options.stopTimeout}s; no forced kill was sent. `
        + "The in-process keeper exits within one tick (15s) of the marker — if it did not, pass --force to kill it.",
      );
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best effort.
    }
    return { stopped: !pidAlive(pid), pid, forced: true };
  }
  rmSync(paths.service, { force: true });
  return { stopped: true, pid, forced: false };
}

function spawnServer(options, paths) {
  const server = resolveServer(options);
  mkdirSync(paths.logsDir, { recursive: true });
  pruneLogs(paths.logsDir);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const logPath = join(paths.logsDir, `pi-web-${stamp}-${process.pid}.log`);
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(server.argv[0], server.argv.slice(1), {
    cwd: server.cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PI_WEB_NO_OPEN: "1" },
  });
  closeSync(logFd);
  child.unref();
  writeService(paths, {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    command: server.command,
    cwd: server.cwd,
    logPath,
  });
  return { pid: child.pid, logPath, command: server.command };
}

async function waitForHealthy(options, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealth(healthUrl(options), options.timeout);
    if (health.ok) return true;
    await new Promise((done) => setTimeout(done, 700));
  }
  return false;
}

async function startAction(options, paths) {
  const state = await probeAll(options, paths);
  if (state.health.ok) {
    // 已经在跑（可能是用户手工/桌面版拉起的）：不重复拉起，只接管记录。
    if (!state.service && state.heartbeat.pid && pidAlive(state.heartbeat.pid)) {
      writeService(paths, {
        pid: state.heartbeat.pid,
        startedAt: new Date().toISOString(),
        command: null,
        cwd: null,
        logPath: null,
      });
    }
    rmSync(paths.stopMarker, { force: true });
    return { spawned: false, alreadyRunning: true, pid: state.heartbeat.pid ?? state.service?.pid ?? null };
  }
  const spawned = spawnServer(options, paths);
  const healthy = await waitForHealthy(options, options.startTimeout);
  if (healthy) {
    rmSync(paths.stopMarker, { force: true });
    return { spawned: true, healthy: true, ...spawned };
  }
  throw Object.assign(
    new Error(
      `Server did not answer /health within ${Math.round(options.startTimeout / 1000)}s; `
      + `it was left running (log: ${spawned.logPath}).`,
    ),
    { exitCode: EXIT_ATTENTION, logPath: spawned.logPath, pid: spawned.pid },
  );
}

async function checkAction(options, paths) {
  return withLock(paths, async () => {
    const state = await probeAll(options, paths);
    const record = baseRecord(paths);
    record.health = state.verdict;
    record.spawnedPid = state.service?.pid ?? null;

    if (state.verdict === "stopped") {
      record.lastAction = "none";
      writeSupervisor(paths, record);
      return { exitCode: EXIT_STOPPED, record, result: { verdict: "stopped", note: "Intentional stop is active; automatic recovery skipped." } };
    }
    if (state.verdict === "disabled") {
      record.lastAction = "none";
      record.lastError = null;
      writeSupervisor(paths, record);
      return { exitCode: EXIT_OK, record, result: { verdict: "disabled", note: "Keepalive is off in Settings; no restart." } };
    }
    if (state.verdict === "healthy") {
      record.lastAction = "none";
      record.lastError = null;
      writeSupervisor(paths, record);
      return { exitCode: EXIT_OK, record, result: { verdict: "healthy", pid: state.heartbeat.pid ?? state.service?.pid ?? null } };
    }
    if (state.verdict === "offline") {
      record.lastError = null;
      writeSupervisor(paths, record);
      return { exitCode: EXIT_RESTARTABLE, record, result: { verdict: "offline", note: "Network looks down; waiting for reconnect." } };
    }

    const budget = restartBudget({ restartTimes: record.restartTimes, maxRestarts: options.maxRestarts });
    if (budget.exhausted) {
      record.lastAction = "none";
      record.health = "degraded";
      record.lastError = `Restart budget exhausted (${budget.recent.length}/${options.maxRestarts} in the last hour); needs a person.`;
      writeSupervisor(paths, record);
      return { exitCode: EXIT_ATTENTION, record, result: { verdict: "degraded", error: record.lastError } };
    }

    // 重启：非 intent 的 stop（不落标记）→ start。失败抛 2。
    try {
      await stopAction(options, paths, { intentional: false });
      const started = await startAction(options, paths);
      record.lastAction = state.verdict === "stale" ? "restarted" : "spawned";
      record.restarts += 1;
      record.lastRestartAt = new Date().toISOString();
      record.restartTimes = [...budget.recent, Date.now()];
      record.lastError = null;
      record.spawnedPid = started.pid ?? null;
      record.logPath = started.logPath ?? record.logPath ?? null;
      record.health = "healthy";
      writeSupervisor(paths, record);
      return { exitCode: EXIT_OK, record, result: { verdict: state.verdict, restarted: true, ...started } };
    } catch (error) {
      record.lastAction = "error";
      record.lastError = String(error?.message ?? error);
      record.health = "degraded";
      writeSupervisor(paths, record);
      return { exitCode: EXIT_ATTENTION, record, result: { verdict: "degraded", error: record.lastError } };
    }
  });
}

// ───────────────────────────── install / uninstall ─────────────────────────────

function runCommand(command, args, { dryRun = false } = {}) {
  const line = [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
  if (dryRun) return { line, skipped: true };
  const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { line, output };
}

function installAction(options, paths) {
  const port = options.port ?? resolvePort();
  const record = baseRecord(paths);
  const minutes = Math.max(1, Math.round(options.interval / 60));
  const intervalSeconds = Math.max(60, Math.round(options.interval));

  if (process.platform === "win32") {
    mkdirSync(paths.dir, { recursive: true });
    const wrapperPath = join(paths.dir, "pi-supervisor-task.cmd");
    writeFileSync(
      wrapperPath,
      buildWindowsWrapper({ nodePath: process.execPath, scriptPath: SCRIPT_PATH, port }),
      { mode: 0o600 },
    );
    const args = buildWindowsSchtasksArgs({ wrapperPath, minutes });
    let installed = !options.dryRun;
    let error = null;
    try {
      runCommand("schtasks.exe", args, { dryRun: options.dryRun });
    } catch (failure) {
      installed = false;
      error = `schtasks failed: ${failure?.message ?? failure}`;
    }
    record.installed = installed;
    record.installTarget = TASK_NAME_WINDOWS;
    record.lastAction = "install";
    record.lastError = error;
    writeSupervisor(paths, record);
    return {
      exitCode: installed || options.dryRun ? EXIT_OK : EXIT_ATTENTION,
      record,
      result: {
        platform: "win32",
        task: TASK_NAME_WINDOWS,
        wrapperPath,
        command: `schtasks /Create /SC MINUTE /MO ${minutes} /TN ${TASK_NAME_WINDOWS} /TR "${wrapperPath}" /F`,
        dryRun: options.dryRun,
        error,
      },
    };
  }

  if (process.platform === "darwin") {
    const dir = join(userHome(), "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    const plistPath = join(dir, `${LAUNCHD_LABEL}.plist`);
    const plist = buildLaunchdPlist({
      nodePath: process.execPath,
      scriptPath: SCRIPT_PATH,
      port,
      intervalSeconds,
      stdoutPath: join(paths.logsDir, "launchd.out.log"),
      stderrPath: join(paths.logsDir, "launchd.err.log"),
    });
    if (!options.dryRun) writeFileSync(plistPath, plist, { mode: 0o600 });
    const load = runCommand("launchctl", ["load", "-w", plistPath], { dryRun: options.dryRun });
    record.installed = !options.dryRun;
    record.installTarget = plistPath;
    record.lastAction = "install";
    record.lastError = null;
    writeSupervisor(paths, record);
    return { exitCode: EXIT_OK, record, result: { platform: "darwin", plistPath, load: load.line, dryRun: options.dryRun } };
  }

  // Linux：systemd user timer；没有 systemd 时打印等价的 cron 行。
  const systemdDir = join(userHome(), ".config", "systemd", "user");
  mkdirSync(systemdDir, { recursive: true });
  const units = buildSystemdUnits({ nodePath: process.execPath, scriptPath: SCRIPT_PATH, port, intervalSeconds });
  const servicePath = join(systemdDir, "pi-agent-keepalive.service");
  const timerPath = join(systemdDir, "pi-agent-keepalive.timer");
  if (!options.dryRun) {
    writeFileSync(servicePath, units.service, { mode: 0o600 });
    writeFileSync(timerPath, units.timer, { mode: 0o600 });
  }
  try {
    runCommand("systemctl", ["--user", "daemon-reload"], { dryRun: options.dryRun });
    runCommand("systemctl", ["--user", "enable", "--now", "pi-agent-keepalive.timer"], { dryRun: options.dryRun });
    record.installed = !options.dryRun;
    record.installTarget = timerPath;
    record.lastError = null;
  } catch (error) {
    record.installed = false;
    record.installTarget = timerPath;
    record.lastError = `systemctl --user failed: ${error?.message ?? error}. Files are in ${systemdDir}; add a cron entry instead:`;
  }
  record.lastAction = "install";
  writeSupervisor(paths, record);
  return {
    exitCode: record.installed || options.dryRun ? EXIT_OK : EXIT_ATTENTION,
    record,
    result: {
      platform: "linux",
      servicePath,
      timerPath,
      cron: `*/${Math.max(1, Math.round(intervalSeconds / 60))} * * * * "${process.execPath}" "${SCRIPT_PATH}" check --respect-stop --port ${port}`,
      dryRun: options.dryRun,
    },
  };
}

function uninstallAction(options, paths) {
  const record = baseRecord(paths);
  let removed = null;
  if (process.platform === "win32") {
    runCommand("schtasks.exe", ["/Delete", "/F", "/TN", TASK_NAME_WINDOWS], { dryRun: options.dryRun });
    removed = TASK_NAME_WINDOWS;
  } else if (process.platform === "darwin") {
    const plistPath = join(userHome(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    try {
      runCommand("launchctl", ["unload", "-w", plistPath], { dryRun: options.dryRun });
    } catch {
      // Not loaded.
    }
    if (!options.dryRun) rmSync(plistPath, { force: true });
    removed = plistPath;
  } else {
    try {
      runCommand("systemctl", ["--user", "disable", "--now", "pi-agent-keepalive.timer"], { dryRun: options.dryRun });
    } catch {
      // Not installed.
    }
    const dir = join(userHome(), ".config", "systemd", "user");
    if (!options.dryRun) {
      rmSync(join(dir, "pi-agent-keepalive.service"), { force: true });
      rmSync(join(dir, "pi-agent-keepalive.timer"), { force: true });
    }
    removed = "pi-agent-keepalive.timer";
  }
  record.installed = false;
  record.installTarget = null;
  record.lastAction = "uninstall";
  record.lastError = null;
  writeSupervisor(paths, record);
  return { exitCode: EXIT_OK, record, result: { removed, dryRun: options.dryRun } };
}

// ───────────────────────────── main ─────────────────────────────

export async function runAction(options) {
  const paths = resolvePaths(options);
  mkdirSync(paths.dir, { recursive: true });

  switch (options.action) {
    case "status": {
      const { exitCode, payload } = await statusAction(options, paths);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return exitCode;
    }
    case "check": {
      const outcome = await checkAction(options, paths);
      if (outcome === null) {
        process.stdout.write(`${JSON.stringify({ verdict: "busy", note: "Another supervisor check is running; skipped." })}\n`);
        return EXIT_OK;
      }
      process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
      return outcome.exitCode;
    }
    case "start": {
      const outcome = await withLock(paths, () => startAction(options, paths));
      if (outcome === null) {
        process.stdout.write(`${JSON.stringify({ note: "Another supervisor operation is running; skipped." })}\n`);
        return EXIT_OK;
      }
      const record = baseRecord(paths);
      record.lastAction = outcome.spawned ? "spawned" : "none";
      record.spawnedPid = outcome.pid ?? record.spawnedPid;
      record.logPath = outcome.logPath ?? record.logPath;
      record.health = "healthy";
      record.lastError = null;
      writeSupervisor(paths, record);
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return EXIT_OK;
    }
    case "stop": {
      const outcome = await withLock(paths, () => stopAction(options, paths, { intentional: true }));
      if (outcome === null) return EXIT_OK;
      const record = baseRecord(paths);
      record.lastAction = "stopped";
      record.health = "stopped";
      record.lastError = null;
      writeSupervisor(paths, record);
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return EXIT_OK;
    }
    case "restart": {
      const outcome = await withLock(paths, async () => {
        await stopAction(options, paths, { intentional: false });
        return startAction(options, paths);
      });
      if (outcome === null) return EXIT_OK;
      const record = baseRecord(paths);
      record.lastAction = "restarted";
      record.restarts += 1;
      record.lastRestartAt = new Date().toISOString();
      record.restartTimes = [...record.restartTimes.slice(-20), Date.now()];
      record.spawnedPid = outcome.pid ?? null;
      record.logPath = outcome.logPath ?? record.logPath;
      record.health = "healthy";
      record.lastError = null;
      writeSupervisor(paths, record);
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return EXIT_OK;
    }
    case "install": {
      const outcome = installAction(options, paths);
      process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
      return outcome.exitCode;
    }
    case "uninstall": {
      const outcome = uninstallAction(options, paths);
      process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
      return outcome.exitCode;
    }
    case "run": {
      process.stdout.write(`pi-supervisor watching every ${options.interval}s. Ctrl-C to stop.\n`);
      let running = true;
      const onSignal = () => {
        running = false;
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      while (running) {
        const outcome = await checkAction(options, paths);
        if (outcome) process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...outcome.result })}\n`);
        await new Promise((done) => setTimeout(done, Math.max(5, options.interval) * 1000));
      }
      return EXIT_OK;
    }
    default:
      throw new Error("Missing action (status|check|start|stop|restart|install|uninstall|run)");
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return EXIT_ATTENTION;
  }
  if (options.help || !options.action) {
    process.stdout.write(`${readFileSync(SCRIPT_PATH, "utf8").split("\n").slice(1, 52).map((line) => line.replace(/^ \* ?/, "")).join("\n")}\n`);
    return options.help ? EXIT_OK : EXIT_ATTENTION;
  }
  try {
    return await runAction(options);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    return typeof error?.exitCode === "number" ? error.exitCode : EXIT_RESTARTABLE;
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = await main();
}
