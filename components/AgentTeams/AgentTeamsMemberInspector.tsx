"use client";

import { useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getTicketUrgency, type TicketUrgency } from "@/lib/agent-teams-task-layout";
import type {
  TeamWorkbenchSnapshot,
  WorkbenchMember,
} from "@/lib/agent-teams-swimlane";

/**
 * 票态（紧急度）→ 复用既有词条键：completed/running/failed 用 status，
 * blocked/available 用统计头（teams.stats.*）。绝不新增可视键。
 */
function ticketStateLabelKey(urgency: TicketUrgency): string {
  if (urgency === "completed") return "teams.status.completed";
  if (urgency === "running") return "teams.status.running";
  if (urgency === "failed") return "teams.status.failed";
  if (urgency === "blocked") return "teams.stats.blocked";
  return "teams.stats.available";
}

/** 成员状态（MemberStatus）→ 复用既有 teams.status.* 词条键。 */
function memberStateLabelKey(status: WorkbenchMember["status"]): string {
  return `teams.status.${status}`;
}

/** ISO 时间 → 本地 HH:MM:SS；不可解析时回退空串（不渲染占位噪音）。 */
function formatClock(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  try {
    return new Date(time).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export interface AgentTeamsMemberInspectorProps {
  snapshot: TeamWorkbenchSnapshot;
  member: WorkbenchMember;
  /** 该成员是否队长（名册首位）——队长不显示「打开会话」的空态文案差异。 */
  isLead: boolean;
  /** 返回成员列表（关闭检查器，回到通信流/导轨）。 */
  onBack: () => void;
  /** 打开该成员的会话（无会话时按钮禁用）。 */
  onOpenSession?: (sessionId: string) => void;
}

/**
 * 成员检查器（C7）：点成员 → 右侧面板显示成员详情 + 执行历史（名下票）+ 消息 + 「打开其会话」。
 * 纯展示组件，数据全部来自当前快照，不发起任何请求；关闭由上层把 selectedMemberId 置空。
 */
export function AgentTeamsMemberInspector({
  snapshot,
  member,
  isLead,
  onBack,
  onOpenSession,
}: AgentTeamsMemberInspectorProps) {
  const { t, locale } = useI18n();

  // 角色本地化：无词条回退原文（与 AgentTeamsView 同款，绝不把 key 渲染到界面）。
  const roleLabel = useMemo(() => {
    const key = `teams.role.${member.role}`;
    const label = t(key);
    return label === key ? member.role : label;
  }, [member.role, t]);

  // 执行历史：名下所有票（按创建时间 + id 自然序稳定排序）。
  const ticketHistory = useMemo(() => {
    const byId = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket]));
    return snapshot.tickets
      .filter((ticket) => ticket.ownerId === member.id)
      .map((ticket) => ({ ticket, urgency: getTicketUrgency(ticket, byId) }))
      .sort((a, b) => {
        const atA = a.ticket.createdAt || "";
        const atB = b.ticket.createdAt || "";
        if (atA !== atB) return atA < atB ? -1 : 1;
        return a.ticket.id.localeCompare(b.ticket.id, undefined, { numeric: true });
      });
  }, [snapshot.tickets, member.id]);

  // 消息：来自快照的消息投影（C6 新增字段），按成员名匹配收发方向（含广播）。
  const messages = useMemo(() => {
    return snapshot.messages
      .filter((message) =>
        message.from === member.name
        || message.to === member.name
        || message.recipients.includes(member.name))
      .map((message) => ({
        id: message.id,
        at: message.timestamp,
        text: message.summary ?? message.text,
        sent: message.from === member.name,
        peer: message.from === member.name ? message.to : message.from,
      }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .reverse();
  }, [snapshot.messages, member.name]);

  const statusLabel = t(memberStateLabelKey(member.status));
  const completedCount = ticketHistory.filter((entry) => entry.urgency === "completed").length;

  return (
    <aside
      className="agent-teams-inspector"
      data-testid="agent-teams-member-inspector"
      data-member-id={member.id}
      aria-label={t("teams.inspector.heading")}
      style={{
        width: 380,
        flex: "none",
        minHeight: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderLeft: "var(--hairline) solid var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      <header style={{ flex: "none", padding: "12px 14px", borderBottom: "var(--hairline) solid var(--border)" }}>
        <button
          type="button"
          className="agent-teams-timeline-button"
          onClick={onBack}
          style={{ marginBottom: 10 }}
        >
          ← {t("teams.inspector.back")}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={`agent-teams-dot agent-teams-dot--${member.status}`} aria-hidden="true" />
          <span style={{ fontWeight: "var(--fw-semibold)" }}>{member.name}</span>
          {isLead && <span className="agent-teams-member-role">{t("teams.leader")}</span>}
        </div>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "8px 16px",
            margin: "12px 0 0",
            fontSize: "var(--fs-small)",
          }}
        >
          <div>
            <dt className="agent-teams-member-role">{t("teams.inspector.role")}</dt>
            <dd style={{ margin: 0 }}>{roleLabel}</dd>
          </div>
          <div>
            <dt className="agent-teams-member-role">{t("teams.inspector.status")}</dt>
            <dd style={{ margin: 0 }}>{statusLabel}</dd>
          </div>
          <div>
            <dt className="agent-teams-member-role">{t("teams.inspector.model")}</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{member.model ?? "—"}</dd>
          </div>
          <div>
            <dt className="agent-teams-member-role">{t("teams.inspector.provider")}</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{member.providerName ?? "—"}</dd>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <dt className="agent-teams-member-role">{t("teams.inspector.session")}</dt>
            <dd style={{ margin: 0, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
              {member.sessionId ?? t("teams.inspector.noSession")}
            </dd>
          </div>
        </dl>
        {member.lastError && (
          <p
            data-testid="agent-teams-member-last-error"
            style={{ margin: "10px 0 0", color: "var(--danger)", fontSize: "var(--fs-small)", overflowWrap: "anywhere" }}
          >
            {t("teams.inspector.error")}: {member.lastError}
          </p>
        )}
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" }}>
        <section className="agent-teams-section" aria-label={t("teams.inspector.taskHistory")}>
          <h3 className="agent-teams-section-title">
            {t("teams.inspector.taskHistory")} · {t("teams.status.completed").toLowerCase()} {completedCount}/{ticketHistory.length}
          </h3>
          {ticketHistory.length > 0 ? (
            <ol
              data-testid="agent-teams-member-task-history"
              style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}
            >
              {ticketHistory.map(({ ticket, urgency }) => (
                <li
                  key={ticket.id}
                  data-testid={`agent-teams-member-task-${ticket.id}`}
                  data-task-state={urgency}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-small)" }}
                >
                  <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", flex: "none" }}>#{ticket.id}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ticket.subject}>
                    {ticket.subject}
                  </span>
                  <span className={`agent-teams-board-task-dot`} aria-hidden="true" />
                  <span style={{ color: "var(--text-muted)", flex: "none" }}>{t(ticketStateLabelKey(urgency))}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="scheduled-hint">{t("teams.inspector.noTasks")}</p>
          )}
        </section>

        <section className="agent-teams-section" style={{ marginTop: 16 }} aria-label={t("teams.inspector.messages")}>
          <h3 className="agent-teams-section-title">{t("teams.inspector.messages")}</h3>
          {messages.length > 0 ? (
            <ol
              data-testid="agent-teams-member-messages"
              style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}
            >
              {messages.map((row) => (
                <li
                  key={row.id}
                  data-message-direction={row.sent ? "sent" : "received"}
                  style={{
                    borderLeft: `2px solid ${row.sent ? "var(--accent)" : "var(--border)"}`,
                    paddingLeft: 8,
                    fontSize: "var(--fs-small)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>
                    <span style={{ fontWeight: "var(--fw-semibold)" }}>
                      {t(row.sent ? "teams.inspector.sent" : "teams.inspector.received")}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>{row.peer || t("teams.inspector.everyone")}</span>
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>{formatClock(row.at, locale)}</span>
                  </div>
                  <p style={{ margin: "2px 0 0", color: "var(--text-muted)", overflowWrap: "anywhere" }}>{row.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="scheduled-hint">{t("teams.inspector.noMessages")}</p>
          )}
        </section>
      </div>

      <footer style={{ flex: "none", padding: "12px 14px", borderTop: "var(--hairline) solid var(--border)" }}>
        <button
          type="button"
          className="agent-teams-timeline-button agent-teams-timeline-button--primary"
          data-testid="agent-teams-member-open-session"
          disabled={!member.sessionId || !onOpenSession}
          onClick={() => member.sessionId && onOpenSession?.(member.sessionId)}
          style={{ width: "100%", padding: "8px 12px" }}
        >
          {t("teams.inspector.openSession", { name: member.name })}
        </button>
      </footer>
    </aside>
  );
}
