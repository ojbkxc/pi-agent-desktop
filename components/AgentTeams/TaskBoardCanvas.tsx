"use client";

import { useMemo } from "react";
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
 * `in_progress` 是保留给旧调用方的别名，恒等于 `running`（同一状态两种命名）。
 */
export interface TaskUrgencyCounts extends Record<TicketUrgency, number> {
  /** @deprecated 旧命名；与 `running` 同值，新代码请读 `running`。 */
  in_progress: number;
}

export function countTaskStates(tickets: WorkbenchTicket[]): TaskUrgencyCounts {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const counts: TaskUrgencyCounts = {
    failed: 0,
    blocked: 0,
    available: 0,
    running: 0,
    completed: 0,
    in_progress: 0,
  };
  for (const ticket of tickets) {
    const urgency = getTicketUrgency(ticket, byId);
    counts[urgency] += 1;
    if (urgency === "running") counts.in_progress += 1;
  }
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
}

/**
 * 共享任务列表画布（Agent Teams 页任务区）：按依赖深度分层，每层一条竖向
 * 泳道自左向右排列（根任务 → 中间层 → 收尾），任务卡片按状态着色，SVG
 * 贝塞尔曲线连接依赖。可横向滚动，尺寸由纯布局引擎给出。
 */
export function TaskBoardCanvas({ snapshot }: Props) {
  const { t } = useI18n();
  const layout = useMemo(() => layoutTeamWorkbenchTasks(snapshot), [snapshot]);
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
        <svg className="agent-teams-board-edges" width={layout.width} height={layout.height} aria-hidden="true">
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
