/**
 * 成员执行历史的时间派生（纯函数，零 I/O）。
 *
 * 工作台的 `useTeamTimeline` 会保留最近若干帧工作台快照（WORKBENCH_HISTORY_LIMIT）。
 * 成员检查器想回答「这张票从出现到结束用了多久」，单帧快照做不到——票上只有 `createdAt`
 * 与当前状态；「首次离开 open」「首次 ended」都必须跨帧回看。
 *
 * 本模块只读 `snapshots[0..selectedIndex]`（选中帧及更早的帧），为指定成员名下的每张票
 * 求：
 *   - `leftOpenAt`：第一次观察到 status !== "open" 的那一帧时间；
 *   - `endedAt`：第一次观察到 status === "ended" 的那一帧时间；
 *   - `durationMs`：`endedAt − 首次出现时间`（首次出现优先取票自带 createdAt，缺省取
 *     首次观察到它的帧的 generatedAt）；尚未结束或时间不可解析时为 null。
 *
 * 无历史（空数组 / selectedIndex < 0）时返回空 Map——调用方据此不渲染耗时。
 */

import type { TeamWorkbenchSnapshot } from "./agent-teams-swimlane";

export interface TicketHistory {
  ticketId: string;
  /** 第一次不再 open 的帧时间（ISO）；仍 open 时为 null。 */
  leftOpenAt: string | null;
  /** 第一次 ended 的帧时间（ISO）；未结束为 null。 */
  endedAt: string | null;
  /** endedAt − 首次出现时间（毫秒）；无法计算为 null。 */
  durationMs: number | null;
}

/**
 * 跨帧派生成员名下票的耗时。
 *
 * @param snapshots     历史快照（按时间升序，末条最新）。
 * @param selectedIndex 当前查看的帧下标（含该帧）；负值 / 非有限值返回空。
 * @param memberId      成员 agentId（票 ownerId 与之比较）。
 */
export function deriveTicketHistory(
  snapshots: readonly TeamWorkbenchSnapshot[],
  selectedIndex: number,
  memberId: string,
): Map<string, TicketHistory> {
  const result = new Map<string, TicketHistory>();
  if (!Array.isArray(snapshots) || snapshots.length === 0) return result;
  if (!Number.isFinite(selectedIndex) || selectedIndex < 0 || !memberId) return result;

  const lastIndex = Math.min(snapshots.length - 1, Math.floor(selectedIndex));
  if (lastIndex < 0) return result;

  const firstSeen = new Map<string, string>();
  const leftOpen = new Map<string, string>();
  const ended = new Map<string, string>();

  for (let index = 0; index <= lastIndex; index += 1) {
    const snapshot = snapshots[index];
    if (!snapshot) continue;
    const at = snapshot.generatedAt || "";
    for (const ticket of snapshot.tickets ?? []) {
      if (ticket.ownerId !== memberId) continue;
      if (!firstSeen.has(ticket.id)) {
        firstSeen.set(ticket.id, ticket.createdAt || at);
      }
      if (ticket.status !== "open" && !leftOpen.has(ticket.id)) {
        leftOpen.set(ticket.id, at);
      }
      if (ticket.status === "ended" && !ended.has(ticket.id)) {
        ended.set(ticket.id, at);
      }
    }
  }

  for (const [ticketId, seenAt] of firstSeen) {
    const endedAt = ended.get(ticketId) ?? null;
    const startMs = Date.parse(seenAt);
    const endMs = endedAt ? Date.parse(endedAt) : Number.NaN;
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
      ? endMs - startMs
      : null;
    result.set(ticketId, {
      ticketId,
      leftOpenAt: leftOpen.get(ticketId) ?? null,
      endedAt,
      durationMs,
    });
  }

  return result;
}
