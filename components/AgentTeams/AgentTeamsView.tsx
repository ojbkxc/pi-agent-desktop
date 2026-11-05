"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  layoutSwimlanes,
  EVENT_HEIGHT,
  EVENT_WIDTH,
  LANE_LABEL_WIDTH,
  type MemberStatus,
  type SwimlaneEventType,
  type TeamWorkbenchSnapshot,
} from "@/lib/agent-teams-swimlane";
import { AppSelect } from "@/components/AppSelect";

interface Props {
  /** 指定团队名；缺省时自动挑选本机最新创建的团队。 */
  teamName?: string;
  /** 打开某成员会话（可选）。 */
  onOpenSession?: (sessionId: string) => void;
}

const LIVE_REFRESH_MS = 3000;

interface TeamSummary {
  name: string;
  description: string;
  memberCount: number;
  createdAt: string;
}

/** 成员状态 / 事件类型 → 中文标签键（动态键，usage 门禁自动跳过静态校验）。 */
function statusLabelKey(status: MemberStatus): string {
  return `teams.status.${status}`;
}
function eventLabelKey(type: SwimlaneEventType): string {
  return `teams.event.${type}`;
}

/**
 * 泳道图页面（pi-web 专属）：每成员一条泳道（y=成员，x=时间），成员事件节点 +
 * 跨泳道流向，上方是任务依赖。数据来自 GET /api/teams/[team]/workbench。
 */
