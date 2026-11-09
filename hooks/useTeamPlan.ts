"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamPlanView } from "@/lib/agent-teams-plan";

/**
 * B3 计划卡的数据源：按团队名拉 `/api/teams/[team]/plan` 并每 2 秒轮询（对齐 cc-haha
 * AgentTeamsPlanCard 的 2s 刷新）。页面不可见时暂停，切回前台立即补一次。
 *
 * approve 也在这里：POST `/api/teams/[team]/plan/approve`（只投递 prompt 给 lead，不写盘）。
 * 成功后就地 refresh，等 lead 把计划推进到 launching 后卡片自然消失。
 *
 * 不 import 任何含 node:fs 的模块：只依赖纯类型。
 */

/** 计划卡轮询节奏（与 cc-haha 一致：2s）。 */
export const TEAM_PLAN_POLL_MS = 2000;

export interface UseTeamPlanResult {
  plan: TeamPlanView | null;
  /** 拉取失败信息（网络/500）；成功或「无计划」时为 null。 */
  error: string | null;
  /** approve 请求进行中。 */
  busy: boolean;
  /** 主动补拉一次。 */
  refresh(): void;
  /** 批准当前计划（投递给 lead）。返回是否投递成功。 */
  approve(): Promise<{ ok: boolean; reason?: string }>;
}

export function useTeamPlan(teamName: string | null, refreshKey: number = 0): UseTeamPlanResult {
  const [plan, setPlan] = useState<TeamPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 轮询外触发的一次性补拉计数。
  const [tick, setTick] = useState(0);
  // 最新 plan 的 ref：approve 时读它取 identity，避免闭包拿到旧值。
  const planRef = useRef<TeamPlanView | null>(null);
  planRef.current = plan;

  useEffect(() => {
    // 换团队：先清掉上一条，避免把 A 团队的计划串到 B。
    setPlan(null);
    setError(null);
    if (!teamName) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `/api/teams/${encodeURIComponent(teamName)}/plan`;
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
          setError(`计划读取失败（HTTP ${response.status}）`);
          schedule(TEAM_PLAN_POLL_MS);
          return;
        }
        const data = (await response.json()) as { plan: TeamPlanView | null };
        if (stopped) return;
        setPlan(data.plan);
        setError(null);
        schedule(TEAM_PLAN_POLL_MS);
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : String(err));
        schedule(TEAM_PLAN_POLL_MS);
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
  }, [teamName, refreshKey, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  const approve = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    const current = planRef.current;
    if (!current) return { ok: false, reason: "no plan" };
    setBusy(true);
    try {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(teamName ?? current.teamName)}/plan/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            planId: current.planId,
            sessionId: current.sessionId,
            incarnationId: current.incarnationId,
            expectedRevision: current.revision,
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      // 投递成功后再拉一次，让后续状态变化尽快反映到界面。
      setTick((value) => value + 1);
      if (!response.ok || !data.ok) {
        return { ok: false, reason: data.reason ?? `批准失败（HTTP ${response.status}）` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      setBusy(false);
    }
  }, [teamName]);

  return { plan, error, busy, refresh, approve };
}
