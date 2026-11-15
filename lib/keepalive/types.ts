/**
 * 挂机保活（Keepalive）——共享类型与常量。
 *
 * 分工：
 * - 进程内（`lib/keepalive/keeper.ts`，由 instrumentation 启动）：心跳落盘、接续进度、
 *   状态汇报。它无法重启自己，所以**崩溃/假死后的拉起**归外部守护脚本
 *   `scripts/pi-supervisor.mjs`（Windows 计划任务 / launchd / systemd）。
 * - 状态目录：`~/.pi/agent/keepalive/`（`getAgentDir()`，勿用字面 homedir）。
 * - autofix 任务的进度文件归 t3（`~/.pi/agent/autofix/tasks/<uuid>.json`），这里只做
 *   **只读**扫描与孤儿分类；驱动/接续由 autofix 自己的 runner 完成（注册钩子或自带循环）。
 */

export const KEEPALIVE_VERSION = 1 as const;

/** 进程内 tick：写心跳、看停止标记、偶尔跑一次接续。 */
export const KEEPALIVE_TICK_MS = 15_000;

/** 心跳超过这个时间没更新 = 假死/挂起（脚本据此判 1，可重启修复）。3 个 tick 余量。 */
export const KEEPALIVE_HEARTBEAT_STALE_MS = 90_000;

/** 接续扫描的间隔：启动后立即跑一次，之后每 5 分钟一次。 */
export const KEEPALIVE_RESUME_INTERVAL_MS = 5 * 60_000;

/** autofix 孤儿判据：pid 缺失/已死之后，updatedAt 至少陈旧这么久才算可接续。 */
export const KEEPALIVE_AUTOFIX_STALE_MS = 10 * 60_000;

/** 状态文件里保留的事件条数上限。 */
export const KEEPALIVE_HISTORY_LIMIT = 50;

export type KeepaliveEventKind =
  | "start"
  | "enabled"
  | "disabled"
  | "resume"
  | "resume-skip"
  | "interrupted"
  | "wake"
  | "stop"
  | "error";

export interface KeepaliveEvent {
  at: string;
  kind: KeepaliveEventKind;
  detail: string;
  /** 可选计数（接续任务数、中断会话数等）。 */
  count?: number;
}

export interface KeepaliveSettings {
  version: typeof KEEPALIVE_VERSION;
  /** 用户开关（设置页「挂机保活」）。关闭后不再接续，外部守护也跳过自动拉起。 */
  enabled: boolean;
  updatedAt: string;
}

/** 上一次进程留下的「进行中会话」快照，重启后用于提示哪些会话被打断。 */
export interface InterruptedSnapshot {
  at: string;
  sessionIds: string[];
  previousPid: number | null;
  previousHeartbeatAt: string | null;
}

export interface KeepaliveResumeInfo {
  /** 最近一次接续尝试（ISO）；从未跑过为 null。 */
  lastAt: string | null;
  /** 累计接续通过（钩子数）。 */
  runs: number;
  /** 最近一次各钩子的 examined/resumed 汇总。 */
  examined: number;
  resumed: string[];
  /** 最近一次接续的错误（钩子抛错也记这里，不打断 tick）。 */
  lastError: string | null;
}

export interface KeepaliveState {
  version: typeof KEEPALIVE_VERSION;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  uptimeMs: number;
  enabled: boolean;
  /** 本进程目睹的进行中会话 id（供下次重启判断「哪些会话被打断」）。 */
  runningSessions: string[];
  interrupted: InterruptedSnapshot | null;
  resume: KeepaliveResumeInfo;
  history: KeepaliveEvent[];
}

/** autofix 任务进度（t3 契约的只读子集；字段缺失一律容错）。 */
export interface AutofixTaskLike {
  id?: string;
  task?: string;
  cwd?: string;
  status?: string;
  round?: number;
  maxRounds?: number;
  lastError?: string | null;
  sessionId?: string | null;
  pid?: number | null;
  updatedAt?: number;
}

export interface AutofixSummary {
  total: number;
  active: number;
  stuck: number;
  succeeded: number;
  failed: number;
}

export type SupervisorVerdict =
  | "healthy"
  | "unreachable"
  | "stale"
  | "offline"
  | "stopped"
  | "degraded"
  | "unknown";

/** 外部守护脚本写入的最近一次巡检记录（`supervisor.json`）。 */
export interface SupervisorRecord {
  version: typeof KEEPALIVE_VERSION;
  platform: string;
  installed: boolean;
  /** 已注册的 OS 计划名/单元名/plist 路径；未安装为 null。 */
  installTarget: string | null;
  lastCheckAt: string | null;
  lastAction: "none" | "spawned" | "restarted" | "stopped" | "install" | "uninstall" | "error";
  lastError: string | null;
  /** 最近一小时内的重启次数。 */
  restarts: number;
  lastRestartAt: string | null;
  spawnedPid: number | null;
  health: SupervisorVerdict | null;
  logPath: string | null;
}

export interface KeepaliveStatusServer {
  pid: number;
  startedAt: string | null;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  /** 心跳是否已陈旧到假死判据。 */
  heartbeatStale: boolean;
  uptimeMs: number;
}

export interface KeepaliveStatus {
  version: typeof KEEPALIVE_VERSION;
  enabled: boolean;
  dataDir: string;
  server: KeepaliveStatusServer;
  interrupted: InterruptedSnapshot | null;
  resume: KeepaliveResumeInfo;
  runningSessionIds: string[];
  supervisor: {
    record: SupervisorRecord | null;
    /** 停止标记（`manually-stopped`）：存在则守护/接续不再自动复活。 */
    stopped: boolean;
    /** 本仓库里能执行 `scripts/pi-supervisor.mjs` 的绝对路径；打包版可能没有。 */
    scriptPath: string | null;
    installSupported: boolean;
  };
  autofix: AutofixSummary | null;
  history: KeepaliveEvent[];
}
