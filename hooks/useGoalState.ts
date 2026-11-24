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
 *   触发下一次拉取，使随后新建的目标及时出现；
 * - 快照清空**只发生在 `sessionId` 变化时**：`refreshKey` 只补拉、保留旧快照直到新响应
 *   落地，否则每发/收一条消息 `/goal` 条都会整体卸载再挂回（头部跳动）。
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
  /**
   * 暂停 / 恢复（写 `PATCH /api/goals/<session>`），成功后立刻用返回的目标覆盖快照。
   *
   * 为什么放这里而不是组件里自己 fetch：轮询循环已经在管理「谁持有当前目标」，让按钮
   * 自己写另一份状态会出现「按钮说已暂停、轮询又把它读回 active」的抖动。写成功后
   * 同一次调用里把快照换成服务端返回的值，接着按新 status 决定是否继续轮询。
   */
  setStatus(status: "active" | "paused"): Promise<{ ok: boolean; error?: string }>;
}

export function useGoalState(sessionId: string | null, refreshKey: number = 0): UseGoalStateResult {
  const [goal, setGoal] = useState<GoalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 轮询外触发的一次性补拉计数（refresh）。
  const [tick, setTick] = useState(0);

  // 换会话：清掉上一条目标的快照，避免把 A 会话的目标串到 B。
  // 只依赖 sessionId：refreshKey 是消息计数，若也在这里清空，/goal 条会每发/收一条
  // 消息就整体卸载再挂回（头部跳动）。refreshKey 只触发下面的补拉，旧快照保留到新响应落地。
  useEffect(() => {
    setGoal(null);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
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

  const setStatus = useCallback(async (status: "active" | "paused") => {
    if (!sessionId) return { ok: false as const, error: "no session" };
    try {
      const response = await fetch(`/api/goals/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = (await response.json().catch(() => ({}))) as { goal?: GoalState | null; error?: string };
      if (!response.ok) return { ok: false as const, error: data.error ?? `HTTP ${response.status}` };
      // Adopt the server's value, then re-arm the poll loop for the new status: resuming
      // must start following progress again, pausing must stop asking for it.
      if (data.goal !== undefined) setGoal(data.goal);
      setError(null);
      setTick((value) => value + 1);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [sessionId]);

  return { goal, error, refresh, setStatus };
}
