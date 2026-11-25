"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";

/** 历史快照上限：3 秒一轮询时约等于最近 3 分钟的团队动态。 */
export const WORKBENCH_HISTORY_LIMIT = 60;
/** live 跟随的轮询节奏（沿用改造前的 3 秒）。 */
export const LIVE_REFRESH_MS = 3000;
/** 回放播放：1 倍速时每 1.2 秒前进一格。 */
export const REPLAY_STEP_MS = 1200;
/** 回放倍速档位（与 cc-haha 回放控制条一致）。 */
export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/**
 * 倍速 → 单帧播放间隔：0.5× 慢放 2400ms、1× 1200ms、2× 600ms、4× 300ms。
 * 非法倍速（0 / 负数 / NaN / Infinity）退回 1×，绝不产生无限或零间隔。
 */
export function replayStepMs(speed: number): number {
  const safe = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.round(REPLAY_STEP_MS / safe);
}

/** 把任意数字夹到最近的合法档位（精确命中优先，否则按 >1 归 4×、其余归 1×）。 */
export function clampReplaySpeed(speed: number): ReplaySpeed {
  for (const candidate of REPLAY_SPEEDS) {
    if (speed === candidate) return candidate;
  }
  return Number.isFinite(speed) && speed > 1 ? 4 : 1;
}
/** 拉取失败后的重试上限：指数退避但不超过 30 秒。 */
export const MAX_RETRY_MS = 30000;
/** 单次快照拉取的超时：与 useModelCatalog 的 20s 口径同量级（d5-20）。 */
export const SNAPSHOT_TIMEOUT_MS = 20000;

/** 团队是否仍可能产出新快照；completed / ended 后停止轮询（沿用改造前行为）。 */
export function isLiveTeamStatus(status: string | undefined): boolean {
  return status === "forming" || status === "running" || status === "finishing";
}

/**
 * 追加一条快照。**按 contentHash 去重**（引用不变，React 不重渲染）；
 * 超出上限时保留最新的一段。
 *
 * 为什么不再比 `version + generatedAt`：`version` 是硬编码的 schema 常量 1（永不变化），
 * `generatedAt` 每次快照都是新时间戳（`agent-teams-swimlane-store.ts` 的
 * `new Date().toISOString()`）——两者都不可能相等，旧口径的去重分支在生产环境
 * **永不成立**，每轮轮询都追加一帧，60 帧回放变成 60 张同一帧。
 * `contentHash` 是服务端算的「除 generatedAt 外全量内容」指纹，才是真的变更信号。
 *
 * 缺 contentHash 的快照（旧固件 / 测试夹具）回退到旧口径，保证向后兼容。
 */
export function appendTeamSnapshot(
  snapshots: TeamWorkbenchSnapshot[],
  snapshot: TeamWorkbenchSnapshot,
): TeamWorkbenchSnapshot[] {
  const last = snapshots[snapshots.length - 1];
  if (last) {
    let same: boolean;
    if (last.contentHash && snapshot.contentHash) {
      // 生产路径：以内容指纹为准。
      same = last.contentHash === snapshot.contentHash;
    } else if (!last.contentHash && !snapshot.contentHash) {
      // 两侧都缺（旧固件 / 测试夹具）：回退旧口径，保持向后兼容。
      same = last.version === snapshot.version && last.generatedAt === snapshot.generatedAt;
    } else {
      // 只有一侧带指纹：无法证明内容相同 ⇒ 按变化处理。
      // 宁可多一帧（视觉上多一格），不可漏一次更新（漏了就是「改了不刷新」）。
      same = false;
    }
    if (same) return snapshots;
  }
  const next = [...snapshots, snapshot];
  return next.length > WORKBENCH_HISTORY_LIMIT ? next.slice(-WORKBENCH_HISTORY_LIMIT) : next;
}

