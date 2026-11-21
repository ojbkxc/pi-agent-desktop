/**
 * 任务卡进度与停滞判定（纯函数，供任务画布消费）。
 *
 * 进度口径只读票自身的 `assignments[]`：
 * - none：还没有任何派活（无进度可言）；
 * - indeterminate：有派活在跑，但还没有任何已结束的派活可作锚点（比例未知）；
 * - determinate：可以用「已结束派活 / 总派活」给出百分比。
 *
 * 停滞口径：票尚未结束，却挂着一个 running 派活，而该派活的成员已处于
 * failed / parked / aborted —— 名义上在跑，实际没人干活。这与编队带「成员工作态」
 * 同源（成员态是唯一真源），不在这里另造一套成员状态。
 */

import type { WorkbenchMember, WorkbenchTicket } from "./agent-teams-swimlane";

export interface TicketProgress {
  mode: "none" | "indeterminate" | "determinate";
  /** 0-100；仅 determinate 有意义，其余为 0。 */
  percent: number;
}

/** 让一条 running 派活「名存实亡」的成员状态。 */
const STALLED_MEMBER_STATUSES = new Set(["failed", "parked", "aborted"]);

/**
 * 任务卡进度：用已结束的派活数 / 总派活数算确定比例；只有 running 派活而还没有
 * 结束锚点时是未知比例（indeterminate）。失败派活同样是 ended，计入已结束数，
 * 其「失败」语义由紧急度（failed）单独表达。
 */
export function ticketProgress(ticket: WorkbenchTicket): TicketProgress {
  const total = ticket.assignments.length;
  if (total === 0) return { mode: "none", percent: 0 };

  const ended = ticket.assignments.filter((assignment) => assignment.status === "ended").length;
  const hasRunning = ticket.assignments.some((assignment) => assignment.status === "running");

  // 有派活在跑、却连一条已结束的都没有：无从得知跑到几成 → 不确定进度。
  if (hasRunning && ended === 0) return { mode: "indeterminate", percent: 0 };

  return { mode: "determinate", percent: Math.round((ended / total) * 100) };
}

/**
 * 票是否停滞：票未结束，且存在一条 running 派活落在 failed/parked/aborted 的成员上。
 *
 * @param members 快照名册（按 id 建状态表；成员不在名册里不判定为停滞）。
 */
export function ticketStalled(
  ticket: WorkbenchTicket,
  members: readonly WorkbenchMember[],
): boolean {
  if (ticket.status === "ended") return false;

  const statusById = new Map<string, WorkbenchMember["status"]>();
  for (const member of members) statusById.set(member.id, member.status);

  return ticket.assignments.some((assignment) => {
    if (assignment.status !== "running") return false;
    if (assignment.memberId === null) return false;
    const status = statusById.get(assignment.memberId);
    return status !== undefined && STALLED_MEMBER_STATUSES.has(status);
  });
}
