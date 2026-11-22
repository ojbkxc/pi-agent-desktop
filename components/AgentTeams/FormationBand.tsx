"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TeamWorkbenchSnapshot, WorkbenchMessage } from "@/lib/agent-teams-swimlane";
import {
  FORMATION_BOTTOM,
  FORMATION_TITLE_X,
  FORMATION_TITLE_Y,
  LEAD_FOOT,
  LEAD_BUS_Y,
  MEMBER_FOOT,
  MEMBER_PITCH,
  MEMBER_SLOT_WIDTH,
  MEMBER_TOP,
  PEER_BUS_Y,
  identityMatches,
  layoutFormation,
  sortWorkersByUrgency,
  type FormationMember,
  type MemberWorkState,
} from "@/lib/agent-teams-formation-layout";
import type { TicketUrgency } from "@/lib/agent-teams-task-layout";
import { formationFlights, type FlightNode } from "@/lib/agent-teams-flight";
import type { TranslationParams } from "@/lib/i18n/types";
import { deriveMemberWorkloads, workloadBadgeKind, type MemberWorkload } from "./member-workload";

const ACCENTS = new Set(["blue", "green", "purple", "orange", "teal", "pink", "red", "gray"]);

/**
 * 成员卡「没有在跑的票」时的空列表：必须是模块级常量。
 * 每次渲染都写 `[]` 会给出新的引用，MemberCard 的 memo 就彻底失效（成员多时整排重绘）。
 */
const EMPTY_TICKET_IDS: readonly string[] = [];

/** 编队带左右留白（与任务画布的 HORIZONTAL_PADDING 同量级，只用于算最小宽度）。 */
const FORMATION_SIDE_PADDING = 32;

/**
 * 编队带需要的最小画布宽度；0 表示任意宽度都放得下。
 *
 * 为什么画布要问编队带要宽度：任务画布的自然宽度只按**依赖列数**算
 * （layoutTeamWorkbenchTasks），与成员数无关。20~60 个成员时成员卡按 MEMBER_PITCH
 * 排开，宽度远超任务画布，卡片会被画布右缘裁掉（首卡甚至是负坐标）——
 * 「多派成员」在界面上直接看不到人。任务画布取 max(任务宽, 本函数) 即可。
 * 单人/单成员时不提要求，保持既有画布宽度（既有宽度断言也不受影响）。
 */
export function formationRequiredWidth(memberCount: number): number {
  // lead 独占一行，不参与成员排；只有成员排会横向撑开。
  const workers = Math.max(0, memberCount - 1);
  if (workers <= 1) return 0;
  return Math.ceil((workers - 1) * MEMBER_PITCH + MEMBER_SLOT_WIDTH + FORMATION_SIDE_PADDING);
}

/** 调色板名 → 强调色 class（真实取值在 native-theme.css 的 --formation-accent）。 */
function accentClass(accent: string): string {
  return `agent-teams-formation-accent--${ACCENTS.has(accent) ? accent : "gray"}`;
}

/** 成员工作态 → i18n key（动态键）。 */
function workStateKey(state: MemberWorkState): string {
  return `teams.memberState.${state}`;
}

/** 角色（agentType）→ 本地化词条键；无词条回退原文，绝不把 key 渲染到界面。 */
function roleLabel(role: string, t: (key: string) => string): string {
  const key = `teams.role.${role}`;
  const label = t(key);
  return label === key ? role : label;
}

/** 最紧急票态的徽标文案：failed 用独立 key，其余复用统计头已有的 key。 */
function urgencyLabelKey(urgency: TicketUrgency): string {
  return urgency === "failed" ? "teams.urgency.failed" : `teams.stats.${urgency}`;
}

function ModelChip({ model }: { model: string | null }) {
  if (!model) return null;
  return <span className="agent-teams-formation-model" title={model}>{model}</span>;
}

/** 成员在当前活动消息里的角色（发送方 / 接收方）。 */
export type ActiveMessageRole = "sender" | "recipient";

export interface ActiveMessageParticipants {
  senders: Set<string>;
  recipients: Set<string>;
}

/**
 * 从一条活动消息的 from/to/recipients 算出参与成员（按 member.id 收集）。
 * 广播（kind=broadcast 或 to="*"）且没有显式收件人时，除发送者外全员都是收件人。
 * 别名匹配复用 formation-layout 的 identityMatches，与飞线/通信流同口径。
 */
