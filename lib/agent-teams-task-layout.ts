/**
 * 共享任务列表布局（依赖深度泳道）——移植自 cc-haha agentTeamsModel。
 *
 * 输入 projectTeamWorkbench() 产出的 TeamWorkbenchSnapshot（只读 tickets[]），
 * 输出可直接渲染的画布坐标：depth 0 为无依赖的根任务，每层一条竖向泳道
 * 自左向右排列，层内任务按 createdAt 追加式堆叠（新票永远落在末尾）。
 *
 * 环处理：先用 Tarjan 缩点把依赖环坍缩成一个分量，再在缩点后的 DAG 上求最长
 * 路径深度。这样环不再被回边截断成幻影深度，也不会凭空多出 count=0 的空泳道；
 * 环内票共享同一个 cycleId，画布据此加可辨识样式。
 *
 * 纯函数、零副作用：不 import node:fs，客户端组件与服务端路由都能安全 import。
 */

import type { TeamWorkbenchSnapshot, WorkbenchTicket } from "./agent-teams-swimlane";

/** 深度泳道画布尺寸常量（与 cc-haha 取值一致）。 */
export const DEPTH_COLUMN_WIDTH = 216;
export const DEPTH_COLUMN_GAP = 20;
export const TASK_WIDTH = 200;
export const TASK_HEIGHT = 92;
export const HORIZONTAL_PADDING = 32;
export const DEPTH_COLUMN_TOP = 410;
export const TASK_TOP = 442;
export const ROW_GAP = 14;
export const CANVAS_BOTTOM_PADDING = 46;

/** 一条泳道上下内边距之和（与行数无关的固定部分）。 */
const BASE_DEPTH_COLUMN_HEIGHT = (TASK_TOP - DEPTH_COLUMN_TOP) * 2;

/**
 * 任务在画布上的语义状态：
 * - completed：票已 ended；
 * - in_progress：存在 running 的派活；
 * - blocked：仍有未 ended 的依赖票；
 * - assigned：**已派活但成员还没开工**（存在 pending 派活）。
 * - available：无未完成依赖，且**没人认领**，等待认领。
 *
 * assigned 与 available 必须分开：旧口径把「已派未开工」也归进 available，
 * 而 available 的界面文案是「可认领」——但成员侧根本没有 claim 工具
 * （`team_ticket` 的 11 个 operation 里无 claim），所以那是假承诺。
 * 分开之后「可认领」只剩真正无人负责的票。
 */
export type TeamTaskState = "completed" | "in_progress" | "blocked" | "assigned" | "available";

/**
 * 展示层的紧急度口径——唯一真源，在 TeamTaskState 之上叠加「派活失败」：
 * failed > blocked > assigned > available > running > completed（顺序即优先级）。
 * failed 只在票已 ended 且存在 outcome=failed 的派活时出现；in_progress 映射为
 * running（与 CSS 后缀 `--running` 对齐）。
 *
 * assigned 排在 blocked 之后、available 之前：它是个「停滸信号」——活已经派给人了、
 * 但那人没开工，lead 应该去摧一下；比无人认领的 backlog 更该被看见。
 */
export type TicketUrgency = "failed" | "blocked" | "assigned" | "available" | "running" | "completed";

/** 顺序即优先级（最紧急在前）；排序/择优时按此数组下标判定。 */
export const URGENCY_ORDER: readonly TicketUrgency[] = [
  "failed",
  "blocked",
  "assigned",
  "available",
  "running",
  "completed",
];

/** 数值越大越紧急；由 URGENCY_ORDER 语义派生，便于比较与排序。 */
export const URGENCY_WEIGHT: Record<TicketUrgency, number> = {
  failed: 6,
  blocked: 5,
  assigned: 4,
  available: 3,
  running: 2,
  completed: 1,
};

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
  /** 唯一状态真源：见 getTicketUrgency。 */
  urgency: TicketUrgency;
  depth: number;
  row: number;
  /** 依赖环编号（同一环内所有票共享）；不在环内为 null。 */
  cycleId: number | null;
  x: number;
  y: number;
}

/**
 * 一条「指向不存在任务」的依赖边。
 *
 * 典型成因：plan 里的任务被删除/改 id 后，别的任务还指着旧 id；或手写 plan.json 拼错。
 * 现状是 fail-open（缺失依赖视为已解除），于是拼错会被静默放行——任务看起来「可开工」，
 * 实际前置根本没做过。这里只负责**报出来**，不改变 fail-open 语义：
 * 改成 fail-closed 会让一条拼错的依赖永久锁死整条下游链，比静默更坑。
 */
