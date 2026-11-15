import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import {
  KEEPALIVE_HISTORY_LIMIT,
  KEEPALIVE_VERSION,
  type KeepaliveEvent,
  type KeepaliveResumeInfo,
  type KeepaliveSettings,
  type KeepaliveState,
  type SupervisorRecord,
} from "./types";

/**
 * 挂机保活的落盘层。目录：`~/.pi/agent/keepalive/`。
 *
 * 全部读操作坏文件即空（缺文件/坏 JSON/形状不对一律返回默认值），绝不让一个坏文件
 * 把服务启动或 tick 卡死；写操作走 `writePrivateFileAtomicSync`（tmp+rename、0600）。
 *
 * 文件：
 * - `settings.json`     用户开关（设置页写）
 * - `state.json`        进程心跳 + 最近接续 + 历史（keeper 写）
 * - `supervisor.json`   外部守护脚本的最近巡检（scripts/pi-supervisor.mjs 写）
 * - `manually-stopped`  停止标记：存在则守护脚本/接续都不自动复活（dsh 语义）
 * - `logs/`             守护脚本拉起服务时的日志
 */

export const KEEPALIVE_SETTINGS_FILE = "settings.json";
export const KEEPALIVE_STATE_FILE = "state.json";
export const KEEPALIVE_SUPERVISOR_FILE = "supervisor.json";
export const KEEPALIVE_STOP_MARKER = "manually-stopped";
export const KEEPALIVE_LOGS_DIR = "logs";

export function keepaliveDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "keepalive");
}

