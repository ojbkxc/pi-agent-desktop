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
import { FormationBand } from "@/components/AgentTeams/FormationBand";
import { TeamMemberModelPanel } from "@/components/AgentTeams/TeamMemberModelPanel";
import { TeamLifecycleActions } from "@/components/AgentTeams/TeamLifecycleActions";
import { FallbackSettings } from "@/components/AgentTeams/FallbackSettings";
import { formationNaturalWidth } from "@/lib/agent-teams-formation-layout";

interface Props {
  /** 指定团队名；缺省时自动挑选本机最新创建的团队。 */
  teamName?: string;
  /** 打开某成员会话（可选）。 */
  onOpenSession?: (sessionId: string) => void;
}

interface TeamSummary {
  /** 目录名（sanitize 后，稳定 id；用于选中与拉取 workbench）。 */
  name: string;
  /** 显示名：config.json 的 team.name，缺失回退目录名。 */
  displayName: string;
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
  // 生命周期操作（停止/回收）成功后重拉团队名册的触发键（见 handleLifecycleDone）。
  const [teamsReloadKey, setTeamsReloadKey] = useState(0);
  const [modelPanel, setModelPanel] = useState<{ mode: "single" | "batch"; memberIds: string[] } | null>(null);
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
  }, [teamName, teamsReloadKey]);

  // d5-3：生命周期操作成功后的收尾（TeamLifecycleActions.onDone）。回收删除了团队
  // 目录——重拉名册，且若删的正是当前选中团队则放开选中，让它回落到名册里其余
  // 团队（teams effect 的 `current ?? 最新` 会接管）；停止不删目录，只重拉名册。
  const handleLifecycleDone = useCallback((doneTeam: string, action: string) => {
    setTeamsReloadKey((key) => key + 1);
    if (action === "reclaim") {
      setSelected((current) => (current === doneTeam ? null : current));
    }
  }, []);

  // d5-2：切换团队时关闭成员换模型面板——面板若带着上一团队选中的 memberIds
  // 存活，提交会把那批成员打到新团队的 PATCH 上（批量→单个切换同理，由
  // 渲染处的 key 兜底，这里只管跨团队残留）。
  useEffect(() => {
    setModelPanel(null);
  }, [selected]);

  const layout = useMemo(() => (snapshot ? layoutSwimlanes(snapshot) : null), [snapshot]);

  // 五态紧急度计数：与任务画布同源（lib/agent-teams-task-layout.ts）。
  const counts = useMemo(() => countTaskStates(snapshot?.tickets ?? []), [snapshot]);
  // d4-1：完成度只认 countTaskStates 的 completed，不再自数 `status === "ended"`——
  // 那是绕开真源的第三种口径：失败票同样 ended，却会被算进「已完成」，与统计头、
  // 画布配色（taskToneClass）分叉。
  const progress = useMemo(() => {
    if (!snapshot) return { done: 0, total: 0, percent: 0 };
    const total = snapshot.tickets.length;
    const done = counts.completed;
    return { done, total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [snapshot, counts]);
  // 画布宽度：编队带需要按成员数撑开，任务泳道共用同一宽度才不会错位。
  const boardWidth = useMemo(
    () => (snapshot ? formationNaturalWidth(snapshot.members.length) : 0),
    [snapshot],
  );
  // 当前团队的展示名与成员数（生命周期确认文案要用 displayName，URL 用 name）。
  const currentTeam = useMemo(
    () => teams.find((team) => team.name === selected) ?? null,
    [teams, selected],
  );
  const currentDisplayName = currentTeam?.displayName ?? selected ?? "";
  const currentMemberCount = currentTeam?.memberCount ?? snapshot?.members.length ?? 0;

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
                  <span className="agent-teams-board-stat-value">{counts.running}</span>
                </div>
                <div className="agent-teams-board-stat">
                  <span className="agent-teams-board-stat-label">{t("teams.stats.available")}</span>
                  <span className="agent-teams-board-stat-value">{counts.available}</span>
                </div>
                <div className="agent-teams-board-stat agent-teams-board-stat--muted">
                  <span className="agent-teams-board-stat-label">{t("teams.stats.blocked")}</span>
                  <span className="agent-teams-board-stat-value">{counts.blocked}</span>
                </div>
                <div className="agent-teams-board-stat agent-teams-board-stat--danger">
                  <span className="agent-teams-board-stat-label">{t("teams.urgency.failed")}</span>
                  <span className="agent-teams-board-stat-value">{counts.failed}</span>
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

        {snapshot && timeline.isReplaying && timeline.frameExpired && (
          <p className="scheduled-hint agent-teams-timeline-expired" role="status">{t("teams.frameExpired")}</p>
        )}

        {teams.length > 1 && (
          <div className="agent-teams-picker">
            <AppSelect
              aria-label={t("teams.pickTeam")}
              value={selected ?? ""}
              onValueChange={setSelected}
              options={teams.map((team) => ({ value: team.name, label: team.displayName }))}
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
              <div className="agent-teams-section-head">
                <h3 className="agent-teams-section-title">{t("teams.membersHeading")}</h3>
                <button
                  type="button"
                  className="agent-teams-batch-model"
                  disabled={!selected || snapshot.members.length === 0}
                  onClick={() => setModelPanel({ mode: "batch", memberIds: snapshot.members.map((member) => member.id) })}
                >
                  {t("teams.memberModel.batchOpen")}
                </button>
              </div>
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
                    <button
                      type="button"
                      className="agent-teams-member-model"
                      disabled={!selected}
                      onClick={() => setModelPanel({ mode: "single", memberIds: [member.id] })}
                    >
                      {t("teams.memberModel.change")}
                    </button>
                  </li>
                ))}
              </ul>
              {modelPanel && selected && (
                <TeamMemberModelPanel
                  key={`${modelPanel.mode}-${modelPanel.memberIds.join(",")}`}
                  team={selected}
                  members={snapshot.members.map((member) => ({ id: member.id, name: member.name }))}
                  memberIds={modelPanel.memberIds}
                  mode={modelPanel.mode}
                  onClose={() => setModelPanel(null)}
                />
              )}
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
              <TaskBoardCanvas
                snapshot={snapshot}
                requestedWidth={boardWidth}
                formation={(width) => <FormationBand snapshot={snapshot} width={width} />}
              />
            </section>

            {selected && (
              <section className="agent-teams-section" aria-label={t("teams.lifecycle.heading")}>
                <h3 className="agent-teams-section-title">{t("teams.lifecycle.heading")}</h3>
                <p className="scheduled-hint">{t("teams.lifecycle.memberCount", { count: currentMemberCount })}</p>
                <TeamLifecycleActions
                  key={selected}
                  team={selected}
                  displayName={currentDisplayName}
                  memberCount={currentMemberCount}
                  onDone={handleLifecycleDone}
                />
              </section>
            )}
          </>
        )}

        <section className="agent-teams-section" aria-label={t("teams.fallback.heading")}>
          <h3 className="agent-teams-section-title">{t("teams.fallback.heading")}</h3>
          <FallbackSettings />
        </section>
      </div>
    </main>
  );
}