export interface DanglingDependency {
  /** 拥有这条依赖的任务 id。 */
  ticketId: string;
  /** 指向不存在的那个依赖 id。 */
  dependencyId: string;
}

export interface TeamTaskLayout {
  lanes: TeamTaskLane[];
  tasks: PositionedTeamTask[];
  width: number;
  height: number;
  /** 是否存在依赖环（供画布渲染告警）。 */
  hasCycle: boolean;
  /** 指向不存在任务的依赖边（供画布渲染告警）。按 (ticketId, dependencyId) 自然序稳定排序。 */
  danglingDependencies: DanglingDependency[];
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

/** 泳道内追加式排序：createdAt 升序（缺省视为最早），同值回退 id 自然序。 */
function compareTicketsForAppend(left: WorkbenchTicket, right: WorkbenchTicket): number {
  const leftAt = left.createdAt ?? "";
  const rightAt = right.createdAt ?? "";
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return compareTicketIds(left.id, right.id);
}

/**
 * 任务状态推导（pi 口径）：
 * ended → completed；有 running 派活 → in_progress；依赖里存在未 ended 的票 →
 * blocked；其余 available。已从任务列表消失的依赖视为已解除（与 cc-haha 一致）。
 *
 * 注意：这是**五态**口径（多了 `assigned`：已派活但派活还没 running）。保留给仍在使用的
 * 调用方（AgentTeamsView）；展示层请改用 getTicketUrgency，它是叠加了失败态的单一真源。
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
  // blocked 优先于 assigned：票既然被依赖卡着，就算有人认领也开不了工，
  // 显示「阻塞」比显示「已派未开工」更能解释当前为甚么不动。
  if (blocked) return "blocked";
  // 已派活、但派活还没进入 running：有人负责但没开工。这不是「可认领」。
  if (ticket.assignments.some((assignment) => assignment.status === "pending")) {
    return "assigned";
  }
  return "available";
}

/**
 * 找出所有指向**不存在任务**的依赖边。
 *
 * 纯函数、确定性输出：先按 (ticketId, dependencyId) 自然序排序，同输入恒同输出。
 * 自依赖不算 dangling（它指向自己，自己是存在的）；那种情况由环检测负责。
 *
 * 为甚么单独一个函数而不在 getTeamTaskState 里报：那个函数是热路径（每张票每次布局都调），
 * 而且它的契约是「返回一个状态」——把告警塞进去会让每个调用方都得处理一个它不关心的返回值。
 */
export function findDanglingDependencies(
  tickets: readonly WorkbenchTicket[],
): DanglingDependency[] {
  const known = new Set(tickets.map((ticket) => ticket.id));
  const dangling: DanglingDependency[] = [];
  for (const ticket of tickets) {
    // 同一条依赖写了两遍（`dependencies` 是上游原样透传的，写入侧没有去重保证）只该报
    // 一次：否则横幅会显示「3 条依赖…（a → ghost、a → ghost、a → ghost）」，而实际只有
    // 一条边——计数虚高比不报更误导。上层邻接表本来就去重（`[...new Set(...)]`），这里
    // 之前漏了。
    const seen = new Set<string>();
    for (const dependencyId of ticket.dependencies) {
      if (known.has(dependencyId) || seen.has(dependencyId)) continue;
      seen.add(dependencyId);
      dangling.push({ ticketId: ticket.id, dependencyId });
    }
  }
  // 排序要**全序**：`TICKET_ID_COLLATOR` 对 `A`/`a`、`t-1`/`t-01` 这类返回 0，而
  // `Array.prototype.sort` 稳定 ⇒ 平局时保留输入顺序，「与输入顺序无关」就成了空话，
  // 快照对比/回放也会抖。复用同文件的 `compareTicketIds`（它带原始字符串兜底）。
  dangling.sort((left, right) => {
    const byTicket = compareTicketIds(left.ticketId, right.ticketId);
    if (byTicket !== 0) return byTicket;
    return compareTicketIds(left.dependencyId, right.dependencyId);
  });
  return dangling;
}

/**
 * 唯一紧急度真源：先取 getTeamTaskState，再把「已 ended 但派活失败」的票抬到
 * failed，并把 in_progress 归一为 running。画布配色与统计计数都必须经过这里，
 * 避免出现「统计计入 completed、卡片却画成红色」的两套口径。
 */
export function getTicketUrgency(
  ticket: WorkbenchTicket,
  ticketsById: Map<string, WorkbenchTicket>,
): TicketUrgency {
  const state = getTeamTaskState(ticket, ticketsById);
  if (state === "completed") {
    return ticket.assignments.some((assignment) => assignment.outcome === "failed")
      ? "failed"
      : "completed";
  }
  return state === "in_progress" ? "running" : state;
}

/**
 * 迭代式 Tarjan 强连通分量：返回「任务 id → 分量 id」。
 * 分量 id 按节点自然序稳定分配（邻接表已排序）。用迭代而非递归实现，深链
 * （>100 层）不会撑爆调用栈。
 */
function stronglyConnectedComponents(
  nodes: readonly string[],
  neighbors: Map<string, string[]>,
): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  let nextIndex = 0;
  let nextComponent = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    index.set(root, nextIndex);
    low.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);

    const work: Array<{ node: string; child: number }> = [{ node: root, child: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const children = neighbors.get(frame.node) ?? [];
      if (frame.child < children.length) {
        const next = children[frame.child];
        frame.child += 1;
        if (!index.has(next)) {
          index.set(next, nextIndex);
          low.set(next, nextIndex);
          nextIndex += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, child: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(next) ?? 0));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          componentOf.set(popped, nextComponent);
          if (popped === frame.node) break;
        }
        nextComponent += 1;
      }
    }
  }

  return componentOf;
}