export function AgentTeamsView({ teamName, onOpenSession }: Props) {
  const { t } = useI18n();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(teamName ?? null);
  const [snapshot, setSnapshot] = useState<TeamWorkbenchSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  // 解析团队：显式 prop 优先，否则取名册里最新创建的一个。
  useEffect(() => {
    if (teamName) { setSelected(teamName); return; }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/teams", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { teams: TeamSummary[] };
        if (cancelled) return;
        setTeams(data.teams);
        setSelected((current) => current ?? [...data.teams].sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))[0]?.name ?? null);
      } catch {
        if (!cancelled) { setFailed(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [teamName]);

  // 轮询快照：团队运行中时每 3 秒刷新，页面不可见时不拉取。
  useEffect(() => {
    if (!selected) { setSnapshot(null); setLoading(false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/teams/${encodeURIComponent(selected)}/workbench`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as TeamWorkbenchSnapshot;
        if (cancelled) return;
        setSnapshot(data);
        setFailed(false);
        const live = data.team.status === "running" || data.team.status === "finishing" || data.team.status === "forming";
        if (live) timer = setTimeout(() => { if (document.visibilityState === "visible") void load(); }, LIVE_REFRESH_MS);
      } catch {
        if (!cancelled) { setFailed(true); setLoading(false); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [selected]);

  const layout = useMemo(() => (snapshot ? layoutSwimlanes(snapshot) : null), [snapshot]);
  const progress = useMemo(() => {
    if (!snapshot) return { done: 0, total: 0, percent: 0 };
    const total = snapshot.tickets.length;
    const done = snapshot.tickets.filter((ticket) => ticket.status === "ended").length;
    return { done, total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [snapshot]);

  const ownerName = useMemo(() => {
    const map = new Map((snapshot?.members ?? []).map((member) => [member.id, member.name]));
    return (id: string | null) => (id ? map.get(id) ?? id : t("teams.unassigned"));
  }, [snapshot, t]);

  return (
    <main ref={rootRef} tabIndex={-1} className="scheduled-view agent-teams-view" aria-label={t("teams.title")}>
      <div className="scheduled-shell agent-teams-shell">
        <header className="scheduled-header agent-teams-header">
          <div>
            <h2 className="scheduled-title">{t("teams.title")}</h2>
            <p className="scheduled-subtitle">{t("teams.subtitle")}</p>
          </div>
          {snapshot && (
            <span className={`agent-teams-phase agent-teams-phase--${snapshot.team.status}`}>
              {t(`teams.phase.${snapshot.team.status}`)}
            </span>
          )}
        </header>

        {teams.length > 1 && (
          <div className="agent-teams-picker">
            <AppSelect
              aria-label={t("teams.pickTeam")}
              value={selected ?? ""}
              onValueChange={setSelected}
              options={teams.map((team) => ({ value: team.name, label: team.name }))}
            />
          </div>
        )}

        {failed && <p className="scheduled-error" role="alert">{t("teams.loadFailed")}</p>}
        {loading && !snapshot && !failed && <p className="scheduled-hint">{t("teams.loading")}</p>}
        {!loading && !failed && !snapshot && <p className="scheduled-hint">{t("teams.empty")}</p>}

        {snapshot && (
          <>
            <div className="agent-teams-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
              <div className="agent-teams-progress-fill" style={{ width: `${progress.percent}%` }} />
            </div>
            <p className="scheduled-hint">{t("teams.progress", { done: progress.done, total: progress.total })}</p>

            <section className="agent-teams-section" aria-label={t("teams.membersHeading")}>
              <h3 className="agent-teams-section-title">{t("teams.membersHeading")}</h3>
              <ul className="agent-teams-members">
                {snapshot.members.map((member) => (
                  <li key={member.id} className="agent-teams-member">
                    <button
                      type="button"
                      className="agent-teams-member-chip"
                      disabled={!member.sessionId || !onOpenSession}
                      onClick={() => member.sessionId && onOpenSession?.(member.sessionId)}
                    >
                      <span className={`agent-teams-dot agent-teams-dot--${member.status}`} aria-hidden="true" />
                      <span className="agent-teams-member-name">{member.name}</span>
                      <span className="agent-teams-member-role">{member.role}</span>
                      <span className="agent-teams-member-status">{t(statusLabelKey(member.status))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="agent-teams-section" aria-label={t("teams.lanesHeading")}>
              <h3 className="agent-teams-section-title">{t("teams.lanesHeading")}</h3>
              {layout && (
                <div className="agent-teams-canvas-scroll">
                  <div
                    className="agent-teams-canvas"
                    style={{ width: layout.width, height: layout.height, minWidth: layout.width }}
                  >
                    <svg className="agent-teams-flows" width={layout.width} height={layout.height} aria-hidden="true">
                      {layout.flows.map((flow, index) => (
                        <path
                          key={`${flow.from}-${flow.to}-${index}`}
                          className={`agent-teams-flow agent-teams-flow--${flow.kind}`}
                          d={`M ${flow.fromX} ${flow.fromY} C ${flow.fromX + 40} ${flow.fromY}, ${flow.toX - 40} ${flow.toY}, ${flow.toX} ${flow.toY}`}
                        />
                      ))}
                    </svg>
                    {layout.lanes.map((lane) => (
                      <div key={lane.memberId} className="agent-teams-lane" style={{ top: lane.y, height: lane.height }}>
                        <span
                          className="agent-teams-lane-label"
                          style={{ width: LANE_LABEL_WIDTH, height: lane.height }}
                        >
                          <span className={`agent-teams-dot agent-teams-dot--${lane.status}`} aria-hidden="true" />
                          <span className="agent-teams-lane-name">{lane.name}</span>
                          <span className="agent-teams-lane-role">{lane.role}</span>
                        </span>
                        {lane.events.map((event) => (
                          <span
                            key={`${event.seq}-${event.at}-${event.type}`}
                            className={`agent-teams-event agent-teams-event--${event.type}`}
                            style={{ left: event.x, top: event.y - lane.y, width: EVENT_WIDTH, height: EVENT_HEIGHT }}
                            title={event.detail}
                          >
                            <span className="agent-teams-event-type">{t(eventLabelKey(event.type))}</span>
                            <span className="agent-teams-event-detail">{event.detail}</span>
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="agent-teams-section" aria-label={t("teams.ticketsHeading")}>
              <h3 className="agent-teams-section-title">{t("teams.ticketsHeading")}</h3>
              <ul className="agent-teams-tickets">
                {snapshot.tickets.map((ticket) => (
                  <li key={ticket.id} className={`agent-teams-ticket agent-teams-ticket--${ticket.status}`}>
                    <span className="agent-teams-ticket-subject">{ticket.subject}</span>
                    <span className="agent-teams-ticket-owner">{ownerName(ticket.ownerId)}</span>
                    {ticket.dependencies.length > 0 && (
                      <span className="agent-teams-ticket-deps">
                        {t("teams.dependsOn", { deps: ticket.dependencies.join(", ") })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
