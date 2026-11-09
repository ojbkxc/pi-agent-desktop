"use client";

import { useEffect, useMemo, useState } from "react";
import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";
import { getTicketUrgency } from "@/lib/agent-teams-task-layout";

/**
 * 会话头部团队条的数据源（B1，对齐 cc-haha 的 header 常驻 Agent Teams 条）。
 *
 * 输入当前会话 id，反查 `/api/teams/session/[id]/workbench`（团队名册 + 泳道快照），
 * 输出条所需的三样东西：`snapshot`（原始快照）、`phase`（显示态）、`progress`（完成/总数）。
 *
 * 轮询口径（与 useTeamTimeline 的实时跟随一致，但这里独立实现以便精确控制「无团队」的收尾）：
 * - 3 秒一轮，**仅当团队处于 forming / running / finishing**（活跃期）时继续；一旦
 *   completed / ended，停止轮询但**保留最后一次快照**（条不立刻消失，留到下次发消息时刷新）。
 * - 页面不可见（document.visibilityState !== "visible"）时暂停拉取，切回前台立即补一次。
 * - 该会话没有团队（404）时停止轮询、快照置空（条不占位）；由 refreshKey（会话消息数）
 *   或重新可见触发下一次拉取，团队随后被创建时也能及时出现。
 *
 * 不 import 任何含 node:fs 的模块：只依赖纯投影类型与纯布局引擎。
 */

/** 活跃期轮询节奏。 */
export const TEAM_STRIP_POLL_MS = 3000;
/** 网络类失败的重试节奏（非活跃期与 404 不重试）。 */
export const TEAM_STRIP_RETRY_MS = 5000;

/**
 * 团队条的显示态：在团队阶段（team.status）之上叠加**成员级异常**。
 * - failed：有成员 status === "failed"（红）；
 * - interrupted：有成员被中止（aborted）但未整体失败（黄）；
 * - none：无快照，或**未进成员就取消**的团队（名册为空）——此时条不渲染。
 * 其余直接沿用 team.status（forming/running/finishing/completed/ended）。
 */
export type TeamStripPhase =
  | "forming"
  | "running"
  | "finishing"
  | "completed"
  | "ended"
  | "interrupted"
  | "failed"
  | "none";

/** 进度：completed 与总数（口径见 deriveTeamStripProgress）。 */
export interface TeamStripProgress {
  completed: number;
  total: number;
}

export interface ActiveTeamStrip {
  /** 原始泳道快照；无团队/未拉到时为 null。 */
  snapshot: TeamWorkbenchSnapshot | null;
  /** 显示态（见 TeamStripPhase）。 */
  phase: TeamStripPhase;
  /** 完成/总数。 */
  progress: TeamStripProgress;
}

/**
 * 显示态派生（纯函数）：
 * - 无快照 → none；
 * - 名册为空（未进成员就取消的团队）→ none（条不渲染，不占位）；
 * - 存在失败派活（票紧急度 failed，同任务画布/统计头口径）→ failed（失败变红）；
 * - 成员被中止（lifecycle aborted）→ interrupted（黄）；
 * - 否则沿用团队阶段。
 *
 * 注：投影层 member.status 只会是 running/idle/parked/aborted/completed/queued，
 * **不会**是 "failed"（toMemberStatus 从不产出该值）——所以「失败」信号取自票的
 * 派活结果（getTicketUrgency === "failed"），而不是成员态。
 */
export function deriveTeamStripPhase(snapshot: TeamWorkbenchSnapshot | null): TeamStripPhase {
  if (!snapshot) return "none";
  if (snapshot.members.length === 0) return "none";
  const byId = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket]));
  if (snapshot.tickets.some((ticket) => getTicketUrgency(ticket, byId) === "failed")) return "failed";
  if (snapshot.members.some((member) => member.status === "aborted")) return "interrupted";
  return snapshot.team.status;
}

/**
 * 进度派生（纯函数）：完成数取**唯一紧急度真源** getTicketUrgency 的 completed，
 * 与工作台统计头 / 任务画布同源——不自数 `status === "ended"`（失败票同样 ended，
 * 会被错误计成完成）。
 */
export function deriveTeamStripProgress(snapshot: TeamWorkbenchSnapshot | null): TeamStripProgress {
  if (!snapshot) return { completed: 0, total: 0 };
  const byId = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket]));
  let completed = 0;
  for (const ticket of snapshot.tickets) {
    if (getTicketUrgency(ticket, byId) === "completed") completed += 1;
  }
  return { completed, total: snapshot.tickets.length };
}

/** 团队是否仍可能产出新快照（活跃期）；completed / ended 后停止轮询。 */
export function isActiveTeamPhase(status: string | undefined): boolean {
  return status === "forming" || status === "running" || status === "finishing";
}

/**
 * 会话头部团队条：按 sessionId 拉取并轮询团队泳道快照。
 *
 * @param sessionId  当前会话 id（null = 不拉取）。
 * @param refreshKey 刷新键：会话消息数变化（发消息）时重拉一次，使新团队及时出现、
 *                   已完成的旧团队被替换；缺省 0。
 */
export function useActiveTeamStrip(sessionId: string | null, refreshKey: number = 0): ActiveTeamStrip {
  const [snapshot, setSnapshot] = useState<TeamWorkbenchSnapshot | null>(null);

  useEffect(() => {
    // 换会话 / 收到新消息：先清掉上一条团队，避免把 A 会话的条串到 B。
    setSnapshot(null);
    if (!sessionId) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `/api/teams/session/${encodeURIComponent(sessionId)}/workbench`;
    const doc = typeof document === "undefined" ? null : document;

    const clear = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const schedule = (delay: number): void => {
      if (stopped) return;
      clear();
      timer = setTimeout(() => { void load(); }, delay);
    };

    async function load(): Promise<void> {
      if (stopped) return;
      // 页面不可见：暂停（不拉取），等 visibilitychange 回到前台再补。
      if (doc && doc.visibilityState !== "visible") return;
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (stopped) return;
        if (!response.ok) {
          // 404 = 团队目录在但读不出快照（真异常）；按网络类失败重试。
          schedule(TEAM_STRIP_RETRY_MS);
          return;
        }
        const data = await response.json() as TeamWorkbenchSnapshot | { team?: null };
        if (stopped) return;
        // 200 且 team 为 null = 该会话不属于任何团队（常态）。停止轮询、快照置空
        // （条不占位），等 refreshKey / 重新可见再拉。
        if (!data.team) {
          setSnapshot(null);
          return;
        }
        const snapshot = data as TeamWorkbenchSnapshot;
        setSnapshot(snapshot);
        // 仅活跃期继续 3 秒轮询；completed / ended 停止，保留最后一次快照。
        if (isActiveTeamPhase(snapshot.team.status)) schedule(TEAM_STRIP_POLL_MS);
      } catch {
        if (!stopped) schedule(TEAM_STRIP_RETRY_MS);
      }
    }

    const onVisibilityChange = (): void => {
      if (doc && doc.visibilityState === "visible") schedule(0);
    };

    doc?.addEventListener("visibilitychange", onVisibilityChange);
    void load();
    return () => {
      stopped = true;
      clear();
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sessionId, refreshKey]);

  return useMemo(() => ({
    snapshot,
    phase: deriveTeamStripPhase(snapshot),
    progress: deriveTeamStripProgress(snapshot),
  }), [snapshot]);
}
