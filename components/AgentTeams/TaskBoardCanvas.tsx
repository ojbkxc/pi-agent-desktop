"use client";

import { useMemo, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  TASK_HEIGHT,
  TASK_WIDTH,
  getTicketUrgency,
  layoutTeamWorkbenchTasks,
  type PositionedTeamTask,
  type TicketUrgency,
} from "@/lib/agent-teams-task-layout";
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
}

/**
 * 共享任务列表画布（Agent Teams 页任务区）：上半区是编队带（formation 槽位），
 * 下半区按依赖深度分层，每层一条竖向泳道自左向右排列（根任务 → 中间层 → 收尾）。
 * 泳道底板与依赖连线画在同一个 SVG 里、且底板在连线之前，连线才不会被底板遮挡。
 */
export function TaskBoardCanvas({ snapshot, requestedWidth = 0, formation }: Props) {
  const { t } = useI18n();
  const layout = useMemo(
    () => layoutTeamWorkbenchTasks(snapshot, requestedWidth),
    [snapshot, requestedWidth],
  );
  const membersById = useMemo(
    () => new Map(snapshot.members.map((member) => [member.id, member.name])),
    [snapshot.members],
  );

  if (snapshot.tickets.length === 0) {
    return <p className="scheduled-hint agent-teams-board-empty">{t("teams.emptyTasks")}</p>;
  }

  const maxDepth = Math.max(0, ...layout.lanes.map((lane) => lane.depth));
  const positionedById = new Map(layout.tasks.map((task) => [task.ticket.id, task]));
  const edges = layout.tasks.flatMap((to) => to.ticket.dependencies.flatMap((dependencyId) => {
    const from = positionedById.get(dependencyId);
    if (!from) return [];
    return [{
      key: `${dependencyId}->${to.ticket.id}`,
      path: dependencyPath(from, to),
      satisfied: from.ticket.status === "ended",
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
            return (
              <article
                key={ticket.id}
                className={`agent-teams-board-task ${taskToneClass(task.urgency)}${task.cycleId === null ? "" : " agent-teams-board-task--cycle"}`}
                data-state={task.urgency}
                data-cycle={task.cycleId === null ? undefined : task.cycleId}
                style={{ left: task.x, top: task.y, width: TASK_WIDTH, height: TASK_HEIGHT }}
              >
                <span className="agent-teams-board-task-head">
                  <span className="agent-teams-board-task-id">#{ticket.id}</span>
                  <span className="agent-teams-board-task-dot" aria-hidden="true" />
                </span>
                <span className="agent-teams-board-task-subject" title={ticket.subject}>{ticket.subject}</span>
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
    </>
  );
}