/**
 * 帧身份：version + generatedAt 的组合，与 appendTeamSnapshot 的去重口径一致。
 *
 * 回放钉住的是这个身份而不是数组下标——history 满 WORKBENCH_HISTORY_LIMIT 后每追加
 * 一帧就丢弃最旧一帧，数组下标会整体左移；钉住下标会导致回放视图每 3 秒静默前移
 * 一格，末格时跳回最新。钉住身份则不受丢帧影响。
 */
export function frameKey(snapshot: TeamWorkbenchSnapshot): string {
  return `${snapshot.version}:${snapshot.generatedAt}`;
}

/** 在当前快照里定位被钉住的帧；跟随最新（null）或找不到都返回 -1。 */
function findPinnedIndex(snapshots: TeamWorkbenchSnapshot[], pinnedFrame: string | null): number {
  if (pinnedFrame === null) return -1;
  return snapshots.findIndex((snapshot) => frameKey(snapshot) === pinnedFrame);
}

/** 把任意 index 夹到 [0, latestIndex]；没有快照时为 -1。 */
export function clampTimelineIndex(index: number, latestIndex: number): number {
  if (latestIndex < 0) return -1;
  const rounded = Number.isFinite(index) ? Math.round(index) : latestIndex;
  return Math.max(0, Math.min(latestIndex, rounded));
}

/** 回放视图的下标：跟随最新时是末格；钉帧还在则定位到它；被淘汰则夹到最旧帧。 */
export function resolvePinnedIndex(
  snapshots: TeamWorkbenchSnapshot[],
  pinnedFrame: string | null,
): number {
  const latestIndex = snapshots.length - 1;
  if (latestIndex < 0) return -1;
  if (pinnedFrame === null) return latestIndex;
  const found = findPinnedIndex(snapshots, pinnedFrame);
  return found >= 0 ? found : 0;
}

/** 被钉住的帧是否已被淘汰（滚出窗口），供 UI 提示。 */
export function isPinnedFrameExpired(
  snapshots: TeamWorkbenchSnapshot[],
  pinnedFrame: string | null,
): boolean {
  if (pinnedFrame === null || snapshots.length === 0) return false;
  return findPinnedIndex(snapshots, pinnedFrame) < 0;
}

/** 是否实时：跟随最新，或钉住的那一帧恰好就是末格。 */
export function isLivePinnedFrame(
  snapshots: TeamWorkbenchSnapshot[],
  pinnedFrame: string | null,
): boolean {
  const latestIndex = snapshots.length - 1;
  if (latestIndex < 0) return false;
  if (pinnedFrame === null) return true;
  return findPinnedIndex(snapshots, pinnedFrame) === latestIndex;
}

// ─────────────────────────────────────────────────────────────────────────────
// 轮询器（抽离出 React，便于单测可见性 / 重试行为）
// ─────────────────────────────────────────────────────────────────────────────