/**
 * 给每个处于环内的票分配稳定 cycleId（同一环共享一个）。判定：分量大小 ≥ 2，
 * 或该分量含自依赖（a depends on a）。
 */
function cycleIdsByTicket(
  tickets: readonly WorkbenchTicket[],
  componentOf: Map<string, number>,
): Map<string, number> {
  const present = new Set(tickets.map((ticket) => ticket.id));
  const sizeByComponent = new Map<number, number>();
  const selfLoopComponents = new Set<number>();
  for (const ticket of tickets) {
    const component = componentOf.get(ticket.id);
    if (component === undefined) continue;
    sizeByComponent.set(component, (sizeByComponent.get(component) ?? 0) + 1);
    if (ticket.dependencies.some((dependencyId) => dependencyId === ticket.id && present.has(dependencyId))) {
      selfLoopComponents.add(component);
    }
  }

  const cycleIdByComponent = new Map<number, number>();
  const result = new Map<string, number>();
  const sorted = [...tickets].sort((left, right) => compareTicketIds(left.id, right.id));
  let nextCycleId = 0;
  for (const ticket of sorted) {
    const component = componentOf.get(ticket.id);
    if (component === undefined) continue;
    const inCycle = (sizeByComponent.get(component) ?? 0) >= 2 || selfLoopComponents.has(component);
    if (!inCycle) continue;
    let cycleId = cycleIdByComponent.get(component);
    if (cycleId === undefined) {
      cycleId = nextCycleId;
      nextCycleId += 1;
      cycleIdByComponent.set(component, cycleId);
    }
    result.set(ticket.id, cycleId);
  }
  return result;
}

/**
 * 缩点后的最长路径深度：先按分量聚合「跨分量依赖」，再在得到的分量 DAG 上求
 * 最长路径。缺失依赖忽略，同一分量内的依赖（环边、自环）不计入深度，因此
 * 环内票共享同一条泳道。集合保证分量间无环，故该递归必然终止。
 */
function ticketDepths(
  tickets: readonly WorkbenchTicket[],
  componentOf: Map<string, number>,
): Map<string, number> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const externalByComponent = new Map<number, Set<number>>();
  for (const ticket of tickets) {
    const component = componentOf.get(ticket.id);
    if (component === undefined) continue;
    let externals = externalByComponent.get(component);
    if (!externals) {
      externals = new Set<number>();
      externalByComponent.set(component, externals);
    }
    for (const dependencyId of ticket.dependencies) {
      if (!byId.has(dependencyId)) continue;
      const dependencyComponent = componentOf.get(dependencyId);
      if (dependencyComponent === undefined || dependencyComponent === component) continue;
      externals.add(dependencyComponent);
    }
  }

  const componentDepth = new Map<number, number>();
  const visiting = new Set<number>();
  const depthOfComponent = (component: number): number => {
    const cached = componentDepth.get(component);
    if (cached !== undefined) return cached;
    if (visiting.has(component)) return 0; // 缩点后本应无环，仅作防御
    visiting.add(component);
    const externals = externalByComponent.get(component);
    const depth = !externals || externals.size === 0
      ? 0
      : 1 + Math.max(...Array.from(externals, depthOfComponent));
    visiting.delete(component);
    componentDepth.set(component, depth);
    return depth;
  };

  const depths = new Map<string, number>();
  for (const ticket of tickets) {
    const component = componentOf.get(ticket.id);
    depths.set(ticket.id, component === undefined ? 0 : depthOfComponent(component));
  }
  return depths;
}

