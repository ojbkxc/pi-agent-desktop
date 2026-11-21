"use client";

import { memo, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  DEPTH_COLUMN_TOP,
  HORIZONTAL_PADDING,
  TASK_HEIGHT,
  TASK_WIDTH,
  getTicketUrgency,
  layoutTeamWorkbenchTasks,
  type PositionedTeamTask,
  type TicketUrgency,
} from "@/lib/agent-teams-task-layout";
import { dependencyChain } from "@/lib/agent-teams-dependency-focus";
import { ticketProgress, ticketStalled } from "@/lib/agent-teams-task-progress";
import type { TeamWorkbenchSnapshot, WorkbenchTicket } from "@/lib/agent-teams-swimlane";

/**
 * 任务卡片的视觉色调：引擎单一紧急度口径（failed 覆盖 completed）。
 * 「等你确认」在 pi 侧没有独立状态，available（可认领）用 warning 提示待认领。
 */
export type TaskTone = TicketUrgency;

/**
 * 任务 → CSS 类后缀。urgency 已经蕴含 failed/in_progress 归一，直接派生 class，
 * 不再由画布二次判定，避免与统计头口径分叉。
 */
export function taskToneClass(urgency: TicketUrgency): string {
  return `agent-teams-board-task--${urgency}`;
}

/**
 * 泳道标题 key：depth 0 是根任务，最深层是收尾，中间层按 1 基序号显示。
 * 只有一层时根任务优先（与 cc-haha 一致）。
 */
export function laneTitleKey(depth: number, maxDepth: number): string {
  if (depth === 0) return "teams.boardRoot";
  if (depth === maxDepth) return "teams.boardWrapUp";
  return "teams.boardLayer";
}

/**
 * 五态紧急度计数（互斥），口径与 getTicketUrgency 完全一致；统计头直接复用。
 */
export function countTaskStates(tickets: WorkbenchTicket[]): Record<TicketUrgency, number> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const counts: Record<TicketUrgency, number> = {
    failed: 0,
    blocked: 0,
    available: 0,
    running: 0,
    completed: 0,
  };
  for (const ticket of tickets) counts[getTicketUrgency(ticket, byId)] += 1;
  return counts;
}

/**
 * 依赖连线：从依赖任务右缘到被依赖任务左缘的三次贝塞尔曲线。
 * 依赖总在更浅的层（更左），因此曲线始终向右流动。
 */
export function dependencyPath(
  from: Pick<PositionedTeamTask, "x" | "y">,
  to: Pick<PositionedTeamTask, "x" | "y">,
): string {
  const fromX = from.x + TASK_WIDTH;
  const fromY = from.y + TASK_HEIGHT / 2;
  const toX = to.x;
  const toY = to.y + TASK_HEIGHT / 2;
  const middle = fromX + (toX - fromX) / 2;
  return `M ${fromX} ${fromY} C ${middle} ${fromY}, ${middle} ${toY}, ${toX} ${toY}`;
}

interface Props {
  snapshot: TeamWorkbenchSnapshot;
  /** 画布至少占满的宽度（容器宽 / 编队带自然宽）；缺省按任务自然宽。 */
  requestedWidth?: number;
  /**
   * 编队带槽位：收到本画布实际宽度后返回要铺在上半区（y 0..410）的节点。
   * 编队带必须与任务泳道共用同一宽度与滚动容器，才真正填掉泳道上方那片空白。
   */
  formation?: (width: number) => ReactNode;
  /**
   * 点击任务卡（可选）：上层用它打开任务详情抽屉。传了才把卡片变成可聚焦的按钮，
   * 未传时保持原样（指针/键盘语义不变，既有渲染断言不受影响）。
   */
  onSelectTask?: (ticketId: string) => void;
  /**
   * 外部聚焦票（可选）：与画布内部的 hovered/键盘焦点合并，优先级
   * hovered ?? focused ?? 本 prop。命中依赖链的任务卡与连线高亮，链外变暗。
   */
  focusedTicketId?: string | null;
  /**
   * 上一帧快照（可选）：用来判定「刚解锁」——上一帧 urgency=blocked、本帧
   * available 的任务卡会短暂高亮。
   */
  previousSnapshot?: TeamWorkbenchSnapshot;
}