/** 定时器接口（可注入以便单测）。 */
export interface PollTimers {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const defaultTimers: PollTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SnapshotPoller {
  /** 立刻拉取一次并开始轮询；重复调用只会重排第一次拉取。 */
  start: () => void;
  /** 停止轮询、清除待执行定时器并注销 visibilitychange。 */
  stop: () => void;
}

export interface SnapshotPollerOptions {
  /** 拉取一次快照；抛错表示失败。 */
  fetchSnapshot: () => Promise<TeamWorkbenchSnapshot>;
  /** 成功拉到快照。 */
  onSnapshot: (snapshot: TeamWorkbenchSnapshot) => void;
  /** 拉取失败（HTTP 错误、网络错误或解析失败）。 */
  onError: () => void;
  /** 该快照对应的团队是否仍可能产出新数据，决定是否继续轮询。 */
  isLive: (snapshot: TeamWorkbenchSnapshot) => boolean;
  /** 页面是否可见；隐藏时跳过到期的拉取，等重新可见时补拉。默认恒为可见。 */
  isVisible?: () => boolean;
  /** 触发「重新可见」补拉的事件源（通常是 document）。 */
  visibilitySource?: Pick<Document, "addEventListener" | "removeEventListener"> | null;
  /** 注入定时器（单测用）。 */
  timers?: PollTimers;
  /** 正常轮询节奏。 */
  intervalMs?: number;
  /** 失败重试的退避上限。 */
  maxRetryMs?: number;
}

/**
 * 快照轮询器：把「拉取 → 成功继续 / 失败退避重试 / 页面隐藏暂停 / 重新可见补拉」
 * 收在一处。
 * - 页面隐藏时到期那一拍被跳过（不自行重排），改由 visibilitychange 在回到前台时
 *   立即补一次拉取并重排定时器——修掉「切回前台后 Live 永久冻住」。
 * - 失败同样重排定时器（指数退避、上限 maxRetryMs），让界面「正在重试…」成真。
 */
export function createSnapshotPoller(options: SnapshotPollerOptions): SnapshotPoller {
  const intervalMs = options.intervalMs ?? LIVE_REFRESH_MS;
  const maxRetryMs = options.maxRetryMs ?? MAX_RETRY_MS;
  const timers = options.timers ?? defaultTimers;
  const isVisible = options.isVisible ?? (() => true);
  const source = options.visibilitySource ?? null;

  let stopped = false;
  let timer: unknown;
  let inFlight = false;
  let attempt = 0;

  const clear = (): void => {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = (delay: number): void => {
    if (stopped) return;
    clear();
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (stopped || !isVisible()) return;
      void load();
    }, delay);
  };

