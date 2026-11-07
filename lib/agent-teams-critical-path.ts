/**
 * 关键路径（critical path）——从成百上千条交叉依赖边里挑出唯一那条决定团队何时能
 * 结束的最长依赖链，并给出「下一个关键任务」（链上最早的未完成票）。
 *
 * 纯函数、零副作用：不 import node:fs，客户端组件与服务端路由都能安全 import。
 * 自包含实现：仅用 ticket.dependencies 建图，不依赖 agent-teams-task-layout 的布局
 * 细节——只借用它导出的 getTicketUrgency 作为「是否完成」的单一状态口径。
 *
 * 语义（全部按确定性定义）：
 * - 只算「剩余工作」：先按 getTicketUrgency 求每张票的紧急度，丢弃 completed 的票；
 *   依赖边只在两端都未完成时保留——穿过已完成票的连接自然断开，被断开的未完成票
 *   成为新的根。关键路径 = 剩余子图上的最长链（按票数计长），从根（无依赖）到叶。
 *   若把已完成票算进去，一条全历史完成的长链会霸占 path、把 nextCriticalTask 顶成
 *   null，而实际还有活没干——这是必须避免的产品语义错误。
 * - 依赖边方向：票 v 依赖 u ⇒ 有向边 u → v（u 先于 v）。
 * - 环：先用迭代式 Tarjan 缩点把依赖环坍缩成一个分量，再在缩点后的 DAG 上求最长
 *   路径；链经过某分量时按确定顺序展开该分量的全部票。有环不会死循环、不会爆栈。
 * - 缺失依赖：指向不存在票的依赖视为已解除（与 getTeamTaskState 口径一致），不成边。
 * - 自依赖：忽略（等价于无依赖，不计入 hasCycle）。
 * - 确定性：剩余票按 (createdAt 升序, id 升序) 定序并据此分配 rank；等长前驱取 rank
 *   最小者，等长链端取 rank 最小者。同输入恒同输出，不依赖 Map 迭代顺序。
 *
 * nextCriticalTask：剩余链上第一张未完成的票（过滤后即链的根）。只有
 * getTicketUrgency === "completed" 算完成，failed 视为仍需盯。剩余图为空时返回 null。
 */

import type { WorkbenchTicket } from "./agent-teams-swimlane";
import { getTicketUrgency } from "./agent-teams-task-layout";

export interface CriticalPathResult {
  /** 剩余工作子图上的最长依赖链（从根到叶）；同输入恒同输出。全部完成时为空数组。 */
  path: WorkbenchTicket[];
  /** 剩余链上第一张未完成的票（过滤后即链的根）；剩余图为空时 null。 */
  nextCriticalTask: WorkbenchTicket | null;
  /** 剩余工作子图上是否存在长度 ≥ 2 的环（自依赖不计）。 */
  hasCycle: boolean;
}

/** 空结果常量语义（每次返回新对象，避免调用方误改共享引用）。 */
function emptyResult(): CriticalPathResult {
  return { path: [], nextCriticalTask: null, hasCycle: false };
}

/**
 * 在「剩余工作」子图上求最长链（关键路径）。
 *
 * 复杂度：缩点 O(V + E)，排序 O(E log E)，DP O(V + E)；V=剩余票数，E=剩余依赖边数。
 * 全程迭代实现，深链（1000+）不爆栈。
 */
