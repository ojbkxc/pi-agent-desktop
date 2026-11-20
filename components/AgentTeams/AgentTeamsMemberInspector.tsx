"use client";

import { useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "@/components/MarkdownBody";
import { getTicketUrgency, type TicketUrgency } from "@/lib/agent-teams-task-layout";
import { formatUpdatedTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/types";
import type {
  TeamWorkbenchSnapshot,
  WorkbenchMember,
  WorkbenchMessage,
} from "@/lib/agent-teams-swimlane";
import {
  identityAliases,
  parseMessageBody,
  rowDisplayText,
  type MessageBody,
} from "./agent-teams-feed-model";

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

// ─────────────────────────────────────────────────────────────────────────────
// 身份别名匹配（移植 cc-haha memberMatchesIdentity）：成员 id 与 name 双别名，
// 同时认全名与 name@team 的短名——发送方/收件方/recipients 可能是任一形态。
// ─────────────────────────────────────────────────────────────────────────────

function memberAliases(member: WorkbenchMember): string[] {
  return [...identityAliases(member.id), ...identityAliases(member.name)];
}

function memberMatchesIdentity(member: WorkbenchMember, identity: string | undefined): boolean {
  if (!identity) return false;
  const aliases = identityAliases(identity);
  const own = memberAliases(member);
  return aliases.some((alias) => own.includes(alias));
}

/** 一条消息是否与该成员相关：收发任一侧命中，或为广播（to="*"）。 */
function relatedToMember(message: WorkbenchMessage, member: WorkbenchMember): boolean {
  return memberMatchesIdentity(member, message.from)
    || memberMatchesIdentity(member, message.to)
    || message.recipients.some((recipient) => memberMatchesIdentity(member, recipient))
    || message.to === "*";
}

/** ISO 时间 → 跟随应用语言的展示口径（与通信流一致：今天显示钟点，跨天相对）。 */
function formatMessageTime(timestamp: string, locale: Locale): string {
  const time = new Date(timestamp);
  return Number.isNaN(time.getTime()) ? "" : formatUpdatedTime(time.getTime(), locale);
}

// ─────────────────────────────────────────────────────────────────────────────
// 任务历史三分组（cc-haha groupRunning / groupUpcoming / groupCompleted 语义）：
// 运行中 / 未开始（blocked + available）/ 已完成（completed + failed，failed 也是 ended）。
// ─────────────────────────────────────────────────────────────────────────────

type TaskGroup = "running" | "upcoming" | "completed";

function ticketGroup(urgency: TicketUrgency): TaskGroup {
  if (urgency === "running") return "running";
  if (urgency === "completed" || urgency === "failed") return "completed";
  return "upcoming";
}

const TASK_GROUPS: ReadonlyArray<{ group: TaskGroup; labelKey: string }> = [
  { group: "running", labelKey: ticketStateLabelKey("running") },
  { group: "upcoming", labelKey: ticketStateLabelKey("available") },
  { group: "completed", labelKey: ticketStateLabelKey("completed") },
];

// ─────────────────────────────────────────────────────────────────────────────
// 状态推导（移植 cc-haha currentStatusLabel / recoveryHint 的等价口径）：
// 只依据本仓真实字段（member.status / tickets / lastError），不编造倒计时。
// ─────────────────────────────────────────────────────────────────────────────

type WorkState = "working" | "idle" | "stopped" | "error";

function toWorkState(status: WorkbenchMember["status"]): WorkState {
  if (status === "running") return "working";
  if (status === "failed") return "error";
  if (status === "parked" || status === "aborted") return "stopped";
  // idle / completed / queued 都视为「当前无进行中的活」。
  return "idle";
}

type InspectorMessage = {
  message: WorkbenchMessage;
  body: MessageBody;
  /** sent=本成员发出，received=本成员收到。 */
  sent: boolean;
  /** 对端展示名（广播为 "*"，渲染时本地化）。 */
  peer: string;
};

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
 * 成员检查器（C7）：点成员 → 右侧面板显示成员详情 + 执行历史（名下票，按运行中/未开始/
 * 已完成分组）+ 消息 + 「打开其会话」。纯展示组件，数据全部来自当前快照，不发起任何请求；
 * 关闭由上层把 selectedMemberId 置空。
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

  const ticketById = useMemo(
    () => new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket])),
    [snapshot.tickets],
  );

  // 消息：来自快照的消息投影（C6 新增字段），按身份别名匹配收发方向（含广播）。
  const messages = useMemo<InspectorMessage[]>(
    () => snapshot.messages
      .filter((message) => relatedToMember(message, member))
      .map((message): InspectorMessage => {
        const sent = memberMatchesIdentity(member, message.from);
        const recipient = message.to === "*" ? "*" : (message.recipients[0] ?? message.to);
        return {
          message,
          body: parseMessageBody(message),
          sent,
          peer: sent ? recipient : message.from,
        };
      })
      .sort((a, b) => (a.message.timestamp < b.message.timestamp ? -1 : a.message.timestamp > b.message.timestamp ? 1 : 0))
      .reverse(),
    [snapshot.messages, member],
  );

  const workState = toWorkState(member.status);
  const completedCount = ticketHistory.filter((entry) => ticketGroup(entry.urgency) === "completed").length;
  const runningTask = ticketHistory.find((entry) => entry.urgency === "running")?.ticket;
  const blockedTask = ticketHistory.find((entry) => entry.urgency === "blocked")?.ticket;
  const waitingDependency = blockedTask?.dependencies.find((dependencyId) => {
    const dependency = ticketById.get(dependencyId);
    return dependency !== undefined && dependency.status !== "ended";
  });

  const statusLabel = ((): string => {
    if (workState === "working") {
      return runningTask
        ? t("teams.inspector.status.executingTask", { task: runningTask.id })
        : t(memberStateLabelKey(member.status));
    }
    if (workState === "idle") {
      if (ticketHistory.length > 0 && completedCount === ticketHistory.length) {
        return t("teams.inspector.status.waitingForClose");
      }
      if (waitingDependency) {
        return t("teams.inspector.status.waitingForDependency", { task: waitingDependency });
      }
      return t("teams.inspector.status.waitingForTask");
    }
    // stopped / error：停在某张运行中的票上时点明「谁卡在哪张票」。
    return runningTask
      ? t("teams.inspector.status.stalledOnTask", {
          state: t(memberStateLabelKey(member.status)),
          task: runningTask.id,
        })
      : t(memberStateLabelKey(member.status));
  })();

  // 恢复提示：停止/出错时说明怎么恢复（错误原因另由 lastError 如实带出）。
  const recoveryHint = workState === "stopped"
    ? t("teams.inspector.status.stoppedHint")
    : workState === "error"
      ? t("teams.inspector.status.errorHint")
      : undefined;

  return (
    <aside
      className="agent-teams-inspector"
      data-testid="agent-teams-member-inspector"
      data-member-id={member.id}
      data-member-state={member.status}
      aria-label={t("teams.inspector.heading")}
      style={{
        // 固定 380 在窄视口把左栏压到 ~200px；40vw 上限让它随视口收缩。
        width: "min(380px, 40vw)",
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
            <dd data-testid="agent-teams-member-status" style={{ margin: 0 }}>{statusLabel}</dd>
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
        {(member.lastError || recoveryHint) && (
          <div
            data-testid="agent-teams-member-recovery"
            data-member-work-state={workState}
            style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}
          >
            {member.lastError && (
              <p
                data-testid="agent-teams-member-last-error"
                style={{ margin: 0, color: "var(--danger)", fontSize: "var(--fs-small)", overflowWrap: "anywhere" }}
              >
                {t("teams.inspector.error")}: {member.lastError}
              </p>
            )}
            {recoveryHint && (
              <p
                data-testid="agent-teams-member-recovery-hint"
                style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--fs-small)", overflowWrap: "anywhere" }}
              >
                {recoveryHint}
              </p>
            )}
          </div>
        )}
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px" }}>
        <section className="agent-teams-section" aria-label={t("teams.inspector.taskHistory")}>
          <h3 className="agent-teams-section-title">
            {t("teams.inspector.taskHistory")} · {t("teams.status.completed").toLowerCase()} {completedCount}/{ticketHistory.length}
          </h3>
          {ticketHistory.length > 0 ? (
            <div data-testid="agent-teams-member-task-history">
              {TASK_GROUPS.map(({ group, labelKey }) => {
                const entries = ticketHistory.filter((entry) => ticketGroup(entry.urgency) === group);
                if (entries.length === 0) return null;
                return (
                  <div key={group} data-testid={`agent-teams-member-task-group-${group}`} style={{ marginTop: 8 }}>
                    <h4
                      className="agent-teams-member-role"
                      style={{ margin: "0 0 4px", fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}
                    >
                      {t(labelKey)} · {entries.length}
                    </h4>
                    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                      {entries.map(({ ticket, urgency }) => (
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
                  </div>
                );
              })}
            </div>
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
              {messages.map((row) => {
                const sent = row.sent;
                return (
                  <li
                    key={row.message.id}
                    data-testid={`agent-teams-member-message-${row.message.id}`}
                    data-message-direction={sent ? "sent" : "received"}
                    data-message-body={row.body.kind}
                    style={{
                      // 发出=信息流（--info），收到=被唤醒（--accent），与 cc-haha 方向色一致。
                      borderLeft: `2px solid ${sent ? "var(--info)" : "var(--accent)"}`,
                      paddingLeft: 8,
                      fontSize: "var(--fs-small)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>
                      <span style={{ fontWeight: "var(--fw-semibold)" }}>
                        {t(sent ? "teams.inspector.sent" : "teams.inspector.received")}
                      </span>
                      <DirectionArrow sent={sent} />
                      <span style={{ fontFamily: "var(--font-mono)" }}>{row.peer === "*" ? t("teams.inspector.everyone") : row.peer}</span>
                      <time
                        dateTime={row.message.timestamp}
                        style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
                      >
                        {formatMessageTime(row.message.timestamp, locale)}
                      </time>
                    </div>
                    {row.body.kind === "text" ? (
                      <div style={{ marginTop: 2, fontSize: "var(--fs-small)", overflowWrap: "anywhere" }}>
                        <MarkdownBody>{row.body.text}</MarkdownBody>
                      </div>
                    ) : (
                      <p style={{ margin: "2px 0 0", color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                        {rowDisplayText(row.message, row.body, "system", t)}
                      </p>
                    )}
                  </li>
                );
              })}
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

/** 方向箭头（本仓无 lucide，内联 SVG）：发出→，收到←。 */
function DirectionArrow({ sent }: { sent: boolean }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      {sent ? (
        <>
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </>
      ) : (
        <>
          <path d="M19 12H5" />
          <path d="m12 19-7-7 7-7" />
        </>
      )}
    </svg>
  );
}