  async function load(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    // 挂起的请求本身也要有出口：远程/隧道访问下连接可能半开，fetch 永不 settle
    // 时 inFlight 恒真，失败重试与前台补拉全被短路，轮询永久停摆。20s 与
    // useModelCatalog 的超时口径同量级；超时按失败走既有的退避重试路径。
    // 判死用真实 setTimeout，不经注入的 timers——那是轮询节奏的队列，单测靠
    // 「恰一个轮询定时器」的断言驱动，混入判死帧会污染它。
    //
    // state.md P1：判死句柄必须保存并在 finally 里清掉。此前成功路径从不
    // clearTimeout，工作台打开期间每个 3 秒拉取都遗留一个 20s 后仍会触发的
    // 僵尸定时器（约 7 个常驻）；`stop()` 后它们仍在跑，单测进程也会被占住。
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        options.fetchSnapshot(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            if (!settled) reject(new Error("snapshot fetch timed out"));
          }, SNAPSHOT_TIMEOUT_MS);
        }),
      ]);
      settled = true;
      if (stopped) return;
      options.onSnapshot(snapshot);
      attempt = 0;
      if (options.isLive(snapshot)) schedule(intervalMs);
    } catch {
      settled = true;
      if (stopped) return;
      options.onError();
      attempt += 1;
      schedule(Math.min(maxRetryMs, intervalMs * 2 ** (attempt - 1)));
    } finally {
      // 无论成功/失败/超时都收回判死定时器：race 一旦落地它就没有意义，
      // 留着只会在 20s 后白触发一次（stop() 之后也照样触发）。
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
      inFlight = false;
    }
  }

  const onVisibilityChange = (): void => {
    if (stopped || !isVisible()) return;
    // 无论是否挂起都重排定时器：挂起中只触发补拉（inFlight 短路），下一次
    // 轮询仍由这个定时器保证——否则半开连接把 Live 永久冻在补拉那次。
    schedule(intervalMs);
    void load();
  };

  return {
    start: () => {
      stopped = false;
      source?.addEventListener("visibilitychange", onVisibilityChange);
      void load();
    },
    stop: () => {
      stopped = true;
      clear();
      source?.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}

export interface TeamTimelineController {
  /** 当前团队的历史快照，按时间升序（末条最新）。 */
  snapshots: TeamWorkbenchSnapshot[];
  /** selectedIndex 指向的快照；没有数据时为 null。 */
  currentSnapshot: TeamWorkbenchSnapshot | null;
  /** 派生值（等于 selectedIndex）：null=实时跟随；数字=回放停留位置。 */
  historyIndex: number | null;
  /** currentSnapshot 在 snapshots 里的下标；空列表为 -1。 */
  selectedIndex: number;
  latestIndex: number;
  /** 正在看最新一格（跟随最新，或钉住的帧就是末格）。 */
  isLive: boolean;
  /** 是否处于回放模式（钉住了某一帧；exitReplay 才回到跟随）。 */
  isReplaying: boolean;
  /** 钉住的帧已被淘汰、视图被夹到最旧帧，供 UI 提示。 */
  frameExpired: boolean;
  playing: boolean;
  /** 播放倍速（0.5 / 1 / 2 / 4），只影响自动播放的帧间隔，不影响手动 seek/step。 */
  speed: ReplaySpeed;
  setSpeed: (speed: ReplaySpeed) => void;
  loading: boolean;
  failed: boolean;
  enterReplay: () => void;
  exitReplay: () => void;
  seek: (index: number) => void;
  stepBack: () => void;
  stepForward: () => void;
  togglePlayback: () => void;
}

/**
 * 团队工作台的快照时间线：内部维持原有 3 秒轮询并累积历史快照，
 * 对外提供「实时跟随 ⇄ 回放」两种查看方式。
 *
 * - 轮询交给 createSnapshotPoller：只在团队 forming/running/finishing 时继续；
 *   页面隐藏时跳过到期的拉取、切回前台立即补拉；失败退避重试（上限 30 秒）。
 * - 新快照按 contentHash 去重，最多保留 WORKBENCH_HISTORY_LIMIT 条。
 * - 回放钉住的是「帧身份 frameKey」而不是数组下标：历史满 60 帧丢弃最旧帧、
 *   下标整体左移时，被钉住的帧不会漂移；该帧被淘汰则夹到最旧帧并置 frameExpired。
 */
export function useTeamTimeline(teamName: string | null, reloadKey = 0): TeamTimelineController {
  const [snapshots, setSnapshots] = useState<TeamWorkbenchSnapshot[]>([]);
  const [pinnedFrame, setPinnedFrame] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<ReplaySpeed>(1);
  const [loading, setLoading] = useState(Boolean(teamName));
  const [failed, setFailed] = useState(false);
  // 最近一帧（不触发渲染的引用）：用于 ?since= 条件请求与 304 回退。
  const lastSnapshotRef = useRef<TeamWorkbenchSnapshot | null>(null);

  // 换团队时清空时间线；轮询、可见性与重试都收在 createSnapshotPoller 里。
  useEffect(() => {
    setSnapshots([]);
    setPinnedFrame(null);
    setPlaying(false);
    setFailed(false);
    lastSnapshotRef.current = null;
    if (!teamName) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const poller = createSnapshotPoller({
      fetchSnapshot: async () => {
        // 带 ?since=<contentHash>：内容未变时服务端回 304，省掉整棵快照的 JSON 序列化
        // 与客户端解析。304 不是 response.ok（不在 200-299），必须单独判——直接拿上一帧
        // 顶上，appendTeamSnapshot 会按 contentHash 去重成 no-op。
        const since = lastSnapshotRef.current?.contentHash;
        const query = since ? `?since=${encodeURIComponent(since)}` : "";
        // signal 与判死同源：超时不仅让 race 落地，还要真正 abort 底层请求，
        // 否则半开连接下挂起请求只增不减（state.md P1）。
        const response = await fetch(`/api/teams/${encodeURIComponent(teamName)}/workbench${query}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
        });
        if (response.status === 304) {
          // 首帧不可能 304（那时还没发 since）；若真发生则当错误，交给退避重试。
          if (!lastSnapshotRef.current) throw new Error("HTTP 304 without a prior snapshot");
          return lastSnapshotRef.current;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = await response.json() as TeamWorkbenchSnapshot;
        lastSnapshotRef.current = snapshot;
        return snapshot;
      },
      onSnapshot: (data) => {
        setSnapshots((current) => appendTeamSnapshot(current, data));
        setFailed(false);
        setLoading(false);
      },
      onError: () => {
        setFailed(true);
        setLoading(false);
      },
      isLive: (data) => isLiveTeamStatus(data.team.status),
      isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
      visibilitySource: typeof document === "undefined" ? null : document,
    });
    poller.start();
    return () => poller.stop();
    // reloadKey：名册失败告警旁的「重试」除了重拉名册，也要立刻重建时间线轮询——
    // 否则失败告警消失了，快照区仍停在 failed 直到退避到期。
  }, [teamName, reloadKey]);

  const latestIndex = snapshots.length - 1;
  const selectedIndex = resolvePinnedIndex(snapshots, pinnedFrame);
  const currentSnapshot = selectedIndex >= 0 ? snapshots[selectedIndex] : null;
  const isLive = isLivePinnedFrame(snapshots, pinnedFrame);
  const isReplaying = pinnedFrame !== null;
  const frameExpired = isPinnedFrameExpired(snapshots, pinnedFrame);
  const historyIndex = pinnedFrame === null ? null : selectedIndex;

  const pinIndex = useCallback((index: number) => {
    if (latestIndex < 0) {
      setPinnedFrame(null);
      return;
    }
    const target = snapshots[clampTimelineIndex(index, latestIndex)];
    setPinnedFrame(target ? frameKey(target) : null);
  }, [latestIndex, snapshots]);

  const seek = useCallback((index: number) => {
    setPlaying(false);
    pinIndex(index);
  }, [pinIndex]);

  const enterReplay = useCallback(() => {
    setPlaying(false);
    // 钉住当前最新一帧：此后的新快照不再自动接管视图。
    pinIndex(latestIndex);
  }, [latestIndex, pinIndex]);

  const exitReplay = useCallback(() => {
    setPlaying(false);
    setPinnedFrame(null);
  }, []);

  const stepBy = useCallback((delta: number) => {
    if (latestIndex < 0) return;
    setPlaying(false);
    pinIndex(selectedIndex + delta);
  }, [latestIndex, pinIndex, selectedIndex]);

  const stepBack = useCallback(() => stepBy(-1), [stepBy]);
  const stepForward = useCallback(() => stepBy(1), [stepBy]);

  const togglePlayback = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (latestIndex <= 0) return;
    // 停在末格时再按播放：从最早一帧重新回放（cc-haha 同款行为）。
    if (selectedIndex >= latestIndex) setPinnedFrame(frameKey(snapshots[0]));
    setPlaying(true);
  }, [latestIndex, playing, selectedIndex, snapshots]);

  const setSpeed = useCallback((next: ReplaySpeed) => {
    setSpeedState(clampReplaySpeed(next));
  }, []);

  // 播放步进：每 replayStepMs(speed) 前进一格，到最新一格自动停；改倍速会重排定时器。
  useEffect(() => {
    if (!playing) return;
    if (latestIndex <= 0 || selectedIndex >= latestIndex) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      const next = snapshots[selectedIndex + 1];
      if (next) setPinnedFrame(frameKey(next));
    }, replayStepMs(speed));
    return () => clearTimeout(timer);
  }, [latestIndex, playing, selectedIndex, snapshots, speed]);

  return {
    snapshots,
    currentSnapshot,
    historyIndex,
    selectedIndex,
    latestIndex,
    isLive,
    isReplaying,
    frameExpired,
    playing,
    speed,
    setSpeed,
    loading,
    failed,
    enterReplay,
    exitReplay,
    seek,
    stepBack,
    stepForward,
    togglePlayback,
  };
}
