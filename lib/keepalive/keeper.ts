import { acquireLease, isPidAlive, releaseLease } from "../scheduled-tasks/lease";
import { scanAutofixTasks } from "./resume";
import {
  appendKeepaliveEvent,
  isKeepaliveStopped,
  keepaliveDir,
  readKeepaliveSettings,
  readKeepaliveState,
  readKeepaliveStopMarker,
  writeKeepaliveState,
} from "./store";
import {
  KEEPALIVE_AUTOFIX_STALE_MS,
  KEEPALIVE_HEARTBEAT_STALE_MS,
  KEEPALIVE_RESUME_INTERVAL_MS,
  KEEPALIVE_TICK_MS,
  KEEPALIVE_VERSION,
  type InterruptedSnapshot,
  type KeepaliveResumeInfo,
  type KeepaliveState,
} from "./types";

/**
 * 进程内保活循环（instrumentation 启动）。
 *
 * 每个 tick 做四件事：
 * 1. **心跳**：把 pid / uptime / heartbeatAt 写进 `~/.pi/agent/keepalive/state.json`。
 *    外部守护脚本（scripts/pi-supervisor.mjs）用「/health 可达 + 心跳新鲜」判假死。
 * 2. **接续扫描**：每 5 分钟只读扫描 autofix 任务，把「待接续」数量记进状态与事件。
 *    autofix 的驱动由 t3 自己的 `startAutofixSweepLoop()` 完成（进程重启后自愈），
 *    保活侧不重复驱动、不写对方文件。
 * 3. **中断快照**：启动后的第一个 tick 读上一次进程留下的 `runningSessions`，
 *    把「上次退出时还在跑的会话」记成 interrupted，供 UI 提示。
 * 4. **停止标记**：`manually-stopped` 里 reason=stop（守护脚本 stop 写入）时，
 *    进程内优雅退出（SIGTERM 走 pi-web 既有的 closeAllAgentEventStreams 路径），
 *    这样 Windows 上不依赖外部强杀也能优雅停机。
 *
 * 单进程约束复用 scheduled-tasks 的**租约**（`acquireLease`）：dev 服务与桌面版可能
 * 同时读同一个 `~/.pi/agent`，只让租约持有者写心跳/跑接续，避免两份状态互相覆盖。
 *
 * 保活循环**不重启进程**——它自己就在进程里。崩溃/假死/关机后的拉起由外部
 * `scripts/pi-supervisor.mjs`（计划任务/launchd/systemd）负责。
 */

export interface KeepaliveKeeperOptions {
  agentDir?: string;
  tickMs?: number;
  resumeIntervalMs?: number;
  staleAutofixMs?: number;
  now?: () => Date;
  alive?: (pid: number) => boolean;
  /** 测试缝：false 时不抢租约（单测直接构造并 tick）。 */
  acquireOwnership?: boolean;
  /** 测试缝：关闭「停止标记触发自我退出」。 */
  honorStopMarker?: boolean;
  /** 进行中会话提供者；默认空（keeper 首次 tick 时懒加载 rpc-manager 的真实快照）。 */
  runningSessions?: () => string[] | Promise<string[]>;
  /** 测试缝：替换扫描函数。 */
  scanTasks?: typeof scanAutofixTasks;
  /** 测试缝：替换进程退出。 */
  exit?: (signal: NodeJS.Signals) => void;
}

export class KeepaliveKeeper {
  private readonly agentDir: string;
  private readonly tickMs: number;
  private readonly resumeIntervalMs: number;
  private readonly staleAutofixMs: number;
  private readonly clock: () => Date;
  private readonly alive: (pid: number) => boolean;
  private readonly acquireOwnership: boolean;
  private readonly honorStopMarker: boolean;
  private readonly scanTasks: typeof scanAutofixTasks;
  private readonly exit: (signal: NodeJS.Signals) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private owned = false;
  private stopped = false;
  private ticking = false;
  private initialized = false;
  private startedAt: string | null = null;
  private lastTickAt: number | null = null;
  private resume: KeepaliveResumeInfo = {
    lastAt: null,
    runs: 0,
    examined: 0,
    resumed: [],
    lastError: null,
  };
  private interrupted: InterruptedSnapshot | null = null;
  private history = [] as KeepaliveState["history"];
  private lastRunningSessions: string[] = [];
  private lastStuck = 0;
  private lastEnabled: boolean | null = null;
  private runningProvider: (() => Promise<string[]>) | null = null;

