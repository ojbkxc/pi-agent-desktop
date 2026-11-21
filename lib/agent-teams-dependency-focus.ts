/**
 * 依赖链聚焦（移植自 cc-haha 任务画布「点一条链，整条亮起」的交互）。
 *
 * 给定当前快照的全部票与一个聚焦票 id，沿依赖关系**双向**收集整条链路：
 * - 祖先：focus 直接/间接依赖的票（dependencies 方向）；
 * - 后代：直接/间接依赖 focus 的票（反向边）。
 *
 * 画布据此给链内任务卡与依赖连线打「高亮」，链外打「变暗」。纯函数、零副作用，
 * 客户端组件与测试都能直接 import。
 *
 * 安全口径：缺失的依赖 id（票已从列表消失）直接跳过；focus 本身不在快照里时返回
 * 空集合——此时没有任何卡片需要高亮。防环：visited 集合保证环上每个票只访问一次。
 */

import type { WorkbenchTicket } from "./agent-teams-swimlane";

/**
 * 聚焦票的双向依赖链（含 focus 自身）。
 *
 * @param tickets 当前快照的全部票（只读）。
 * @param focusId 聚焦票 id；null/undefined/空串或不在快照里时返回空集合。
 * @returns 链内全部票 id（含 focus）；无 focus 时为空集合。
 */
export function dependencyChain(
  tickets: readonly WorkbenchTicket[],
  focusId: string | null | undefined,
): Set<string> {
  const chain = new Set<string>();
  if (!focusId) return chain;

  const byId = new Map<string, WorkbenchTicket>();
  for (const ticket of tickets) byId.set(ticket.id, ticket);
  if (!byId.has(focusId)) return chain;

  // 反向邻接表：被依赖票 id → 依赖它的票 id 列表（后代方向）。
  const dependents = new Map<string, string[]>();
  for (const ticket of tickets) {
    for (const dependencyId of ticket.dependencies) {
      // 缺失依赖不建边（视为已解除），与画布/统计的既有口径一致。
      if (!byId.has(dependencyId)) continue;
      const list = dependents.get(dependencyId);
      if (list) list.push(ticket.id);
      else dependents.set(dependencyId, [ticket.id]);
    }
  }

  chain.add(focusId);

  // 祖先闭包：从 focus 出发只沿 dependencies 向上，收集它直接/间接依赖的票。
  // 用独立的 visited 集（而非共享 chain），否则向上先收集到的票会挡住向下的进一步展开。
  // 与「从祖先再向下」区分开——否则共享祖先的兄弟分支会被误拉进链。
  const upSeen = new Set<string>([focusId]);
  const upward: string[] = [focusId];
  while (upward.length > 0) {
    const id = upward.pop() as string;
    const ticket = byId.get(id);
    if (!ticket) continue;
    for (const dependencyId of ticket.dependencies) {
      if (!byId.has(dependencyId) || upSeen.has(dependencyId)) continue;
      upSeen.add(dependencyId);
      chain.add(dependencyId);
      upward.push(dependencyId);
    }
  }

  // 后代闭包：从 focus 出发只沿反向边向下，收集直接/间接依赖它的票。
  const downSeen = new Set<string>([focusId]);
  const downward: string[] = [focusId];
  while (downward.length > 0) {
    const id = downward.pop() as string;
    for (const dependentId of dependents.get(id) ?? []) {
      if (downSeen.has(dependentId)) continue;
      downSeen.add(dependentId);
      chain.add(dependentId);
      downward.push(dependentId);
    }
  }

  return chain;
}
