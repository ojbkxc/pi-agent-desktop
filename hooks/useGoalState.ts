"use client";

import { useCallback, useEffect, useState } from "react";
import type { GoalState } from "@/lib/goal/goal-types";

/**
 * `/goal` 目标进度条的数据源：按会话 id 拉 `GET /api/goals/<session>`，**只在
 * `status === "active"` 时每 2 秒轮询**（paused / completed / cleared 停止，保留最后一次
 * 快照，避免条在暂停瞬间闪没）。形状对齐 `hooks/useTeamPlan.ts`。
 *
 * - 页面不可见（`document.visibilityState !== "visible"`）时暂停，切回前台立即补拉；
 * - `sessionId` 为 null 时**零请求**；
 * - 该会话没有目标（`{ goal: null }`）时停止轮询、快照置空；由 `refreshKey`（会话消息数）
 *   触发下一次拉取，使随后新建的目标及时出现。
 *
 * 不 import 任何含 node:fs 的模块：只依赖纯类型。
 */

/** 轮询节奏（活跃期）。 */
export const GOAL_POLL_MS = 2000;

export interface UseGoalStateResult {
  /** 当前目标；无目标时为 null。 */
  goal: GoalState | null;
  /** 拉取失败信息（网络 / 500）；成功或「无目标」时为 null。 */
  error: string | null;
  /** 主动补拉一次。 */
  refresh(): void;
}

export function useGoalState(sessionId: string | null, refreshKey: number = 0): UseGoalStateResult {
  const [goal, setGoal] = useState<GoalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 轮询外触发的一次性补拉计数（refresh）。
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // 换会话：先清掉上一条目标，避免把 A 会话的目标串到 B。
    setGoal(null);
    setError(null);
    if (!sessionId) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `/api/goals/${encodeURIComponent(sessionId)}`;
    const doc = typeof document === "undefined" ? null : document;

    const schedule = (delay: number): void => {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, delay);
    };

    async function load(): Promise<void> {
      if (stopped) return;
      if (doc && doc.visibilityState !== "visible") return; // 不可见：暂停
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (stopped) return;
        if (!response.ok) {
          setError(`目标读取失败（HTTP ${response.status}）`);
          schedule(GOAL_POLL_MS);
          return;
        }
        const data = (await response.json()) as { goal: GoalState | null };
        if (stopped) return;
        setGoal(data.goal);
        setError(null);
        // 仅 active 继续 2s 轮询；paused / completed / cleared / 无目标都停止（保留快照）。
        if (data.goal?.status === "active") schedule(GOAL_POLL_MS);
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : String(err));
        schedule(GOAL_POLL_MS);
      }
    }

    const onVisibilityChange = (): void => {
      if (doc && doc.visibilityState === "visible") schedule(0);
    };

    doc?.addEventListener("visibilitychange", onVisibilityChange);
    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sessionId, refreshKey, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  return { goal, error, refresh };
}