  constructor(options: KeepaliveKeeperOptions = {}) {
    this.agentDir = options.agentDir ?? "";
    this.tickMs = options.tickMs ?? KEEPALIVE_TICK_MS;
    this.resumeIntervalMs = options.resumeIntervalMs ?? KEEPALIVE_RESUME_INTERVAL_MS;
    this.staleAutofixMs = options.staleAutofixMs ?? KEEPALIVE_AUTOFIX_STALE_MS;
    this.clock = options.now ?? (() => new Date());
    this.alive = options.alive ?? isPidAlive;
    this.acquireOwnership = options.acquireOwnership ?? true;
    this.honorStopMarker = options.honorStopMarker ?? true;
    const provider = options.runningSessions;
    this.runningProvider = provider ? async () => provider() : null;
    this.scanTasks = options.scanTasks ?? scanAutofixTasks;
    this.exit = options.exit ?? ((signal) => process.kill(process.pid, signal));
  }

  /**
   * 进行中会话快照（重启后用于「哪些会话被打断」的提示）。
   * 与 scheduled-tasks/runtime.ts 同法：rpc-manager 只在第一次 tick 时动态加载，
   * 保证 instrumentation 启动本身便宜。
   */
  private async loadRunningSessions(): Promise<string[]> {
    if (this.runningProvider) {
      try {
        const ids = await this.runningProvider();
        return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
      } catch {
        return this.lastRunningSessions;
      }
    }
    try {
      const { getRunningRpcSessionIds } = await import("../rpc-manager");
      return getRunningRpcSessionIds();
    } catch {
      return this.lastRunningSessions;
    }
  }

  private dir(): string {
    return this.agentDir || keepaliveDir();
  }

