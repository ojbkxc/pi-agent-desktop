import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { scanAutofixTasks } from "./resume";
import {
  isKeepaliveStopped,
  keepaliveDir,
  readKeepaliveSettings,
  readKeepaliveState,
  readSupervisorRecord,
} from "./store";
import {
  KEEPALIVE_HEARTBEAT_STALE_MS,
  KEEPALIVE_VERSION,
  type KeepaliveStatus,
} from "./types";

/**
 * `GET /api/keepalive` 的状态装配（服务端）。
 *
 * 服务状态取**当前进程**（请求就是它自己处理的），心跳/接续/中断取
 * `~/.pi/agent/keepalive/state.json`（keeper 每 15s 写）。autofix 汇总走只读扫描，
 * 目录不存在时返回 null，UI 显示「autofix 未启用」而不是 0 个任务。
 */

export interface BuildKeepaliveStatusOptions {
  agentDir?: string;
  now?: () => Date;
  runningSessionIds?: string[];
  /** 测试缝。 */
  scanTasks?: typeof scanAutofixTasks;
  /** 测试缝：找守护脚本的起点目录。 */
  cwd?: string;
}

const INSTALL_PLATFORMS = new Set<NodeJS.Platform>(["win32", "darwin", "linux"]);

/** 仓库里可执行的守护脚本路径；打包版（resources/server 下）通常没有，返回 null。 */
export function supervisorScriptPath(cwd: string = process.cwd()): string | null {
  const path = join(cwd, "scripts", "pi-supervisor.mjs");
  return existsSync(path) ? path : null;
}

function isoOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function buildKeepaliveStatus(options: BuildKeepaliveStatusOptions = {}): KeepaliveStatus {
  const agentDir = options.agentDir ?? getAgentDir();
  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const settings = readKeepaliveSettings(agentDir);
  const state = readKeepaliveState(agentDir);
  const heartbeatAt = isoOf(state?.heartbeatAt);
  const heartbeatAgeMs = heartbeatAt ? Math.max(0, nowMs - new Date(heartbeatAt).getTime()) : null;
  const scriptPath = supervisorScriptPath(options.cwd);

  const scan = (options.scanTasks ?? scanAutofixTasks)({
    agentDir,
    now: nowMs,
  });

  return {
    version: KEEPALIVE_VERSION,
    enabled: settings.enabled,
    dataDir: keepaliveDir(agentDir),
    server: {
      pid: process.pid,
      startedAt: state?.pid === process.pid ? isoOf(state.startedAt) : null,
      heartbeatAt,
      heartbeatAgeMs,
      heartbeatStale: heartbeatAgeMs !== null && heartbeatAgeMs > KEEPALIVE_HEARTBEAT_STALE_MS,
      uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)),
    },
    interrupted: state?.interrupted ?? null,
    resume: state?.resume ?? { lastAt: null, runs: 0, examined: 0, resumed: [], lastError: null },
    runningSessionIds: options.runningSessionIds ?? state?.runningSessions ?? [],
    supervisor: {
      record: readSupervisorRecord(agentDir),
      stopped: isKeepaliveStopped(agentDir),
      scriptPath,
      installSupported: INSTALL_PLATFORMS.has(process.platform) && scriptPath !== null,
    },
    autofix: scan.unavailable ? null : scan.summary,
    history: (state?.history ?? []).slice(-20),
  };
}