/**
 * 纯布局：按依赖深度分层，每层一条泳道自左向右，层内任务按 createdAt 追加堆叠。
 * 泳道只按「实际出现的 depth 集合」生成，不存在 count=0 的空泳道。
 *
 * @param snapshot 只读取 tickets[]。
 * @param requestedWidth 画布至少占满的宽度（容器宽度）；自然宽度更大时以自然宽度为准，
 *   并在水平方向居中泳道。非有限值按 0 处理。
 */
export function layoutTeamWorkbenchTasks(
  snapshot: TeamWorkbenchSnapshot,
  requestedWidth = 0,
): TeamTaskLayout {
  const tickets = [...snapshot.tickets];
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  // 邻接表：仅保留确实存在的依赖；自环保留（用于环判定），缩点时按同分量过滤。
  const neighbors = new Map<string, string[]>();
  for (const ticket of tickets) {
    if (neighbors.has(ticket.id)) continue;
    neighbors.set(
      ticket.id,
      [...new Set(ticket.dependencies)].filter((dependencyId) => byId.has(dependencyId)).sort(compareTicketIds),
    );
  }

  const componentOf = stronglyConnectedComponents(tickets.map((ticket) => ticket.id), neighbors);
  const cycleIdOf = cycleIdsByTicket(tickets, componentOf);
  const depths = ticketDepths(tickets, componentOf);

  const byDepth = new Map<number, WorkbenchTicket[]>();
  for (const ticket of tickets) {
    const depth = depths.get(ticket.id) ?? 0;
    const layer = byDepth.get(depth);
    if (layer) layer.push(ticket);
    else byDepth.set(depth, [ticket]);
  }
  // 实际出现的深度集合（升序）——不假设 0..max 连续，杜绝幻影空泳道。
  const laneDepths = Array.from(byDepth.keys()).sort((left, right) => left - right);

  const columns = laneDepths.length;
  const naturalWidth = HORIZONTAL_PADDING * 2
    + columns * DEPTH_COLUMN_WIDTH
    + Math.max(0, columns - 1) * DEPTH_COLUMN_GAP;
  const minimumWidth = Number.isFinite(requestedWidth)
    ? Math.max(0, Math.round(requestedWidth))
    : 0;
  const width = Math.max(naturalWidth, minimumWidth);
  const startX = (width - naturalWidth) / 2 + HORIZONTAL_PADDING;

  // 每条泳道按各自行数独立算高：长泳道不再顶着所有空泳道一起变高。
  const laneHeightFor = (rows: number): number => rows <= 0
    ? BASE_DEPTH_COLUMN_HEIGHT
    : BASE_DEPTH_COLUMN_HEIGHT + rows * TASK_HEIGHT + (rows - 1) * ROW_GAP;

  const lanes: TeamTaskLane[] = laneDepths.map((depth, ordinal) => {
    const layer = byDepth.get(depth) ?? [];
    return {
      depth,
      x: startX + ordinal * (DEPTH_COLUMN_WIDTH + DEPTH_COLUMN_GAP),
      y: DEPTH_COLUMN_TOP,
      width: DEPTH_COLUMN_WIDTH,
      height: laneHeightFor(layer.length),
      count: layer.length,
    };
  });

  const positioned: PositionedTeamTask[] = [];
  for (const lane of lanes) {
    const layer = byDepth.get(lane.depth) ?? [];
    const ordered = [...layer].sort(compareTicketsForAppend);
    ordered.forEach((ticket, row) => {
      positioned.push({
        ticket,
        urgency: getTicketUrgency(ticket, byId),
        depth: lane.depth,
        row,
        cycleId: cycleIdOf.get(ticket.id) ?? null,
        x: lane.x + (DEPTH_COLUMN_WIDTH - TASK_WIDTH) / 2,
        y: TASK_TOP + row * (TASK_HEIGHT + ROW_GAP),
      });
    });
  }

  const tallestLane = lanes.length === 0
    ? BASE_DEPTH_COLUMN_HEIGHT
    : Math.max(...lanes.map((lane) => lane.height));

  return {
    lanes,
    tasks: positioned,
    width,
    height: DEPTH_COLUMN_TOP + tallestLane + CANVAS_BOTTOM_PADDING,
    hasCycle: cycleIdOf.size > 0,
    danglingDependencies: findDanglingDependencies(tickets),
  };
}