export function activeMessageParticipants(
  message: WorkbenchMessage | undefined,
  members: TeamWorkbenchSnapshot["members"],
): ActiveMessageParticipants {
  const senders = new Set<string>();
  const recipients = new Set<string>();
  if (!message) return { senders, recipients };

  for (const member of members) {
    if (identityMatches(member.id, member.name, message.from)) senders.add(member.id);
  }

  const broadcast = message.kind === "broadcast" || message.to === "*";
  const explicit = [message.to, ...(message.recipients ?? [])]
    .filter((identity) => Boolean(identity) && identity !== "*");

  for (const member of members) {
    if (senders.has(member.id)) continue;
    if (broadcast && explicit.length === 0) {
      recipients.add(member.id);
      continue;
    }
    if (explicit.some((identity) => identityMatches(member.id, member.name, identity))) {
      recipients.add(member.id);
    }
  }

  return { senders, recipients };
}

/**
 * 成员正在跑的票（**全部**，不只一张）。
 *
 * 布局层的 formation-layout 只给 `currentTicketId`（最近活动的那一张），这是
 * 「串行假象」的根源：一个成员同时跑 3 张票时，卡片上永远只有 1 张，看起来和
 * 只跑 1 张没区别。并发在这里从快照的 assignments 直接派生（status=running），
 * 纯读、不改布局层契约；卡片据此显示「×N」与完整票号清单的 title。
 */
export function runningTicketsByMember(snapshot: TeamWorkbenchSnapshot): Map<string, string[]> {
  const byMember = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  for (const ticket of snapshot.tickets) {
    for (const assignment of ticket.assignments) {
      if (assignment.status !== "running") continue;
      if (assignment.memberId === null) continue;
      let names = seen.get(assignment.memberId);
      if (!names) {
        names = new Set<string>();
        seen.set(assignment.memberId, names);
      }
      // 同一成员在同一张票上有多条 running 派活时，票只算一次（票是并发的单位）。
      if (names.has(ticket.id)) continue;
      names.add(ticket.id);
      const list = byMember.get(assignment.memberId);
      if (list) list.push(ticket.id);
      else byMember.set(assignment.memberId, [ticket.id]);
    }
  }
  return byMember;
}

/** 全队在跑的派活总数（并发度指标，含未落在名册成员上的 orphan 派活）。 */
export function runningAssignmentCount(tickets: TeamWorkbenchSnapshot["tickets"]): number {
  let count = 0;
  for (const ticket of tickets) {
    for (const assignment of ticket.assignments) {
      if (assignment.status === "running") count += 1;
    }
  }
  return count;
}

/** 忙闲徽标文案键与计数（#55 第一段，纯读展示）：running 优先于 pending。 */
function workloadBadge(entry: MemberWorkload, t: (key: string, params?: TranslationParams) => string): { kind: "idle" | "running" | "pending"; label: string } {
  const kind = workloadBadgeKind(entry);
  if (kind === "running") return { kind, label: t("teams.workload.running", { count: entry.runningCount }) };
  if (kind === "pending") return { kind, label: t("teams.workload.pending", { count: entry.pendingCount }) };
  return { kind, label: t("teams.workload.idle") };
}

function WorkloadPill({ workload }: { workload: MemberWorkload }) {
  const { t } = useI18n();
  const badge = workloadBadge(workload, t);
  // #55（忙闲可见，已拍板：自动感知+提示，改派/加人由用户一键确认）：名下派活
  // 的 running/pending 徽标；空闲者给「无积压」标——最闲的人必须一眼可见。
  return (
    <span
      className={`agent-teams-formation-workload agent-teams-formation-workload--${badge.kind}`}
      data-workload={badge.kind}
    >
      {badge.label}
    </span>
  );
}

function ProgressBar({ node }: { node: FormationMember }) {
  if (node.total === 0) return null;
  return (
    <span className="agent-teams-formation-progress-row">
      <span
        className="agent-teams-formation-progress"
        role="img"
        aria-label={`${node.completed}/${node.total}`}
      >
        {node.segments.map((segment) => (
          <span
            key={segment.urgency}
            className={`agent-teams-formation-seg agent-teams-formation-seg--${segment.urgency}`}
            style={{ flexGrow: segment.count }}
            data-segment={segment.urgency}
            data-count={segment.count}
          />
        ))}
      </span>
      {/* 需求2（信息展示全）：分段色条之外把「完成/总数」直接可见——数据本就
          在 FormationMember（completed/total），aria-label 只对读屏可见。 */}
      <span className="agent-teams-formation-progress-count" aria-hidden="true">
        {node.completed}/{node.total}
      </span>
    </span>
  );
}