  isOwner(): boolean {
    return this.owned;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // 定时器不该撑住进程退出（Next 的 SIGTERM 路径自己会结束进程）。
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.owned) {
      releaseLease(this.dir());
      this.owned = false;
    }
  }

  /** 供路由/测试读取当前内存态（可能比磁盘新）。 */
  snapshot(): KeepaliveState {
    return this.buildState();
  }

  /** 跑一轮。可重入保护：上一轮没跑完就跳过（接续扫描可能比 tick 慢）。 */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } catch (error) {
      this.history = appendKeepaliveEvent(this.history, {
        at: this.clock().toISOString(),
        kind: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    if (this.acquireOwnership && !this.owned) {
      this.owned = acquireLease(this.dir(), { now: this.clock(), alive: this.alive });
      if (!this.owned) return;
    }

    const now = this.clock();
    const nowMs = now.getTime();
    const previousState = this.initialized ? null : readKeepaliveState(this.agentDir || undefined);
    const settings = readKeepaliveSettings(this.agentDir || undefined);

    // 停止标记：守护脚本的 stop 先写标记再等进程退出；进程内看到它就优雅退出。
    if (this.honorStopMarker && isKeepaliveStopped(this.agentDir || undefined)) {
      const marker = readKeepaliveStopMarker(this.agentDir || undefined);
      if (marker?.reason === "stop") {
        this.history = appendKeepaliveEvent(this.history, {
          at: now.toISOString(),
          kind: "stop",
          detail: "收到停止标记，进程内优雅退出",
        });
        this.writeState(now, settings.enabled, []);
        this.stopped = true;
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        if (this.owned) {
          releaseLease(this.dir());
          this.owned = false;
        }
        this.exit("SIGTERM");
        return;
      }
    }

    if (!this.initialized) {
      this.initialized = true;
      this.history = previousState?.history ?? [];
      this.resume = previousState?.resume ?? this.resume;
      this.interrupted = previousState?.interrupted ?? null;
      if (
        previousState
        && previousState.pid !== process.pid
        && previousState.runningSessions.length > 0
      ) {
        this.interrupted = {
          at: now.toISOString(),
          sessionIds: [...previousState.runningSessions],
          previousPid: previousState.pid,
          previousHeartbeatAt: previousState.heartbeatAt || null,
        };
        this.history = appendKeepaliveEvent(this.history, {
          at: now.toISOString(),
          kind: "interrupted",
          detail: `上次退出时有 ${previousState.runningSessions.length} 个会话仍在运行`,
          count: previousState.runningSessions.length,
        });
      }
      this.history = appendKeepaliveEvent(this.history, {
        at: now.toISOString(),
        kind: "start",
        detail: `保活守护启动（pid ${process.pid}${settings.enabled ? "" : "，用户开关关闭"}）`,
      });
    }

    // 睡眠/休眠恢复：tick 间隔异常放大说明机器睡过或断网卡过，恢复后立即重扫一次。
    const gap = this.lastTickAt === null ? 0 : nowMs - this.lastTickAt;
    const wokeUp = gap > Math.max(this.tickMs * 4, KEEPALIVE_HEARTBEAT_STALE_MS);
    if (wokeUp) {
      this.history = appendKeepaliveEvent(this.history, {
        at: now.toISOString(),
        kind: "wake",
        detail: `机器休眠/挂起后恢复（间隔 ${Math.round(gap / 1000)}s），立即重扫接续进度`,
      });
    }
    this.lastTickAt = nowMs;

    if (this.lastEnabled !== null && this.lastEnabled !== settings.enabled) {
      this.history = appendKeepaliveEvent(this.history, {
        at: now.toISOString(),
        kind: settings.enabled ? "enabled" : "disabled",
        detail: settings.enabled ? "用户打开挂机保活" : "用户关闭挂机保活",
      });
    }
    this.lastEnabled = settings.enabled;

    const running = await this.loadRunningSessions();
    this.lastRunningSessions = running;

    if (settings.enabled) {
      const lastResumeMs = this.resume.lastAt ? new Date(this.resume.lastAt).getTime() : null;
      const due = wokeUp
        || lastResumeMs === null
        || !Number.isFinite(lastResumeMs)
        || nowMs - lastResumeMs >= this.resumeIntervalMs;
      if (due) this.runResumeScan(nowMs);
    }

    this.writeState(now, settings.enabled, this.lastRunningSessions);
  }

  /**
   * 接续扫描（只读 + 记账）。真正把孤儿任务重新驱动的是 autofix 自己的 sweep 循环；
   * 这里把「还有几个待接续」写进状态，UI 与外部脚本都能看到。
   */
  private runResumeScan(nowMs: number): void {
    let summary;
    try {
      summary = this.scanTasks({
        agentDir: this.agentDir || undefined,
        now: nowMs,
        staleMs: this.staleAutofixMs,
        alive: this.alive,
      }).summary;
    } catch (error) {
      this.resume = {
        ...this.resume,
        lastAt: new Date(nowMs).toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      return;
    }
    const stuck = summary.stuck;
    this.resume = {
      lastAt: new Date(nowMs).toISOString(),
      runs: this.resume.runs + 1,
      examined: summary.active + stuck,
      resumed: [],
      lastError: null,
    };
    if (stuck > 0 || this.lastStuck > 0) {
      this.history = appendKeepaliveEvent(this.history, {
        at: new Date(nowMs).toISOString(),
        kind: stuck > 0 ? "resume" : "resume-skip",
        detail: stuck > 0
          ? `发现 ${stuck} 个 autofix 孤儿任务，等待 autofix 自愈循环接续`
          : "autofix 孤儿任务已全部接续",
        count: stuck,
      });
    }
    this.lastStuck = stuck;
  }

  private buildState(): KeepaliveState {
    const now = this.clock();
    return {
      version: KEEPALIVE_VERSION,
      pid: process.pid,
      startedAt: this.startedAt ?? now.toISOString(),
      heartbeatAt: now.toISOString(),
      uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)),
      enabled: readKeepaliveSettings(this.agentDir || undefined).enabled,
      runningSessions: this.lastRunningSessions,
      interrupted: this.interrupted,
      resume: this.resume,
      history: this.history,
    };
  }

  private writeState(now: Date, enabled: boolean, runningSessions: string[]): void {
    this.startedAt ??= now.toISOString();
    this.lastRunningSessions = runningSessions;
    const state = this.buildState();
    state.enabled = enabled;
    state.runningSessions = runningSessions;
    writeKeepaliveState(state, this.agentDir || undefined);
  }
}

// ───────────────────────────── process-wide holder ─────────────────────────────

// globalThis 能活过 Next 的热重载，模块级变量不行（与 scheduler 同法）。
const KEEPER_KEY = Symbol.for("pi-web:keepalive-keeper");
type Holder = { [KEEPER_KEY]?: KeepaliveKeeper };

export function startKeepalive(options: KeepaliveKeeperOptions = {}): KeepaliveKeeper {
  const holder = globalThis as unknown as Holder;
  const keeper = holder[KEEPER_KEY] ?? new KeepaliveKeeper(options);
  holder[KEEPER_KEY] = keeper;
  keeper.start();
  return keeper;
}
