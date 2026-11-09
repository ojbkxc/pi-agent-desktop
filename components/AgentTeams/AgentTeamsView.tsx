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
import type { TranslationParams } from "@/lib/i18n/types";
import { TaskBoardCanvas, countTaskStates } from "@/components/AgentTeams/TaskBoardCanvas";
import { FormationBand } from "@/components/AgentTeams/FormationBand";
import { TeamMemberModelPanel } from "@/components/AgentTeams/TeamMemberModelPanel";
import { DispatchPanel } from "@/components/AgentTeams/DispatchPanel";
import { TeamLifecycleActions } from "@/components/AgentTeams/TeamLifecycleActions";
import { FallbackSettings } from "@/components/AgentTeams/FallbackSettings";
import { AgentTeamsMemberInspector } from "@/components/AgentTeams/AgentTeamsMemberInspector";
import { AgentTeamTaskDetail } from "@/components/AgentTeams/AgentTeamTaskDetail";
import { AgentTeamsCommunicationFeed } from "@/components/AgentTeams/AgentTeamsCommunicationFeed";
import { formationNaturalWidth } from "@/lib/agent-teams-formation-layout";
import { deriveMemberWorkloads, idleMemberIds } from "./member-workload";
import { formatTeamActivityDate, formatTeamBytes, hasDisplayableUsage, shouldNoticeIdleTeam } from "./team-usage-display";

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
  // #63：GET /api/teams 平铺占用字段（v8 契约 @ 9b7c083）。全部可选+可空——
  // 缺失/null 一律不渲染对应片段，绝不编造占用。
  bytes?: number | null;
  files?: number;
  truncated?: boolean;
  lastActivityAt?: number | null;
  ended?: boolean | null;
  idleDays?: number | null;
  usageError?: string;
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