export function keepalivePaths(agentDir: string = getAgentDir()) {
  const dir = keepaliveDir(agentDir);
  return {
    dir,
    settings: join(dir, KEEPALIVE_SETTINGS_FILE),
    state: join(dir, KEEPALIVE_STATE_FILE),
    supervisor: join(dir, KEEPALIVE_SUPERVISOR_FILE),
    stopMarker: join(dir, KEEPALIVE_STOP_MARKER),
    logsDir: join(dir, KEEPALIVE_LOGS_DIR),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ───────────────────────────── settings ─────────────────────────────

export const DEFAULT_KEEPALIVE_SETTINGS: KeepaliveSettings = {
  version: KEEPALIVE_VERSION,
  enabled: false,
  updatedAt: new Date(0).toISOString(),
};

/** 读用户开关；缺文件/坏文件按「关闭」处理（关闭的代价是多点一次开关，不是静默重启）。 */
export function readKeepaliveSettings(agentDir: string = getAgentDir()): KeepaliveSettings {
  const raw = readJson(keepalivePaths(agentDir).settings);
  if (!isRecord(raw) || typeof raw.enabled !== "boolean") return { ...DEFAULT_KEEPALIVE_SETTINGS };
  return {
    version: KEEPALIVE_VERSION,
    enabled: raw.enabled,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : DEFAULT_KEEPALIVE_SETTINGS.updatedAt,
  };
}

export function writeKeepaliveSettings(
  settings: Pick<KeepaliveSettings, "enabled"> & { updatedAt?: string },
  agentDir: string = getAgentDir(),
): KeepaliveSettings {
  const next: KeepaliveSettings = {
    version: KEEPALIVE_VERSION,
    enabled: settings.enabled === true,
    updatedAt: settings.updatedAt ?? new Date().toISOString(),
  };
  writeJson(keepalivePaths(agentDir).settings, next);
  return next;
}

// ───────────────────────────── stop marker ─────────────────────────────

export function isKeepaliveStopped(agentDir: string = getAgentDir()): boolean {
  return existsSync(keepalivePaths(agentDir).stopMarker);
}

/** 先写标记再停服务（dsh 语义）：即使优雅停机超时，守护也不会把服务复活。 */
export function writeKeepaliveStopMarker(
  reason: string,
  agentDir: string = getAgentDir(),
): void {
  const path = keepalivePaths(agentDir).stopMarker;
  mkdirSync(keepalivePaths(agentDir).dir, { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ at: new Date().toISOString(), reason })}\n`);
}

export function clearKeepaliveStopMarker(agentDir: string = getAgentDir()): void {
  rmSync(keepalivePaths(agentDir).stopMarker, { force: true });
}

export function readKeepaliveStopMarker(agentDir: string = getAgentDir()): { at: string | null; reason: string | null } | null {
  if (!isKeepaliveStopped(agentDir)) return null;
  const raw = readJson(keepalivePaths(agentDir).stopMarker);
  if (!isRecord(raw)) return { at: null, reason: null };
  return {
    at: typeof raw.at === "string" ? raw.at : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

// ───────────────────────────── state ─────────────────────────────

const EMPTY_RESUME: KeepaliveResumeInfo = {
  lastAt: null,
  runs: 0,
  examined: 0,
  resumed: [],
  lastError: null,
};

function normalizeEvent(value: unknown): KeepaliveEvent | null {
  if (!isRecord(value) || typeof value.at !== "string" || typeof value.kind !== "string" || typeof value.detail !== "string") {
    return null;
  }
  return {
    at: value.at,
    kind: value.kind as KeepaliveEvent["kind"],
    detail: value.detail,
    ...(typeof value.count === "number" ? { count: value.count } : {}),
  };
}

function normalizeResume(value: unknown): KeepaliveResumeInfo {
  if (!isRecord(value)) return { ...EMPTY_RESUME };
  const resumed = Array.isArray(value.resumed)
    ? value.resumed.filter((id): id is string => typeof id === "string")
    : [];
  return {
    lastAt: typeof value.lastAt === "string" ? value.lastAt : null,
    runs: typeof value.runs === "number" && Number.isFinite(value.runs) ? value.runs : 0,
    examined: typeof value.examined === "number" && Number.isFinite(value.examined) ? value.examined : 0,
    resumed,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
  };
}

/** 读上一次进程留下的状态；坏文件返回 null（首次启动就是 null）。 */
export function readKeepaliveState(agentDir: string = getAgentDir()): KeepaliveState | null {
  const raw = readJson(keepalivePaths(agentDir).state);
  if (!isRecord(raw) || typeof raw.pid !== "number" || !Number.isFinite(raw.pid)) return null;
  const interrupted = isRecord(raw.interrupted) && Array.isArray(raw.interrupted.sessionIds)
    ? {
        at: typeof raw.interrupted.at === "string" ? raw.interrupted.at : "",
        sessionIds: raw.interrupted.sessionIds.filter((id): id is string => typeof id === "string"),
        previousPid: typeof raw.interrupted.previousPid === "number" ? raw.interrupted.previousPid : null,
        previousHeartbeatAt: typeof raw.interrupted.previousHeartbeatAt === "string" ? raw.interrupted.previousHeartbeatAt : null,
      }
    : null;
  return {
    version: KEEPALIVE_VERSION,
    pid: raw.pid,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    heartbeatAt: typeof raw.heartbeatAt === "string" ? raw.heartbeatAt : "",
    uptimeMs: typeof raw.uptimeMs === "number" && Number.isFinite(raw.uptimeMs) ? raw.uptimeMs : 0,
    enabled: raw.enabled === true,
    runningSessions: Array.isArray(raw.runningSessions)
      ? raw.runningSessions.filter((id): id is string => typeof id === "string")
      : [],
    interrupted,
    resume: normalizeResume(raw.resume),
    history: Array.isArray(raw.history)
      ? raw.history.map(normalizeEvent).filter((event): event is KeepaliveEvent => event !== null)
      : [],
  };
}

export function writeKeepaliveState(state: KeepaliveState, agentDir: string = getAgentDir()): void {
  writeJson(keepalivePaths(agentDir).state, {
    ...state,
    version: KEEPALIVE_VERSION,
    history: state.history.slice(-KEEPALIVE_HISTORY_LIMIT),
  });
}

/** 追加一条事件并保留最新 N 条（纯函数，keeper 与测试共用）。 */
export function appendKeepaliveEvent(
  history: KeepaliveEvent[],
  event: KeepaliveEvent,
  limit: number = KEEPALIVE_HISTORY_LIMIT,
): KeepaliveEvent[] {
  return [...history, event].slice(-Math.max(1, limit));
}

// ───────────────────────────── supervisor record ─────────────────────────────

export function readSupervisorRecord(agentDir: string = getAgentDir()): SupervisorRecord | null {
  const raw = readJson(keepalivePaths(agentDir).supervisor);
  if (!isRecord(raw)) return null;
  const lastAction = typeof raw.lastAction === "string" ? raw.lastAction : "none";
  const health = typeof raw.health === "string" ? raw.health : null;
  return {
    version: KEEPALIVE_VERSION,
    platform: typeof raw.platform === "string" ? raw.platform : "",
    installed: raw.installed === true,
    installTarget: typeof raw.installTarget === "string" ? raw.installTarget : null,
    lastCheckAt: typeof raw.lastCheckAt === "string" ? raw.lastCheckAt : null,
    lastAction: (
      ["none", "spawned", "restarted", "stopped", "install", "uninstall", "error"].includes(lastAction)
        ? lastAction
        : "none"
    ) as SupervisorRecord["lastAction"],
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    restarts: typeof raw.restarts === "number" && Number.isFinite(raw.restarts) ? raw.restarts : 0,
    lastRestartAt: typeof raw.lastRestartAt === "string" ? raw.lastRestartAt : null,
    spawnedPid: typeof raw.spawnedPid === "number" && Number.isFinite(raw.spawnedPid) ? raw.spawnedPid : null,
    health: (
      ["healthy", "unreachable", "stale", "offline", "stopped", "degraded", "unknown"].includes(health ?? "")
        ? health
        : null
    ) as SupervisorRecord["health"],
    logPath: typeof raw.logPath === "string" ? raw.logPath : null,
  };
}

export function writeSupervisorRecord(record: SupervisorRecord, agentDir: string = getAgentDir()): void {
  writeJson(keepalivePaths(agentDir).supervisor, { ...record, version: KEEPALIVE_VERSION });
}
