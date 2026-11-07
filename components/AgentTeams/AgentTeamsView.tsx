"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTeamTimeline } from "@/hooks/useTeamTimeline";
import {
  layoutSwimlanes,
  EVENT_HEIGHT,
  EVENT_WIDTH,
  LANE_LABEL_WIDTH,
  type MemberStatus,
  type SwimlaneEventType,
} from "@/lib/agent-teams-swimlane";
import { AppSelect } from "@/components/AppSelect";
import { TaskBoardCanvas, countTaskStates } from "@/components/AgentTeams/TaskBoardCanvas";

interface Props {
  /** 指定团队名；缺省时自动挑选本机最新创建的团队。 */
  teamName?: string;
  /** 打开某成员会话（可选）。 */
  onOpenSession?: (sessionId: string) => void;
}

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
/** 成员角色（agentType）→ 本地化词条键（动态键，usage 门禁自动跳过静态校验）。 */
function roleLabelKey(role: string): string {
  return `teams.role.${role}`;
}

/**
 * 泳道图页面（pi-web 专属）：每成员一条泳道（y=成员，x=时间），成员事件节点 +
 * 跨泳道流向，上方是任务依赖。数据来自 GET /api/teams/[team]/workbench。
 */
export function AgentTeamsView({ teamName, onOpenSession }: Props) {
  const { t } = useI18n();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(teamName ?? null);
  const [listFailed, setListFailed] = useState(false);
  const [listLoading, setListLoading] = useState(!teamName);
  const timeline = useTeamTimeline(selected);
  const rootRef = useRef<HTMLElement>(null);

  // 角色名走 i18n；没有对应词条时回退到 role 原文，绝不把 key 名渲染到界面。
  const roleLabel = useCallback((role: string): string => {
    const key = roleLabelKey(role);
    const label = t(key);
    return label === key ? role : label;
  }, [t]);

  // 当前展示的快照：实时跟随时是末条，回放时是 historyIndex 指向的那一格。
  const snapshot = timeline.currentSnapshot;
  const loading = listLoading
    || timeline.loading
    || (selected !== null && timeline.latestIndex < 0 && !timeline.failed);
  const failed = listFailed || timeline.failed;

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
        if (!cancelled) { setListFailed(true); setListLoading(false); }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [teamName]);

  const layout = useMemo(() => (snapshot ? layoutSwimlanes(snapshot) : null), [snapshot]);
  const progress = useMemo(() => {
    if (!snapshot) return { done: 0, total: 0, percent: 0 };
    const total = snapshot.tickets.length;
    const done = snapshot.tickets.filter((ticket) => ticket.status === "ended").length;
    return { done, total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [snapshot]);

  // 四态计数：口径与任务画布完全一致（lib/agent-teams-task-layout.ts）。
  const counts = useMemo(() => countTaskStates(snapshot?.tickets ?? []), [snapshot]);

  return (
    <main ref={rootRef} tabIndex={-1} className="scheduled-view agent-teams-view" aria-label={t("teams.title")}>
      <div className="scheduled-shell agent-teams-shell">
        <header className="scheduled-header agent-teams-header">
          <div>
            <h2 className="scheduled-title">{t("teams.title")}</h2>
            <p className="scheduled-subtitle">{t("teams.subtitle")}</p>
          </div>
          {snapshot && (
            <div className="agent-teams-board-header-meta">
              <span className={`agent-teams-phase agent-teams-phase--${snapshot.team.status}`}>
                {t(`teams.phase.${snapshot.team.status}`)}
              </span>
              <div className="agent-teams-board-stats" role="group" aria-label={t("teams.ticketsHeading")}>
                <div className="agent-teams-board-stat">
                  <span className="agent-teams-board-stat-label">{t("teams.stats.completed")}</span>
                  <span className="agent-teams-board-stat-value">{counts.completed}/{snapshot.tickets.length}</span>
                </div>
                <div className="agent-teams-board-stat agent-teams-board-stat--info">
                  <span className="agent-teams-board-stat-label">{t("teams.stats.running")}</span>
                  <span className="agent-teams-board-stat-value">{counts.in_progress}</span>
                </div>
                <div className="agent-teams-board-stat">
                  <span className="agent-teams-board-stat-label">{t("teams.stats.available")}</span>
                  <span className="agent-teams-board-stat-value">{counts.available}</span>
                </div>
                <div className="agent-teams-board-stat agent-teams-board-stat--muted">
                  <span className="agent-teams-board-stat-label">{t("teams.stats.blocked")}</span>
                  <span className="agent-teams-board-stat-value">{counts.blocked}</span>
                </div>
              </div>
            </div>
          )}
        </header>

        {snapshot && (
          <div className="agent-teams-timeline" role="group" aria-label={t("teams.timeline")}>
            <span className={`agent-teams-timeline-state${timeline.isLive ? " agent-teams-timeline-state--live" : ""}`}>
              <span
                className={`agent-teams-timeline-dot${timeline.isLive ? " agent-teams-timeline-dot--live" : ""}`}
                aria-hidden="true"
              />
              {timeline.isReplaying ? t("teams.replay") : t("teams.live")}
            </span>
            <span className="agent-teams-timeline-position">
              {t("teams.snapshotPosition", { index: timeline.selectedIndex + 1, total: timeline.snapshots.length })}
            </span>
            {timeline.isReplaying ? (
              <>
                <button
                  type="button"
                  className="agent-teams-timeline-button"
                  onClick={timeline.stepBack}
                  disabled={timeline.selectedIndex <= 0}
                >
                  {t("teams.stepBack")}
                </button>
                <button
                  type="button"
                  className="agent-teams-timeline-button agent-teams-timeline-button--primary"
                  onClick={timeline.togglePlayback}
                  disabled={timeline.latestIndex <= 0}
                  aria-pressed={timeline.playing}
                >
                  {timeline.playing ? t("teams.pause") : t("teams.play")}
                </button>
                <button
                  type="button"
                  className="agent-teams-timeline-button"
                  onClick={timeline.stepForward}
                  disabled={timeline.selectedIndex >= timeline.latestIndex}
                >
                  {t("teams.stepForward")}
                </button>
                <button type="button" className="agent-teams-timeline-button" onClick={timeline.exitReplay}>
                  {t("teams.backToLive")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="agent-teams-timeline-button"
                onClick={timeline.enterReplay}
                disabled={timeline.latestIndex <= 0}
              >
                {t("teams.replay")}
              </button>
            )}
          </div>
        )}

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
                      <span className="agent-teams-member-role">{roleLabel(member.role)}</span>
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
                          <span className="agent-teams-lane-role">{roleLabel(lane.role)}</span>
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
              <TaskBoardCanvas snapshot={snapshot} />
            </section>
          </>
        )}
      </div>
    </main>
  );
}