/**
 * 成员卡（memo）：成员多（20~60）时，编队带每次因活动消息/排序变化重渲染都会
 * 重算所有卡片。memo 后只有本卡 props 变化才重渲染——高并发滑动时不再整排重绘。
 */
const MemberCard = memo(function MemberCard({
  node,
  workload,
  runningTicketIds,
  onSelect,
  activeRole,
}: {
  node: FormationMember;
  workload?: MemberWorkload;
  /** 该成员全部在跑的票（见 runningTicketsByMember）；空数组合法。 */
  runningTicketIds: readonly string[];
  onSelect: (member: FormationMember) => void;
  activeRole?: ActiveMessageRole;
}) {
  const { t } = useI18n();
  const { member, isLead } = node;
  const stateLabel = t(workStateKey(node.workState));
  const concurrent = runningTicketIds.length;
  const ticketTitle = concurrent > 0 ? runningTicketIds.map((id) => `#${id}`).join(", ") : undefined;
  const taskLine = node.currentTicketId
    ? node.blockedDependencyId
      ? { key: "teams.memberState.waitingDependency", params: { ticket: `#${node.blockedDependencyId}` } }
      : { key: "teams.memberState.executingTicket", params: { ticket: `#${node.currentTicketId}` } }
    : null;
  return (
    <article
      className={`agent-teams-formation-card ${isLead ? "agent-teams-formation-card--lead" : ""} ${accentClass(node.accent)}`}
      style={{ left: node.centerX - MEMBER_SLOT_WIDTH / 2, top: node.top, width: MEMBER_SLOT_WIDTH }}
      data-member-id={member.id}
      data-member-state={node.workState}
      data-urgency={node.urgency ?? undefined}
      data-active-message={activeRole}
      data-current-ticket={node.currentTicketId ?? undefined}
      data-blocked-dependency={node.blockedDependencyId ?? undefined}
      data-inbox-count={node.inboxCount}
      data-concurrent-tickets={concurrent}
    >
      <button
        type="button"
        className="agent-teams-formation-hit"
        onClick={() => onSelect(node)}
        aria-label={`${member.name} · ${stateLabel}${concurrent > 1 ? ` · ×${concurrent}` : ""}`}
      >
        <span className="agent-teams-formation-avatar" aria-hidden="true">{member.name.slice(0, 1)}</span>
        <span className="agent-teams-formation-identity" style={{ minWidth: 0 }}>
          <span className="agent-teams-formation-role">{roleLabel(member.role, t)}</span>
          {/* 长名不得撑破卡片：flex 子项必须 minWidth:0 才吃得住 ellipsis；
              overflowWrap 兜住没有空格的超长 id。title 给全名。 */}
          <span
            className="agent-teams-formation-name"
            style={{ minWidth: 0, overflowWrap: "anywhere" }}
            title={member.name}
          >
            {member.name}
          </span>
          {isLead && <span className="agent-teams-formation-lead-tag">{t("teams.leader")}</span>}
          <ModelChip model={member.model} />
        </span>
        <span className={`agent-teams-formation-state agent-teams-formation-state--${node.workState}`}>
          <span className="agent-teams-formation-state-dot" aria-hidden="true" />
          <span className="agent-teams-formation-state-label">{stateLabel}</span>
        </span>
        {(taskLine || node.inboxCount > 0) && (
          <span className="agent-teams-formation-taskline" style={{ minWidth: 0 }}>
            {taskLine && (
              <span
                className="agent-teams-formation-taskline-ticket"
                data-member-task={taskLine.key}
                title={ticketTitle}
                style={{ minWidth: 0 }}
              >
                {t(taskLine.key, taskLine.params)}
                {/* 并发事实必须写在卡上：同时跑 N 张票时显示 ×N，而不是只画第一张。 */}
                {concurrent > 1 ? ` ×${concurrent}` : ""}
              </span>
            )}
            {node.inboxCount > 0 && (
              <span className="agent-teams-formation-inbox" data-inbox={node.inboxCount}>
                {t("teams.memberState.inbox", { count: node.inboxCount })}
              </span>
            )}
          </span>
        )}
        {!isLead && <ProgressBar node={node} />}
        {(node.urgency || (!isLead && workload)) && (
          <span className="agent-teams-formation-meta-row">
            {!isLead && workload && <WorkloadPill workload={workload} />}
            {node.urgency && (
              <span className={`agent-teams-formation-badge agent-teams-formation-badge--${node.urgency}`}>
                {t(urgencyLabelKey(node.urgency))}
              </span>
            )}
          </span>
        )}
      </button>
    </article>
  );
});

