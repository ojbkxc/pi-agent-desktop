"use client";

import { useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getTicketUrgency, type TicketUrgency } from "@/lib/agent-teams-task-layout";
import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";

/** 票态（紧急度）→ 复用既有词条键（与成员检查器同一口径）。 */
function ticketStateLabelKey(urgency: TicketUrgency): string {
  if (urgency === "completed") return "teams.status.completed";
  if (urgency === "running") return "teams.status.running";
  if (urgency === "failed") return "teams.status.failed";
  if (urgency === "blocked") return "teams.stats.blocked";
  return "teams.stats.available";
}

export interface AgentTeamTaskDetailProps {
  snapshot: TeamWorkbenchSnapshot;
  /** 被选中的票 id；票已从快照消失时本组件返回 null。 */
  ticketId: string;
  /** 关闭抽屉。 */
  onClose: () => void;
  /** 点负责人 → 打开该成员检查器（可选）。 */
  onSelectMember?: (memberId: string) => void;
  /** 右列是否展开（决定抽屉的右偏移，避免压住右列）。 */
  dockOpen?: boolean;
}

/**
 * 任务详情抽屉（C8）：点任务卡 → 右下角浮层显示负责人 / 依赖（本票依赖谁）/ 解锁（谁依赖本票）。
 * 纯展示，数据全部来自当前快照；关闭由上层把 selectedTicketId 置空。
 */
export function AgentTeamTaskDetail({
  snapshot,
  ticketId,
  onClose,
  onSelectMember,
  dockOpen = false,
}: AgentTeamTaskDetailProps) {
  const { t } = useI18n();

  const ticket = useMemo(
    () => snapshot.tickets.find((candidate) => candidate.id === ticketId) ?? null,
    [snapshot.tickets, ticketId],
  );
  const ticketsById = useMemo(() => new Map(snapshot.tickets.map((item) => [item.id, item])), [snapshot.tickets]);
  const owner = useMemo(
    () => (ticket?.ownerId ? snapshot.members.find((member) => member.id === ticket.ownerId) ?? null : null),
    // 依赖整个 `ticket`：React Compiler 的推断就是它；写 `ticket?.ownerId` 会被判定
    // manual memoization 无法保留（eslint react-hooks/preserve-manual-memoization）。
    [snapshot.members, ticket],
  );
  // 解锁：依赖本票的其它票（谁的 dependencies 含本票 id）。
  const unblocks = useMemo(
    () => snapshot.tickets.filter((candidate) => candidate.dependencies.includes(ticketId)).map((candidate) => candidate.id),
    [snapshot.tickets, ticketId],
  );

  if (!ticket) return null;

  const urgency = getTicketUrgency(ticket, ticketsById);
  const deps = ticket.dependencies;

  const chip = (label: string, ids: string[]) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span className="agent-teams-member-role">{label}:</span>
      <span style={{ fontFamily: "var(--font-mono)" }}>{ids.length > 0 ? ids.map((id) => `#${id}`).join(", ") : "—"}</span>
    </span>
  );

  return (
    <aside
      className="agent-teams-task-detail"
      data-testid="agent-teams-task-detail"
      data-task-id={ticket.id}
      aria-label={t("teams.task.heading")}
      style={{
        position: "absolute",
        right: dockOpen ? 396 : 68,
        bottom: 16,
        width: 360,
        zIndex: "var(--z-drawer, 40)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-lg)",
        background: "var(--bg-panel)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
        padding: 14,
      }}
      role="dialog"
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>
            #{ticket.id} · {t(ticketStateLabelKey(urgency))}
          </div>
          <h3 style={{ margin: "4px 0 0", fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", lineHeight: 1.35 }}>
            {ticket.subject}
          </h3>
        </div>
        <button
          type="button"
          className="agent-teams-timeline-button"
          onClick={onClose}
          aria-label={t("teams.task.close")}
          style={{ flex: "none" }}
        >
          ✕
        </button>
      </div>

      {ticket.description && (
        <p
          style={{
            margin: "10px 0 0",
            whiteSpace: "pre-wrap",
            fontSize: "var(--fs-small)",
            color: "var(--text-muted)",
            overflowWrap: "anywhere",
          }}
        >
          {ticket.description}
        </p>
      )}

      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: "var(--hairline) solid var(--border)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: "var(--fs-small)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span className="agent-teams-member-role">{t("teams.task.owner")}:</span>
          {owner ? (
            <button
              type="button"
              onClick={() => owner && onSelectMember?.(owner.id)}
              disabled={!onSelectMember}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                color: "var(--accent)",
                cursor: onSelectMember ? "pointer" : "default",
                font: "inherit",
              }}
            >
              {owner.name}
            </button>
          ) : (
            <span>{t("teams.unassigned")}</span>
          )}
        </span>
        {chip(t("teams.task.dependsOn"), deps)}
        {chip(t("teams.task.unblocks"), unblocks)}
      </div>
    </aside>
  );
}
