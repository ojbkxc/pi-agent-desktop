/**
 * 共享任务列表布局（依赖深度泳道）——移植自 cc-haha agentTeamsModel。
 *
 * 输入 projectTeamWorkbench() 产出的 TeamWorkbenchSnapshot（只读 tickets[]），
 * 输出可直接渲染的画布坐标：depth 0 为无依赖的根任务，每层一条竖向泳道
 * 自左向右排列，层内任务按 id 稳定排序后纵向堆叠。
 *
 * 纯函数、零副作用：不 import node:fs，客户端组件与服务端路由都能安全 import。
 */

import type { TeamWorkbenchSnapshot, WorkbenchTicket } from "./agent-teams-swimlane";

/** 泳道画布尺寸常量（与 cc-haha 取值一致）。 */
export const LANE_WIDTH = 216;
export const LANE_GAP = 20;
export const TASK_WIDTH = 200;
export const TASK_HEIGHT = 92;
export const HORIZONTAL_PADDING = 32;
export const LANE_TOP = 410;
export const TASK_TOP = 442;
export const ROW_GAP = 14;
export const CANVAS_BOTTOM_PADDING = 46;

/**
 * 任务在画布上的语义状态：
 * - completed：票已 ended；
 * - in_progress：存在 running 的派活；
 * - blocked：仍有未 ended 的依赖票；
 * - available：无未完成依赖，等待认领。
 */
export type TeamTaskState = "completed" | "in_progress" | "blocked" | "available";

export interface TeamTaskLane {
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface PositionedTeamTask {
  ticket: WorkbenchTicket;
  state: TeamTaskState;
  depth: number;
  row: number;
  x: number;
  y: number;
}

export interface TeamTaskLayout {
  lanes: TeamTaskLane[];
  tasks: PositionedTeamTask[];
  width: number;
  height: number;
}

const TICKET_ID_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

/** 自然序（t2 排在 t10 前）排序任务 id；collator 平局时按原始字符串兜底。 */
function compareTicketIds(left: string, right: string): number {
  const naturalOrder = TICKET_ID_COLLATOR.compare(left, right);
  if (naturalOrder !== 0) return naturalOrder;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 任务状态推导（pi 口径）：
 * ended → completed；有 running 派活 → in_progress；依赖里存在未 ended 的票 →
 * blocked；其余 available。已从任务列表消失的依赖视为已解除（与 cc-haha 一致）。
 */
export function getTeamTaskState(
  ticket: WorkbenchTicket,
  ticketsById: Map<string, WorkbenchTicket>,
): TeamTaskState {
  if (ticket.status === "ended") return "completed";
  if (ticket.assignments.some((assignment) => assignment.status === "running")) {
    return "in_progress";
  }
  const blocked = ticket.dependencies.some((dependencyId) => {
    const dependency = ticketsById.get(dependencyId);
    return dependency !== undefined && dependency.status !== "ended";
  });
  return blocked ? "blocked" : "available";
}

/**
 * 最长依赖路径深度。缺失依赖忽略；依赖环在回边处截断为 0，保证递归终止
 * （与 cc-haha taskDepths 行为一致）。
 */
function ticketDepths(tickets: WorkbenchTicket[]): Map<string, number> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (ticketId: string): number => {
    const cached = depths.get(ticketId);
    if (cached !== undefined) return cached;
    if (visiting.has(ticketId)) return 0;
    const ticket = byId.get(ticketId);
    if (!ticket) return 0;

    visiting.add(ticketId);
    const dependencies = ticket.dependencies
      .filter((dependencyId) => byId.has(dependencyId))
      .sort(compareTicketIds);
    const depth = dependencies.length === 0
      ? 0
      : 1 + Math.max(...dependencies.map(depthOf));
    visiting.delete(ticketId);
    depths.set(ticketId, depth);
    return depth;
  };

  for (const ticket of tickets) depthOf(ticket.id);
  return depths;
}

/**
 * 纯布局：按依赖深度分层，每层一条泳道自左向右，层内任务纵向堆叠。
 *
 * @param snapshot 只读取 tickets[]。
 * @param requestedWidth 画布至少占满的宽度（容器宽度）；自然宽度更大时以自然宽度为准，
 *   并在水平方向居中泳道。非有限值按 0 处理。
 */
export function layoutTeamWorkbenchTasks(
  snapshot: TeamWorkbenchSnapshot,
  requestedWidth = 0,
): TeamTaskLayout {
  // 稳定排序：id 自然序优先，同 id 保留输入顺序（Array.prototype.sort 稳定）。
  const sortedTickets = [...snapshot.tickets].sort((left, right) => (
    compareTicketIds(left.id, right.id)
  ));
  const depths = ticketDepths(sortedTickets);
  const byLayer = new Map<number, WorkbenchTicket[]>();

  for (const ticket of sortedTickets) {
    const depth = depths.get(ticket.id) ?? 0;
    const layer = byLayer.get(depth);
    if (layer) layer.push(ticket);
    else byLayer.set(depth, [ticket]);
  }

  const columns = sortedTickets.length === 0
    ? 0
    : Math.max(...Array.from(depths.values())) + 1;
  const naturalWidth = HORIZONTAL_PADDING * 2
    + columns * LANE_WIDTH
    + Math.max(0, columns - 1) * LANE_GAP;
  const minimumWidth = Number.isFinite(requestedWidth)
    ? Math.max(0, Math.round(requestedWidth))
    : 0;
  const width = Math.max(naturalWidth, minimumWidth);
  const startX = (width - naturalWidth) / 2 + HORIZONTAL_PADDING;
  const maxRows = Math.max(0, ...Array.from(byLayer.values(), (layer) => layer.length));
  const taskStackHeight = maxRows === 0
    ? 0
    : maxRows * TASK_HEIGHT + (maxRows - 1) * ROW_GAP;
  const laneHeight = (TASK_TOP - LANE_TOP) * 2 + taskStackHeight;
  const lanes: TeamTaskLane[] = Array.from({ length: columns }, (_, depth) => ({
    depth,
    x: startX + depth * (LANE_WIDTH + LANE_GAP),
    y: LANE_TOP,
    width: LANE_WIDTH,
    height: laneHeight,
    count: byLayer.get(depth)?.length ?? 0,
  }));

  const ticketsById = new Map(sortedTickets.map((ticket) => [ticket.id, ticket]));
  const positioned: PositionedTeamTask[] = [];
  for (const lane of lanes) {
    const layer = byLayer.get(lane.depth) ?? [];
    layer.forEach((ticket, row) => {
      positioned.push({
        ticket,
        state: getTeamTaskState(ticket, ticketsById),
        depth: lane.depth,
        row,
        x: lane.x + (LANE_WIDTH - TASK_WIDTH) / 2,
        y: TASK_TOP + row * (TASK_HEIGHT + ROW_GAP),
      });
    });
  }

  return {
    lanes,
    tasks: positioned,
    width,
    height: LANE_TOP + laneHeight + CANVAS_BOTTOM_PADDING,
  };
}