interface Props {
  snapshot: TeamWorkbenchSnapshot;
  /** 画布宽度（与任务画布共用）；成员行据此居中。 */
  width: number;
  /** 点击成员卡（可选）：上层用它打开该成员会话。 */
  onSelectMember?: (memberId: string, sessionId: string | null) => void;
  /**
   * 当前要在编队总线上飞过的消息（上层维护队列，一次一条）。缺省 = 只画静态总线；
   * 跨泳道的消息流向不再在时间轴里画曲线（见 lib/agent-teams-flight.ts）。
   */
  activeMessageId?: string | null;
}

/**
 * 编队带（画布上半，y ∈ [0, 410]）：队长置顶居中、成员排下方，中间夹 lead bus 与
 * peer bus，填掉任务泳道上方的空白区（见 lib/agent-teams-formation-layout.ts）。
 * 成员默认按加入顺序（稳定不重排），可切换「按紧急度重排」；紧急度变化只改徽标。
 */
export const FormationBand = memo(function FormationBand({
  snapshot,
  width,
  onSelectMember,
  activeMessageId,
}: Props) {
  const { t } = useI18n();
  const layout = useMemo(() => layoutFormation(snapshot, width), [snapshot, width]);
  const [sortMode, setSortMode] = useState<"joined" | "urgency">("joined");
  // #55（忙闲可见）：从 tickets[].assignments[] 派生的名册成员忙闲计数（纯客户端，
  // 不依赖服务端投影改动）。无票成员也在这里得到「空闲」徽标——最闲的人必须可见。
  const workloads = useMemo(() => deriveMemberWorkloads(snapshot).byMemberId, [snapshot]);
  // 并发口径：每成员在跑的**全部**票 + 全队在跑的派活数（见两个纯函数）。
  const runningByMember = useMemo(() => runningTicketsByMember(snapshot), [snapshot]);
  const teamRunning = useMemo(() => runningAssignmentCount(snapshot.tickets), [snapshot.tickets]);

  const orderedWorkers = useMemo(() => {
    if (sortMode === "joined") return layout.workers;
    const sorted = sortWorkersByUrgency(layout.workers);
    const startX = layout.bus.firstWorkerX ?? 0;
    return sorted.map((node, index) => ({ ...node, centerX: startX + index * MEMBER_PITCH }));
  }, [layout, sortMode]);

  // useCallback：MemberCard 是 memo 的，回调一旦每次新建就整排失效。
  const handleSelect = useCallback((node: FormationMember) => {
    onSelectMember?.(node.member.id, node.member.sessionId);
  }, [onSelectMember]);

  const { lead, bus } = layout;
  const hasWorkers = orderedWorkers.length > 0;

  // 飞线只认当前显示位置：成员按紧急度重排后，路线必须跟着卡片走。
  const flightNodes = useMemo<FlightNode[]>(() => [
    ...(lead ? [{ id: lead.member.id, name: lead.member.name, centerX: lead.centerX, isLead: true }] : []),
    ...orderedWorkers.map((node) => ({
      id: node.member.id,
      name: node.member.name,
      centerX: node.centerX,
      isLead: false,
    })),
  ], [lead, orderedWorkers]);
  const activeMessage = activeMessageId
    ? (snapshot.messages ?? []).find((message) => message.id === activeMessageId)
    : undefined;
  const flights = useMemo(
    () => formationFlights(activeMessage, flightNodes),
    [activeMessage, flightNodes],
  );
  // 当前活动消息的发送方 / 接收方 → 成员卡高亮。与飞线共用同一条消息。
  const participants = useMemo(
    () => activeMessageParticipants(activeMessage, snapshot.members),
    [activeMessage, snapshot.members],
  );
  const activeRoleOf = (memberId: string): ActiveMessageRole | undefined => {
    if (participants.senders.has(memberId)) return "sender";
    if (participants.recipients.has(memberId)) return "recipient";
    return undefined;
  };

  return (
    <div
      className="agent-teams-formation"
      style={{ width, height: FORMATION_BOTTOM }}
      data-testid="agent-teams-formation"
      data-members={snapshot.members.length}
      data-running-assignments={teamRunning}
    >
      <span
        className="agent-teams-formation-title"
        style={{ left: FORMATION_TITLE_X, top: FORMATION_TITLE_Y, whiteSpace: "nowrap" }}
      >
        {t("teams.formation.title")}
        {/* 全队同时在跑的派活数：并发是这一屏最重要的读数，不该只能靠数卡片。 */}
        {teamRunning > 0 && (
          <span
            className="agent-teams-formation-inbox"
            data-testid="agent-teams-formation-running"
            style={{ marginLeft: 8, color: "var(--info)" }}
          >
            {t("teams.workload.running", { count: teamRunning })}
          </span>
        )}
      </span>
      {orderedWorkers.length > 1 && (
        <button
          type="button"
          className="agent-teams-formation-sort"
          aria-pressed={sortMode === "urgency"}
          onClick={() => setSortMode((mode) => (mode === "joined" ? "urgency" : "joined"))}
        >
          {t("teams.formation.sortByUrgency")}
        </button>
      )}

      <svg className="agent-teams-formation-buses" width={width} height={FORMATION_BOTTOM} aria-hidden="true">
        {lead && hasWorkers && bus.leadX !== null && (
          <g data-channel="lead">
            <path className="agent-teams-formation-bus" d={`M ${bus.leadX} ${LEAD_FOOT} L ${bus.leadX} ${LEAD_BUS_Y}`} />
            <path
              className="agent-teams-formation-bus"
              d={`M ${bus.firstWorkerX} ${LEAD_BUS_Y} L ${bus.lastWorkerX} ${LEAD_BUS_Y}`}
            />
            {orderedWorkers.map((node) => (
              <path
                key={node.member.id}
                className="agent-teams-formation-bus"
                d={`M ${node.centerX} ${LEAD_BUS_Y} L ${node.centerX} ${MEMBER_TOP}`}
              />
            ))}
          </g>
        )}
        {orderedWorkers.length === 1 && bus.firstWorkerX !== null && (
          <path
            className="agent-teams-formation-bus"
            d={`M ${bus.firstWorkerX} ${MEMBER_FOOT} L ${bus.firstWorkerX} ${PEER_BUS_Y}`}
          />
        )}
        {orderedWorkers.length > 1 && bus.firstWorkerX !== null && bus.lastWorkerX !== null && (
          <g data-channel="peer">
            <path
              className="agent-teams-formation-bus"
              d={`M ${bus.firstWorkerX} ${MEMBER_FOOT} L ${bus.firstWorkerX} ${PEER_BUS_Y} L ${bus.lastWorkerX} ${PEER_BUS_Y} L ${bus.lastWorkerX} ${MEMBER_FOOT}`}
            />
            {orderedWorkers.slice(1, -1).map((node) => (
              <path
                key={node.member.id}
                className="agent-teams-formation-bus"
                d={`M ${node.centerX} ${MEMBER_FOOT} L ${node.centerX} ${PEER_BUS_Y}`}
              />
            ))}
          </g>
        )}
        {flights.map((flight) => (
          <path
            key={flight.key}
            data-testid="agent-teams-formation-flight"
            data-flight-channel={flight.channel}
            data-flight-tone={flight.tone}
            className="agent-teams-formation-flight"
            d={flight.d}
          />
        ))}
      </svg>

      {flights.map((flight) => (
        <span
          key={`${flight.key}-chip`}
          className={`agent-teams-formation-flight-chip agent-teams-formation-flight-chip--${flight.tone}`}
          style={{ left: flight.chipX, top: flight.chipY }}
        >
          {t(flight.labelKey)}
        </span>
      ))}

      {lead && (
        <MemberCard
          node={lead}
          runningTicketIds={runningByMember.get(lead.member.id) ?? EMPTY_TICKET_IDS}
          onSelect={handleSelect}
          activeRole={activeRoleOf(lead.member.id)}
        />
      )}
      {orderedWorkers.map((node) => (
        <MemberCard
          key={node.member.id}
          node={node}
          workload={workloads.get(node.member.id)}
          runningTicketIds={runningByMember.get(node.member.id) ?? EMPTY_TICKET_IDS}
          onSelect={handleSelect}
          activeRole={activeRoleOf(node.member.id)}
        />
      ))}
    </div>
  );
});
