"use client";

import { useCallback, useEffect, useState } from "react";
import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";

/** 历史快照上限：3 秒一轮询时约等于最近 3 分钟的团队动态。 */
export const WORKBENCH_HISTORY_LIMIT = 60;
/** live 跟随的轮询节奏（沿用改造前的 3 秒）。 */
export const LIVE_REFRESH_MS = 3000;
/** 回放播放：每 1.2 秒前进一格。 */
export const REPLAY_STEP_MS = 1200;

/** 团队是否仍可能产出新快照；completed / ended 后停止轮询（沿用改造前行为）。 */
export function isLiveTeamStatus(status: string | undefined): boolean {
  return status === "forming" || status === "running" || status === "finishing";
}

/**
 * 追加一条快照。version 与 generatedAt 都与当前末条相同时视为同一份数据，
 * 直接返回原数组（引用不变，React 不重渲染）；超出上限时保留最新的一段。
 */
export function appendTeamSnapshot(
  snapshots: TeamWorkbenchSnapshot[],
  snapshot: TeamWorkbenchSnapshot,
): TeamWorkbenchSnapshot[] {
  const last = snapshots[snapshots.length - 1];
  if (last?.version === snapshot.version && last.generatedAt === snapshot.generatedAt) {
    return snapshots;
  }
  const next = [...snapshots, snapshot];
  return next.length > WORKBENCH_HISTORY_LIMIT ? next.slice(-WORKBENCH_HISTORY_LIMIT) : next;
}

/** 把任意 index 夹到 [0, latestIndex]；没有快照时为 -1。 */
export function clampTimelineIndex(index: number, latestIndex: number): number {
  if (latestIndex < 0) return -1;
  const rounded = Number.isFinite(index) ? Math.round(index) : latestIndex;
  return Math.max(0, Math.min(latestIndex, rounded));
}

/** historyIndex=null 表示跟随最新；显式 index 按当前长度夹取。 */
export function resolveTimelineIndex(historyIndex: number | null, latestIndex: number): number {
  if (latestIndex < 0) return -1;
  return historyIndex === null ? latestIndex : clampTimelineIndex(historyIndex, latestIndex);
}

/** 位置是否「实时」：跟随最新，或显式停在最新一格。 */
export function isLiveTimelineIndex(historyIndex: number | null, latestIndex: number): boolean {
  return latestIndex >= 0 && (historyIndex === null || clampTimelineIndex(historyIndex, latestIndex) === latestIndex);
}

/** 步进一格并夹取；delta=±1。 */
export function stepTimelineIndex(from: number, delta: number, latestIndex: number): number {
  return clampTimelineIndex(from + delta, latestIndex);
}

export interface TeamTimelineController {
  /** 当前团队的历史快照，按时间升序（末条最新）。 */
  snapshots: TeamWorkbenchSnapshot[];
  /** historyIndex 指向的快照；没有数据时为 null。 */
  currentSnapshot: TeamWorkbenchSnapshot | null;
  /** null=实时跟随；数字=回放停留的位置。 */
  historyIndex: number | null;
  /** currentSnapshot 在 snapshots 里的下标；空列表为 -1。 */
  selectedIndex: number;
  latestIndex: number;
  /** 正在看最新一格（historyIndex 为 null 或夹取后等于 latestIndex）。 */
  isLive: boolean;
  /** 是否处于回放模式（任何显式 index 都算；exitReplay 才回到跟随）。 */
  isReplaying: boolean;
  playing: boolean;
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
 * - 轮询只在团队处于 forming/running/finishing 时继续，页面隐藏时跳过
 *   这一次拉取；团队 ended/completed 后不再轮询。
 * - 新快照按 version + generatedAt 去重，最多保留 WORKBENCH_HISTORY_LIMIT 条。
 * - 回放不会停止轮询：历史继续增长，但 historyIndex 钉住时视图不前进。
 */
export function useTeamTimeline(teamName: string | null): TeamTimelineController {
  const [snapshots, setSnapshots] = useState<TeamWorkbenchSnapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(Boolean(teamName));
  const [failed, setFailed] = useState(false);

  // 换团队时清空时间线；轮询节奏与守卫与原 AgentTeamsView 一致。
  useEffect(() => {
    setSnapshots([]);
    setHistoryIndex(null);
    setPlaying(false);
    setFailed(false);
    if (!teamName) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/teams/${encodeURIComponent(teamName)}/workbench`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as TeamWorkbenchSnapshot;
        if (cancelled) return;
        setSnapshots((current) => appendTeamSnapshot(current, data));
        setFailed(false);
        if (isLiveTeamStatus(data.team.status)) {
          timer = setTimeout(() => {
            if (document.visibilityState === "visible") void load();
          }, LIVE_REFRESH_MS);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [teamName]);

  const latestIndex = snapshots.length - 1;
  const selectedIndex = resolveTimelineIndex(historyIndex, latestIndex);
  const currentSnapshot = selectedIndex >= 0 ? snapshots[selectedIndex] : null;
  const isLive = isLiveTimelineIndex(historyIndex, latestIndex);
  const isReplaying = historyIndex !== null;

  const seek = useCallback((index: number) => {
    setPlaying(false);
    setHistoryIndex(latestIndex < 0 ? null : clampTimelineIndex(index, latestIndex));
  }, [latestIndex]);

  const enterReplay = useCallback(() => {
    setPlaying(false);
    // 钉在当前最新一格：此后的新快照不再自动接管视图。
    setHistoryIndex(latestIndex < 0 ? null : latestIndex);
  }, [latestIndex]);

  const exitReplay = useCallback(() => {
    setPlaying(false);
    setHistoryIndex(null);
  }, []);

  const stepBack = useCallback(() => {
    if (latestIndex < 0) return;
    setPlaying(false);
    setHistoryIndex((current) => stepTimelineIndex(resolveTimelineIndex(current, latestIndex), -1, latestIndex));
  }, [latestIndex]);

  const stepForward = useCallback(() => {
    if (latestIndex < 0) return;
    setPlaying(false);
    setHistoryIndex((current) => stepTimelineIndex(resolveTimelineIndex(current, latestIndex), 1, latestIndex));
  }, [latestIndex]);

  const togglePlayback = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (latestIndex <= 0) return;
    // 停在末格时再按播放：从最早一帧重新回放（cc-haha 同款行为）。
    if (selectedIndex >= latestIndex) setHistoryIndex(0);
    setPlaying(true);
  }, [latestIndex, playing, selectedIndex]);

  // 播放步进：每 REPLAY_STEP_MS 前进一格，到最新一格自动停。
  useEffect(() => {
    if (!playing) return;
    if (latestIndex <= 0 || selectedIndex >= latestIndex) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      setHistoryIndex(selectedIndex + 1);
    }, REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [latestIndex, playing, selectedIndex]);

  return {
    snapshots,
    currentSnapshot,
    historyIndex,
    selectedIndex,
    latestIndex,
    isLive,
    isReplaying,
    playing,
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