export function criticalPath(tickets: readonly WorkbenchTicket[]): CriticalPathResult {
  if (tickets.length === 0) return emptyResult();

  // 1) 按 id 去重（保留首次出现，确定性）。
  const ticketsById = new Map<string, WorkbenchTicket>();
  for (const ticket of tickets) {
    if (!ticketsById.has(ticket.id)) ticketsById.set(ticket.id, ticket);
  }

  // 2) 只保留剩余工作：urgency !== "completed" 的票。全部完成 → 剩余图为空。
  const remaining = [...ticketsById.values()].filter(
    (ticket) => getTicketUrgency(ticket, ticketsById) !== "completed",
  );
  if (remaining.length === 0) return emptyResult();

  // 3) 按 (createdAt 升序, id 升序) 对剩余票定序并分配 rank。
  const ids = remaining.map((ticket) => ticket.id).sort((left, right) => {
    const leftAt = ticketsById.get(left)?.createdAt ?? "";
    const rightAt = ticketsById.get(right)?.createdAt ?? "";
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const rank = new Map<string, number>();
  ids.forEach((id, index) => rank.set(id, index));
  const validIds = new Set(ids);

  // 4) 建图：只保留两端都在剩余集里的依赖边。
  //    depsOf[v]=v 的剩余依赖（存在的、非自身，按 rank 排序）；outgoing[u]=依赖 u 的票。
  const depsOf = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    const seen = new Set<string>();
    for (const dep of ticketsById.get(id)?.dependencies ?? []) {
      if (dep === id || !validIds.has(dep)) continue;
      seen.add(dep);
    }
    const deps = [...seen].sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0));
    depsOf.set(id, deps);
    for (const dep of deps) {
      const list = outgoing.get(dep);
      if (list) list.push(id);
      else outgoing.set(dep, [id]);
    }
  }
  for (const list of outgoing.values()) {
    list.sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0));
  }

  // 5) 迭代式 Tarjan 求强连通分量（缩点）。
  const { componentOf, componentCount } = computeComponents(ids, outgoing);
  if (componentCount === 0) return emptyResult();

  // 6) 分量成员（按 rank 顺序）、分量 rank（成员最小 rank）。
  const componentMembers = new Map<number, string[]>();
  const componentRank = new Map<number, number>();
  for (const id of ids) {
    const component = componentOf.get(id) ?? 0;
    const members = componentMembers.get(component);
    if (members) members.push(id);
    else componentMembers.set(component, [id]);
    if (!componentRank.has(component)) componentRank.set(component, rank.get(id) ?? 0);
  }

  let hasCycle = false;
  for (const members of componentMembers.values()) {
    if (members.length > 1) {
      hasCycle = true;
      break;
    }
  }

  // 7) 缩点后的前驱表（同分量内边丢弃；跨分量边去重，按前驱 rank 排序）。
  const predecessors = new Map<number, number[]>();
  const predecessorSets = new Map<number, Set<number>>();
  for (const id of ids) {
    const to = componentOf.get(id) ?? 0;
    for (const dep of depsOf.get(id) ?? []) {
      const from = componentOf.get(dep) ?? 0;
      if (from === to) continue;
      let set = predecessorSets.get(to);
      if (!set) {
        set = new Set<number>();
        predecessorSets.set(to, set);
      }
      set.add(from);
    }
  }
  for (const [component, set] of predecessorSets) {
    predecessors.set(
      component,
      [...set].sort((left, right) => (componentRank.get(left) ?? 0) - (componentRank.get(right) ?? 0)),
    );
  }

  // 8) 缩点 DAG 上的最长路径 DP（Kahn 拓扑序；longest 单位是分量内票数）。
  const longest = new Map<number, number>();
  const chosenPredecessor = new Map<number, number | null>();
  const remainingIndegree = new Map<number, number>();
  const successors = new Map<number, number[]>();
  for (let component = 0; component < componentCount; component += 1) {
    const preds = predecessors.get(component) ?? [];
    remainingIndegree.set(component, preds.length);
    for (const pred of preds) {
      const list = successors.get(pred);
      if (list) list.push(component);
      else successors.set(pred, [component]);
    }
  }
  const queue: number[] = [];
  for (let component = 0; component < componentCount; component += 1) {
    if ((remainingIndegree.get(component) ?? 0) === 0) queue.push(component);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const component = queue[head];
    const size = (componentMembers.get(component) ?? []).length;
    let best = size;
    let bestPred: number | null = null;
    for (const pred of predecessors.get(component) ?? []) {
      const candidate = (longest.get(pred) ?? 0) + size;
      if (
        candidate > best ||
        (candidate === best && bestPred !== null && (componentRank.get(pred) ?? 0) < (componentRank.get(bestPred) ?? 0))
      ) {
        best = candidate;
        bestPred = pred;
      }
    }
    longest.set(component, best);
    chosenPredecessor.set(component, bestPred);
    for (const next of successors.get(component) ?? []) {
      const left = (remainingIndegree.get(next) ?? 0) - 1;
      remainingIndegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  // 9) 选链端：最长；等长取分量 rank 最小者（遍历已按 rank 升序，strict > 即取首个）。
  const componentsByRank = [...componentMembers.keys()].sort(
    (left, right) => (componentRank.get(left) ?? 0) - (componentRank.get(right) ?? 0),
  );
  let endComponent = -1;
  let bestLength = -1;
  for (const component of componentsByRank) {
    const length = longest.get(component) ?? 0;
    if (length > bestLength) {
      bestLength = length;
      endComponent = component;
    }
  }
  if (endComponent < 0) return emptyResult();

  // 10) 回溯分量链并展开为票（分量内按 rank 顺序；guard 防止任何意外环）。
  const componentChain: number[] = [];
  const guard = new Set<number>();
  let cursor: number | null = endComponent;
  while (cursor !== null && !guard.has(cursor)) {
    guard.add(cursor);
    componentChain.push(cursor);
    cursor = chosenPredecessor.get(cursor) ?? null;
  }
  componentChain.reverse();

  const path: WorkbenchTicket[] = [];
  for (const component of componentChain) {
    for (const id of componentMembers.get(component) ?? []) {
      const ticket = ticketsById.get(id);
      if (ticket) path.push(ticket);
    }
  }

  // 11) 第一个未完成票（getTicketUrgency 口径；过滤后即剩余链的根）。
  let nextCriticalTask: WorkbenchTicket | null = null;
  for (const ticket of path) {
    if (getTicketUrgency(ticket, ticketsById) !== "completed") {
      nextCriticalTask = ticket;
      break;
    }
  }

  return { path, nextCriticalTask, hasCycle };
}

/**
 * 迭代式 Tarjan 强连通分量（自包含，无递归）。
 * 返回「票 id → 分量编号」与分量总数；分量编号按节点 rank 顺序稳定分配。
 */
function computeComponents(
  ids: readonly string[],
  outgoing: Map<string, string[]>,
): { componentOf: Map<string, number>; componentCount: number } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  let nextIndex = 0;
  let componentCount = 0;

  for (const root of ids) {
    if (index.has(root)) continue;
    index.set(root, nextIndex);
    low.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);

    const work: Array<{ node: string; child: number }> = [{ node: root, child: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const children = outgoing.get(frame.node) ?? [];
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
      if (low.get(frame.node) === index.get(frame.node)) {
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          componentOf.set(member, componentCount);
        } while (member !== frame.node);
        componentCount += 1;
      }
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      }
    }
  }

  return { componentOf, componentCount };
}