/** 底部图例六项（key 供 data 属性 / CSS，labelKey 由 i18n 渲染）。 */
const LEGEND_ITEMS: ReadonlyArray<{ key: string; labelKey: string }> = [
  { key: "unmet", labelKey: "teams.legend.unmet" },
  { key: "satisfied", labelKey: "teams.legend.satisfied" },
  { key: "running", labelKey: "teams.legend.running" },
  { key: "failed", labelKey: "teams.legend.failed" },
  { key: "cycle", labelKey: "teams.legend.cycle" },
  { key: "flight", labelKey: "teams.legend.flight" },
];

/**
 * 共享任务列表画布（Agent Teams 页任务区）：上半区是编队带（formation 槽位），
 * 下半区按依赖深度分层，每层一条竖向泳道自左向右排列（根任务 → 中间层 → 收尾）。
 * 泳道底板与依赖连线画在同一个 SVG 里、且底板在连线之前，连线才不会被底板遮挡。
 */
export const TaskBoardCanvas = memo(function TaskBoardCanvas({
  snapshot,
  requestedWidth = 0,
  formation,
  onSelectTask,
  focusedTicketId = null,
  previousSnapshot,
}: Props) {
  const { t } = useI18n();
  const [hoveredTicketId, setHoveredTicketId] = useState<string | null>(null);
  const [keyboardFocusId, setKeyboardFocusId] = useState<string | null>(null);
  // 合并优先级：鼠标悬停 ?? 键盘焦点 ?? 外部传入。都没有则整张画布不做链路滤镜。
  const effectiveFocus = hoveredTicketId ?? keyboardFocusId ?? focusedTicketId;
  const chain = useMemo(
    () => (effectiveFocus ? dependencyChain(snapshot.tickets, effectiveFocus) : null),
    [snapshot.tickets, effectiveFocus],
  );
  const layout = useMemo(
    () => layoutTeamWorkbenchTasks(snapshot, requestedWidth),
    [snapshot, requestedWidth],
  );
  const membersById = useMemo(
    () => new Map(snapshot.members.map((member) => [member.id, member.name])),
    [snapshot.members],
  );
  // 本帧 / 上一帧的 urgency 口径（同一真源）用于「刚解锁」判定。
  const urgencyNowById = useMemo(() => {
    const byId = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket]));
    return new Map(snapshot.tickets.map((ticket) => [ticket.id, getTicketUrgency(ticket, byId)]));
  }, [snapshot.tickets]);
  const urgencyBeforeById = useMemo(() => {
    if (!previousSnapshot) return null;
    const byId = new Map(previousSnapshot.tickets.map((ticket) => [ticket.id, ticket]));
    return new Map(
      previousSnapshot.tickets.map((ticket) => [ticket.id, getTicketUrgency(ticket, byId)]),
    );
  }, [previousSnapshot]);

  /** 卡片在链路里的状态：null=无 focus；true=链内；false=链外。 */
  const chainState = (ticketId: string): boolean | null => {
    if (!chain) return null;
    return chain.has(ticketId);
  };

  if (snapshot.tickets.length === 0) {
    // 编队带展示的是「成员」，与票无关：成员已 spawn 但还没建票的团队也应看到编队带。
    // 只有传了 formation 槽位时才铺画布，否则退回纯空态提示。
    //
    // 文案分两档：团队还没结束 → 「负责人拆解工作后任务会出现在这里」；已经结束
    // （成员都已停下）→ 说实话：这个团队从未用过 team_plan / team_ticket，任务列表
    // 因此是空的。team_create 直接派活是合法且常见的用法，空画布不该让用户以为坏了。
    const settled = snapshot.team.status === "completed" || snapshot.team.status === "ended";
    const emptyText = settled ? t("teams.emptyTasksSettled") : t("teams.emptyTasks");
    if (!formation) {
      return <p className="scheduled-hint agent-teams-board-empty">{emptyText}</p>;
    }
    return (
      <div className="agent-teams-board-scroll">
        <div className="agent-teams-board" style={{ width: layout.width, minWidth: layout.width, height: layout.height }}>
          {formation(layout.width)}
          <p
            className="scheduled-hint agent-teams-board-empty"
            style={{ position: "absolute", top: DEPTH_COLUMN_TOP + 8, left: HORIZONTAL_PADDING }}
          >
            {emptyText}
          </p>
        </div>
      </div>
    );
  }

  const maxDepth = Math.max(0, ...layout.lanes.map((lane) => lane.depth));
  const positionedById = new Map(layout.tasks.map((task) => [task.ticket.id, task]));
  const edges = layout.tasks.flatMap((to) => to.ticket.dependencies.flatMap((dependencyId) => {
    const from = positionedById.get(dependencyId);
    if (!from) return [];
    const inChain = chain !== null && chain.has(dependencyId) && chain.has(to.ticket.id);
    return [{
      key: `${dependencyId}->${to.ticket.id}`,
      path: dependencyPath(from, to),
      satisfied: from.ticket.status === "ended",
      chainActive: chain !== null && inChain,
      chainDimmed: chain !== null && !inChain,
    }];
  }));

  return (
    <>
      {layout.hasCycle && (
        <p className="agent-teams-board-cycle-warning" role="status">{t("teams.cycleWarning")}</p>
      )}
      <div className="agent-teams-board-scroll">
        <div className="agent-teams-board" style={{ width: layout.width, minWidth: layout.width, height: layout.height }}>
          {formation?.(layout.width)}

          <svg className="agent-teams-board-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {/* 泳道底板画在依赖连线之前 —— 与上游一致，连线压在上面不会被遮住。 */}
            {layout.lanes.map((lane, index) => (
              <g key={`plate-${lane.depth}`} className="agent-teams-board-plate">
                <rect
                  x={lane.x}
                  y={lane.y}
                  width={lane.width}
                  height={lane.height}
                  rx={12}
                  fill={index % 2 === 0 ? "var(--surface)" : "var(--bg-hover)"}
                  fillOpacity={0.62}
                  stroke="var(--separator)"
                />
                <line
                  x1={lane.x + 12}
                  y1={lane.y + 26}
                  x2={lane.x + lane.width - 12}
                  y2={lane.y + 26}
                  stroke="var(--separator)"
                />
              </g>
            ))}
            {edges.map((edge) => (
              <path
                key={edge.key}
                className={`agent-teams-board-edge${edge.satisfied ? " agent-teams-board-edge--done" : ""}`}
                d={edge.path}
                data-chain-active={edge.chainActive ? "true" : undefined}
                data-chain-dimmed={edge.chainDimmed ? "true" : undefined}
              />
            ))}
          </svg>

          {layout.lanes.map((lane) => {
            const completed = layout.tasks.filter((task) => task.depth === lane.depth && task.urgency === "completed").length;
            const titleKey = laneTitleKey(lane.depth, maxDepth);
            return (
              <div
                key={lane.depth}
                className="agent-teams-board-lane"
                style={{ left: lane.x, top: lane.y, width: lane.width, height: lane.height }}
              >
                <div className="agent-teams-board-lane-head">
                  <span className="agent-teams-board-lane-title">
                    {titleKey === "teams.boardLayer" ? t(titleKey, { layer: lane.depth + 1 }) : t(titleKey)}
                  </span>
                  <span className="agent-teams-board-lane-count">
                    {t("teams.boardCompleted", { completed, total: lane.count })}
                  </span>
                </div>
              </div>
            );
          })}

          {layout.tasks.map((task) => {
            const { ticket } = task;
            const ownerName = ticket.ownerId
              ? membersById.get(ticket.ownerId) ?? ticket.ownerId
              : t("teams.unassigned");
            const progress = ticketProgress(ticket);
            const stalled = ticketStalled(ticket, snapshot.members);
            const inChain = chainState(ticket.id);
            // 上一帧 blocked、本帧 available → 刚解锁。
            const justUnlocked = urgencyBeforeById?.get(ticket.id) === "blocked"
              && urgencyNowById.get(ticket.id) === "available";
            const classNames = [
              "agent-teams-board-task",
              taskToneClass(task.urgency),
              task.cycleId === null ? "" : "agent-teams-board-task--cycle",
              justUnlocked ? "agent-teams-board-task--unlocked" : "",
            ].filter(Boolean).join(" ");
            return (
              <article
                key={ticket.id}
                className={classNames}
                data-state={task.urgency}
                data-ticket-id={ticket.id}
                data-cycle={task.cycleId === null ? undefined : task.cycleId}
                data-chain-active={inChain ? "true" : undefined}
                data-chain-dimmed={inChain === false ? "true" : undefined}
                data-just-unlocked={justUnlocked ? "true" : undefined}
                role={onSelectTask ? "button" : undefined}
                tabIndex={onSelectTask ? 0 : undefined}
                onClick={onSelectTask ? () => onSelectTask(ticket.id) : undefined}
                onMouseEnter={() => setHoveredTicketId(ticket.id)}
                onMouseLeave={() => setHoveredTicketId((current) => (current === ticket.id ? null : current))}
                onFocus={() => setKeyboardFocusId(ticket.id)}
                onBlur={() => setKeyboardFocusId((current) => (current === ticket.id ? null : current))}
                onKeyDown={onSelectTask ? (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelectTask(ticket.id);
                } : undefined}
                style={{ left: task.x, top: task.y, width: TASK_WIDTH, height: TASK_HEIGHT, cursor: onSelectTask ? "pointer" : undefined }}
              >
                <span className="agent-teams-board-task-head">
                  <span className="agent-teams-board-task-id">#{ticket.id}</span>
                  {stalled && (
                    <span
                      className="agent-teams-board-task-stalled"
                      data-stalled="true"
                      role="img"
                      title={t("teams.task.stalledOwner")}
                      aria-label={t("teams.task.stalledOwner")}
                    />
                  )}
                  <span className="agent-teams-board-task-dot" aria-hidden="true" />
                </span>
                <span className="agent-teams-board-task-subject" title={ticket.subject}>{ticket.subject}</span>
                {progress.mode !== "none" && (
                  <span
                    className="agent-teams-board-task-progress"
                    data-progress={progress.mode}
                    data-percent={progress.mode === "determinate" ? progress.percent : undefined}
                  >
                    {progress.mode === "determinate" && (
                      <span
                        className="agent-teams-board-task-progress-fill"
                        style={{ width: `${progress.percent}%` }}
                      />
                    )}
                  </span>
                )}
                <span className="agent-teams-board-task-foot">
                  <span className="agent-teams-board-task-avatar" aria-hidden="true">{ownerName.slice(0, 1)}</span>
                  <span className="agent-teams-board-task-owner">{ownerName}</span>
                  {ticket.dependencies.length > 0 && (
                    <span
                      className="agent-teams-board-task-deps"
                      title={t("teams.dependsOn", { deps: ticket.dependencies.join(", ") })}
                    >
                      {t("teams.boardBlockedBadge", { count: ticket.dependencies.length })}
                    </span>
                  )}
                </span>
              </article>
            );
          })}
        </div>
      </div>

      <div data-testid="agent-teams-legend" className="agent-teams-legend">
        {LEGEND_ITEMS.map((item) => (
          <span key={item.key} className="agent-teams-legend-item" data-legend={item.key}>
            <span className="agent-teams-legend-swatch" aria-hidden="true" />
            {t(item.labelKey)}
          </span>
        ))}
      </div>
    </>
  );
});