/** 毫秒 → HH:MM:SS（>1h）或 MM:SS；负值夹到 0（C9 已用时长）。 */
function formatDuration(valueMs: number): string {
  const seconds = Math.max(0, Math.round(valueMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (part: number) => String(part).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/** ISO → 本地 HH:MM:SS（C9 会话时钟）；不可解析回退 --:--:--。 */
function formatClock(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "--:--:--";
  try {
    return new Date(time).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "--:--:--";
  }
}

/** C9 Live 指示的纯派生输入（全部来自快照 + 时钟，无副作用）。 */
export interface LiveIndicatorInput {
  /** snapshot.team.status。 */
  teamStatus: string;
  /** 运行中的成员数（不含队长）。 */
  workingCount: number;
  /** 是否实时跟随（回放时 elapsed/clock 冻结到当前帧）。 */
  isLive: boolean;
  /** 团队创建时间（ISO）。 */
  createdAt: string;
  /** 当前帧生成时间（ISO）。 */
  generatedAt: string;
  /** 当前毫秒时间戳（仅实时跟随时每秒推进）。 */
  now: number;
}

export interface LiveIndicator {
  /** forming / running / waiting 三态提示。 */
  hint: string;
  /** 已用时长（团队创建 → 现在，或回放时的当前帧）。 */
  elapsed: string;
  /** 会话时钟（实时=now，回放=帧时间）。 */
  clock: string;
}

/**
 * C9：把 Live 指示需要的三样（三态 hint / 已用时长 / 会话时钟）从快照与时钟纯派生出来。
 * 抽成模块级纯函数是为了能在没有 DOM 的测试里直接覆盖三态与时长/时钟的边界
 * （工作台视图本身 SSR 时 snapshot 为 null，起不到断言作用）。
 */
export function deriveLiveIndicator(
  input: LiveIndicatorInput,
  t: (key: string, params?: TranslationParams) => string,
  locale: string,
): LiveIndicator {
  const hint = input.teamStatus === "forming"
    ? t("teams.live.formingHint")
    : input.workingCount > 0
      ? t("teams.live.runningHint", { count: input.workingCount })
      : t("teams.live.waitingHint");
  const startMs = Date.parse(input.createdAt);
  const frameMs = Date.parse(input.generatedAt);
  const start = Number.isFinite(startMs) ? startMs : Number.isFinite(frameMs) ? frameMs : input.now;
  const end = input.isLive ? input.now : Number.isFinite(frameMs) ? frameMs : input.now;
  const clock = input.isLive
    ? formatClock(new Date(input.now).toISOString(), locale)
    : formatClock(input.generatedAt, locale);
  return { hint, elapsed: formatDuration(end - start), clock };
}

/** 工作台（整页视图）：左侧泳道/任务板/成员区，右侧成员检查器/通信流/收起导轨。 */
interface Props {
  /** 指定团队名（硬钉）；缺省时自动挑选本机最新创建的团队。 */
  teamName?: string;
  /**
   * 初始选中的团队名（来源会话所属的部门）。仅在名册里确实存在时才采用，
   * 且优先于「名册里最新创建的团队」——否则从会话 A 的部门点进来会显示 B 的团队。
   */
  initialTeamName?: string | null;
  /** 来源会话 id（返回链标识，透传到根节点 data 属性）。 */
  sourceSessionId?: string | null;
  /** 请求关闭本视图（返回链，由上层提供）。 */
  onRequestClose?: () => void;
  /** 打开某成员会话（可选）。 */
  onOpenSession?: (sessionId: string) => void;
}

/**
 * 泳道图页面（pi-web 专属）：每成员一条泳道（y=成员，x=时间），成员事件节点 +
 * 跨泳道流向，上方是任务依赖。数据来自 GET /api/teams/[team]/workbench。
 */
export function AgentTeamsView({
  teamName,
  initialTeamName,
  sourceSessionId,
  onRequestClose,
  onOpenSession,
}: Props) {
  const { t, locale } = useI18n();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  // 初始选中：硬钉 teamName 优先；否则来源会话的 initialTeamName（乐观），名册加载后再校正。
  const [selected, setSelected] = useState<string | null>(teamName ?? initialTeamName ?? null);
  const [listFailed, setListFailed] = useState(false);
  const [listLoading, setListLoading] = useState(!teamName);
  // 生命周期操作（停止/回收）成功后重拉团队名册的触发键（见 handleLifecycleDone）。
  const [teamsReloadKey, setTeamsReloadKey] = useState(0);
  const [modelPanel, setModelPanel] = useState<{ mode: "single" | "batch"; memberIds: string[] } | null>(null);
  // C7 成员检查器 / C8 任务详情抽屉 / C11 通信列表面板的选择态。
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [commOpen, setCommOpen] = useState(false);
  // C9 会话时钟：仅在实时跟随时每秒更新（回放时冻结）。
  const [now, setNow] = useState(() => Date.now());
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
  // #55（忙闲可见，纯读派生）：空闲成员名（按名册顺序）与未认领派活数。
  const idleNames = useMemo(() => {
    if (!snapshot) return [] as string[];
    const ids = idleMemberIds(snapshot);
    return ids.map((id) => snapshot.members.find((member) => member.id === id)?.name ?? id);
  }, [snapshot]);
  const orphanCount = useMemo(() => {
    if (!snapshot) return 0;
    const { orphan } = deriveMemberWorkloads(snapshot);
    return orphan.runningCount + orphan.pendingCount;
  }, [snapshot]);
  // #58：ticketId → subject（调度建议行的票标题展示；纯映射，缺票回退 ticketId）。
  const ticketSubjects = useMemo(() => {
    const map: Record<string, string> = {};
    for (const ticket of snapshot?.tickets ?? []) map[ticket.id] = ticket.subject;
    return map;
  }, [snapshot]);
  const loading = listLoading
    || timeline.loading
    || (selected !== null && timeline.latestIndex < 0 && !timeline.failed);
  const failed = listFailed || timeline.failed;

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  // 解析团队：硬钉 teamName > 名册里仍有效的当前选中 > initialTeamName（来源会话的
  // 部门）> 名册里最新创建的团队。修掉「从会话 A 的部门点进来却显示 B 的团队」。
  // 注意：即便硬钉了 teamName 也照常拉名册——团队下拉与占用行需要名册，否则从会话
  // 头部团队条进来时 picker/占用行会消失。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/teams", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { teams: TeamSummary[] };
        if (cancelled) return;
        setTeams(data.teams);
        const inRoster = (name: string | null | undefined): name is string =>
          Boolean(name && data.teams.some((team) => team.name === name));
        const latest = [...data.teams].sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))[0]?.name ?? null;
        setSelected((current) => {
          if (teamName) return teamName;
          if (inRoster(current)) return current;
          if (inRoster(initialTeamName)) return initialTeamName;
          return latest;
        });
      } catch {
        if (!cancelled) { setListFailed(true); setListLoading(false); }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [teamName, initialTeamName, teamsReloadKey]);

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

  // 切换团队时清掉成员检查器/任务抽屉的选择，避免带着上一团队的 id 指向新团队。
  useEffect(() => {
    setSelectedMemberId(null);
    setSelectedTicketId(null);
  }, [selected]);

  // C9 会话时钟：仅在实时跟随时每秒跳动（回放时冻结，改为显示帧时间）。
  useEffect(() => {
    if (!timeline.isLive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timeline.isLive]);

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

  // C7：当前选中的成员（名册首位为队长，队长也允许查看详情）。
  const selectedMember = useMemo(
    () => (snapshot && selectedMemberId ? snapshot.members.find((member) => member.id === selectedMemberId) ?? null : null),
    [snapshot, selectedMemberId],
  );
  const selectedMemberIsLead = Boolean(
    selectedMember && snapshot && snapshot.members[0]?.id === selectedMember.id,
  );
  // 右列是否展开（检查器或通信流面板占用时）：任务抽屉据此避让。
  const dockOpen = Boolean(selectedMember) || commOpen;
  // C9：运行中的成员数（不含队长，队长恒 running）与三态提示。
  const workingCount = useMemo(
    () => (snapshot ? snapshot.members.slice(1).filter((member) => member.status === "running").length : 0),
    [snapshot],
  );
  // C9：Live 指示（三态 hint / 已用时长 / 会话时钟）由纯函数派生，便于无 DOM 测试覆盖。
  const liveIndicator = useMemo(
    () => (!snapshot
      ? null
      : deriveLiveIndicator({
          teamStatus: snapshot.team.status,
          workingCount,
          isLive: timeline.isLive,
          createdAt: snapshot.team.createdAt,
          generatedAt: snapshot.generatedAt,
          now,
        }, t, locale)),
    [snapshot, workingCount, timeline.isLive, now, t, locale],
  );
  // C11：通信流收起导轨上的消息计数（messages = 邮箱消息投影，见 lib/agent-teams-swimlane）。
  const messageCount = snapshot?.messages.length ?? 0;

  // C7：点成员 → 打开检查器并展开右列。
  const openMemberInspector = useCallback((memberId: string) => {
    setSelectedTicketId(null);
    setSelectedMemberId(memberId);
    setCommOpen(true);
  }, []);

  return (
    <main
      ref={rootRef}
      tabIndex={-1}
      className="scheduled-view agent-teams-view"
      aria-label={t("teams.title")}
      data-source-session-id={sourceSessionId ?? undefined}
      style={{ overflow: "hidden" }}
    >
      {/* 左右分栏：左=既有整页工作台（自身滚动），右=成员检查器/通信流/导轨（C7/C11）。 */}
      <div className="agent-teams-workbench-row" style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div className="scheduled-shell agent-teams-shell" style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <header className="scheduled-header agent-teams-header">
          <div>
            {onRequestClose && (
              <button
                type="button"
                className="agent-teams-timeline-button"
                onClick={onRequestClose}
                style={{ marginBottom: 6 }}
              >
                ← {t("teams.view.back")}
              </button>
            )}
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
              {/* C9 Live 指示：仅在实时跟随时显示 following 徽标 + 三态提示 + 已用时长 + 会话时钟。
                  live/replay 切换本身由上方时间轴负责，这里只补额外视觉信息。 */}
              {timeline.isLive && liveIndicator && (
                <div
                  className="agent-teams-live"
                  data-testid="agent-teams-live-controls"
                  style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
                >
                  <span className="agent-teams-timeline-state agent-teams-timeline-state--live">
                    <span className="agent-teams-timeline-dot agent-teams-timeline-dot--live" aria-hidden="true" />
                    {t("teams.live.following")}
                  </span>
                  <span className="agent-teams-live-hint" style={{ color: "var(--text-muted)", fontSize: "var(--fs-small)" }}>
                    {liveIndicator.hint}
                  </span>
                  <span className="agent-teams-live-stat" style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                    <span className="agent-teams-member-role" style={{ fontSize: "var(--fs-micro)" }}>{t("teams.live.elapsed")}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{liveIndicator.elapsed}</span>
                  </span>
                  <span className="agent-teams-live-stat" style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                    <span className="agent-teams-member-role" style={{ fontSize: "var(--fs-micro)" }}>{t("teams.live.sessionClock")}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{liveIndicator.clock}</span>
                  </span>
                </div>
              )}
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

        {/* #63 占用行（如实展示，缺字段不渲染不编造）：大小/文件数/截断标记/最近活动；
            usageError 存在才显示失败原因（bytes:null 时不显示大小行——「未知」是噪音，
            失败原因已如实带出）；ended 且闲置 ≥7 天仅提示（动作只来自生命周期区的
            用户显式点击）。先收窄 currentTeam 再判可展示性，字段缺失整块跳过。 */}
        {currentTeam && hasDisplayableUsage(currentTeam) && (
          <div className="agent-teams-usage" data-testid="agent-teams-usage">
            {currentTeam.usageError && (
              <span className="agent-teams-usage-error" role="status">
                {t("teams.usage.usageError", { error: currentTeam.usageError })}
              </span>
            )}
            {typeof currentTeam.bytes === "number" && (
              <span className="agent-teams-usage-item">
                {t("teams.usage.bytes", { size: formatTeamBytes(currentTeam.bytes) ?? t("teams.usage.unknown") })}
              </span>
            )}
            {typeof currentTeam.files === "number" && (
              <span className="agent-teams-usage-item">
                {t("teams.usage.files", { count: currentTeam.files })}
                {currentTeam.truncated === true && (
                  <span className="agent-teams-usage-truncated"> · {t("teams.usage.truncated")}</span>
                )}
              </span>
            )}
            {(() => {
              const activityDate = formatTeamActivityDate(currentTeam.lastActivityAt, locale);
              return activityDate ? (
                <span className="agent-teams-usage-item">{t("teams.usage.lastActivity", { date: activityDate })}</span>
              ) : null;
            })()}
            {shouldNoticeIdleTeam(currentTeam) && (
              <span className="agent-teams-usage-idle" data-testid="agent-teams-usage-idle">
                {t("teams.usage.idleNotice", { days: currentTeam.idleDays ?? 0 })}
              </span>
            )}
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
                {/* #55（忙闲可见，已拍板：自动感知+提示，调度由用户一键确认）：空闲成员
                    名单与未认领派活的降级提示——纯读展示，无动作按钮。 */}
                {idleNames.length > 0 && (
                  <span className="agent-teams-members-idle-hint" title={idleNames.join(", ")}>
                    {t("teams.workload.idleMembers", { names: idleNames.join(", ") })}
                  </span>
                )}
                {orphanCount > 0 && (
                  <span className="agent-teams-members-orphan-hint">
                    {t("teams.workload.unassigned", { count: orphanCount })}
                  </span>
                )}
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
                      aria-pressed={selectedMemberId === member.id}
                      onClick={() => openMemberInspector(member.id)}
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
              {/* #58 一键调度：建议只展示，执行需用户两段式确认；workload 拉取失败
                  只降级面板本身，不阻断泳道/编队带/统计头。 */}
              {selected && (
                <DispatchPanel
                  team={selected}
                  snapshotStamp={snapshot?.generatedAt ?? null}
                  ticketSubjects={ticketSubjects}
                />
              )}
              <TaskBoardCanvas
                snapshot={snapshot}
                requestedWidth={boardWidth}
                onSelectTask={(ticketId) => setSelectedTicketId(ticketId)}
                formation={(width) => (
                  <FormationBand
                    snapshot={snapshot}
                    width={width}
                    onSelectMember={(memberId) => openMemberInspector(memberId)}
                  />
                )}
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

      {/* 右列：成员检查器（C7）→ 通信流面板（C11，含注入槽位）→ 收起导轨（点击展开）。 */}
      {snapshot && (
        <div className="agent-teams-right-dock" style={{ display: "flex", flex: "none", minHeight: 0 }}>
          {selectedMember ? (
            <AgentTeamsMemberInspector
              snapshot={snapshot}
              member={selectedMember}
              isLead={selectedMemberIsLead}
              onBack={() => setSelectedMemberId(null)}
              onOpenSession={onOpenSession}
            />
          ) : commOpen ? (
            <aside
              className="agent-teams-comm-panel"
              data-testid="agent-teams-communication-pane"
              aria-label={t("teams.communication.title")}
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
              <div
                style={{
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "10px 12px",
                  borderBottom: "var(--hairline) solid var(--border)",
                }}
              >
                <span style={{ fontWeight: "var(--fw-semibold)" }}>{t("teams.communication.title")}</span>
                <button
                  type="button"
                  className="agent-teams-timeline-button"
                  onClick={() => setCommOpen(false)}
                  aria-label={t("teams.communication.close")}
                >
                  ✕
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                <AgentTeamsCommunicationFeed
                  snapshot={snapshot}
                  fill
                  onFocusTask={(taskId) => setSelectedTicketId(taskId)}
                />
              </div>
            </aside>
          ) : (
            <button
              type="button"
              className="agent-teams-comm-rail"
              data-testid="agent-teams-communication-rail"
              aria-label={t("teams.communication.open")}
              onClick={() => setCommOpen(true)}
              style={{
                width: 56,
                flex: "none",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 12,
                padding: "12px 0",
                borderLeft: "var(--hairline) solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)" }} aria-hidden="true">‹</span>
              <span
                style={{
                  writingMode: "vertical-rl",
                  fontSize: "var(--fs-micro)",
                  fontWeight: "var(--fw-semibold)",
                  color: "var(--text-muted)",
                }}
              >
                {t("teams.communication.title")}
              </span>
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: "var(--radius-lg)",
                  background: "var(--bg-hover)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-micro)",
                }}
              >
                {messageCount}
              </span>
              <span
                className={`agent-teams-timeline-dot${timeline.isLive ? " agent-teams-timeline-dot--live" : ""}`}
                aria-hidden="true"
              />
            </button>
          )}
        </div>
      )}
      </div>

      {/* C8 任务详情抽屉：点任务卡打开，浮于右下角。 */}
      {snapshot && selectedTicketId && (
        <AgentTeamTaskDetail
          snapshot={snapshot}
          ticketId={selectedTicketId}
          onClose={() => setSelectedTicketId(null)}
          onSelectMember={openMemberInspector}
          dockOpen={dockOpen}
        />
      )}
    </main>
  );
}
