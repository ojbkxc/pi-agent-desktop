/**
 * 编队带布局（移植自 cc-haha AgentTeamsCanvas.tsx:76-90 的上半画布）。
 *
 * 画布是上下两条固定几何带：带 1「编队」 y ∈ [0, 388]（队长置顶居中、成员排下方、
 * 中间夹 lead bus 与 peer bus），带 2「共享任务列表」 y ≥ 410（见
 * lib/agent-teams-task-layout.ts 的 DEPTH_COLUMN_TOP = 410）。本文件只负责带 1 的
 * 纯几何与成员工作态，不依赖任何 DOM，可被组件与测试直接 import。
 *
 * 关键取舍：成员工作态与「票级 urgency」完全解耦。任务会跨 turn 长期挂着，一张
 * running 的票半小时没动静是「停滞」而不是「运行中」——从任务列表反推活跃度会
 * 把全员误判成永久工作中（cc-haha agentTeamsModel.ts:286-320 的原话）。
 */

import type { TeamWorkbenchSnapshot, WorkbenchMember } from "./agent-teams-swimlane";
import {
  URGENCY_ORDER,
  URGENCY_WEIGHT,
  getTicketUrgency,
  type TicketUrgency,
} from "./agent-teams-task-layout.ts";

// ── 几何常量（照 cc-haha AgentTeamsCanvas.tsx:76-90）──────────────────────────
export const CANVAS_MIN_WIDTH = 1280;
export const FORMATION_TITLE_X = 14;
export const FORMATION_TITLE_Y = 12;
export const TASKS_TITLE_Y = 388;
export const LEAD_TOP = 20;
export const LEAD_FOOT = 150;
export const LEAD_BUS_Y = 196;
export const MEMBER_TOP = 222;
export const MEMBER_FOOT = 352;
export const PEER_BUS_Y = 372;
export const MEMBER_PITCH = 200;
export const MEMBER_SLOT_WIDTH = 176;
/** 编队带高度（= 任务列表标题基线的 y）。 */
export const FORMATION_HEIGHT = TASKS_TITLE_Y;
/** 编队带底边，也就是带 2 任务泳道的起点（与 DEPTH_COLUMN_TOP 一致）。 */
export const FORMATION_BOTTOM = 410;

/**
 * 成员工作态——只读名册自身的状态与时间戳，绝不看任务状态（保持与票级 urgency 解耦）：
 * working 有活跃 turn / idle 静默 / parked 已挂起（可复活）/ retrying 等自动重试 /
 * stopped 进程已退出（终止）/ exited 已归档 / error 上次 turn 失败。
 * `parked` 与 `idle`、`stopped` 都不同：挂起是「暂时歇工、消息可唤醒」，不是静默也不是终止。
 * 说明：我们的投影目前没有 autoRetry 字段，`retrying` 作为保留态暂不产生。
 */
export type MemberWorkState = "working" | "idle" | "parked" | "retrying" | "stopped" | "exited" | "error";

/** 工作态 → 展示优先级（越大越「需要关注」）；排序与徽标配色用。 */
export const MEMBER_WORK_STATE_WEIGHT: Record<MemberWorkState, number> = {
  error: 6,
  stopped: 5,
  retrying: 4,
  parked: 3,
  working: 2,
  idle: 1,
  exited: 0,
};

/**
 * 成员工作态推导（与票级 urgency 解耦）。上游有 runner 写 turn 标记，我们的名册
 * status 已由 lifecycle.json 投影（lead 恒 running），故此处以其为准：
 * completed → exited；aborted → stopped；parked → parked；failed → error；
 * running → working；其余 idle。
 * lead 没有独立 runner，调用方用 leadIsStreaming 传入其会话是否在流式输出。
 */
export function getMemberWorkState(
  member: WorkbenchMember,
  options: { isLead?: boolean; leadIsStreaming?: boolean } = {},
): MemberWorkState {
  if (member.status === "completed") return "exited";
  if (member.status === "aborted") return "stopped";
  if (member.status === "parked") return "parked";
  if (options.isLead) {
    if (member.status === "failed") return "error";
    return options.leadIsStreaming ? "working" : "idle";
  }
  if (member.status === "failed") return "error";
  if (member.status === "running") return "working";
  return "idle";
}

/** 队长超过这个时长没有活动就视为空闲（不再假装 working）。 */
export const LEAD_IDLE_AFTER_MS = 10 * 60_000;

/**
 * 成员「最后一次活动」时刻（ISO）：取该成员泳道事件与其名下派活 lastActivityAt 的最新值。
 * 只取时间戳，不取任务状态——工作态与票级 urgency 解耦的原则不被破坏。
 */
function memberLastActivityAt(snapshot: TeamWorkbenchSnapshot, memberId: string): string | null {
  let latest = "";
  const lane = snapshot.lanes.find((item) => item.memberId === memberId);
  for (const event of lane?.events ?? []) {
    if (event.at > latest) latest = event.at;
  }
  for (const ticket of snapshot.tickets) {
    for (const assignment of ticket.assignments) {
      if (assignment.memberId !== memberId) continue;
      if (assignment.lastActivityAt && assignment.lastActivityAt > latest) latest = assignment.lastActivityAt;
    }
  }
  return latest || null;
}

/** 全队最新活动时刻；队长本身没有活动记录时的兜底（团队在动 ⇒ 队长很可能也在动）。 */
function teamLastActivityAt(snapshot: TeamWorkbenchSnapshot): string | null {
  let latest = "";
  for (const lane of snapshot.lanes) {
    for (const event of lane.events) if (event.at > latest) latest = event.at;
  }
  for (const ticket of snapshot.tickets) {
    for (const assignment of ticket.assignments) {
      if (assignment.lastActivityAt && assignment.lastActivityAt > latest) latest = assignment.lastActivityAt;
    }
  }
  return latest || null;
}

/**
 * 队长是否正在读流：名册 running 且最近活动不超过 LEAD_IDLE_AFTER_MS（以快照的
 * generatedAt 为「现在」，保证纯函数、可复现）。没有任何活动可依时不做空闲判定，
 * 避免把刚建好、还没产生活动的团队误判为空闲。
 */
function leadIsStreaming(snapshot: TeamWorkbenchSnapshot, lead: WorkbenchMember): boolean {
  if (lead.status !== "running") return false;
  const last = memberLastActivityAt(snapshot, lead.id) ?? teamLastActivityAt(snapshot);
  if (!last) return true;
  const at = Date.parse(last);
  const now = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return true;
  return now - at <= LEAD_IDLE_AFTER_MS;
}

/** 成员一条分段进度条的一段：某紧急度占其名下票的比例。 */
export interface FormationSegment {
  urgency: TicketUrgency;
  count: number;
}

export interface FormationMember {
  member: WorkbenchMember;
  isLead: boolean;
  /** 卡片中心 x（相对画布左边）。 */
  centerX: number;
  /** 卡片顶边 y。 */
  top: number;
  /** 调色板名（blue/green/…），组件据此取 --formation-accent。 */
  accent: string;
  workState: MemberWorkState;
  /** 名下票总数。 */
  total: number;
  /** 其中已完成（urgency=completed）。 */
  completed: number;
  /** 完成率（0-100），无票为 0。 */
  percent: number;
  /** 分段进度条（按 URGENCY_ORDER，仅保留 count>0 的段）。 */
  segments: FormationSegment[];
  /** 名下最紧急的票态；无票为 null。 */
  urgency: TicketUrgency | null;
}

export interface FormationLayout {
  width: number;
  height: number;
  lead: FormationMember | null;
  workers: FormationMember[];
  /** 两条总线：lead bus 从队长垂到 LEAD_BUS_Y，peer bus 横跨首尾成员。 */
  bus: {
    leadX: number | null;
    firstWorkerX: number | null;
    lastWorkerX: number | null;
  };
}

/** 画布自然宽度：按成员间距撑开，至少 CANVAS_MIN_WIDTH（照上游 :813）。 */
export function formationNaturalWidth(memberCount: number): number {
  const workers = Math.max(0, memberCount - 1);
  return Math.max(CANVAS_MIN_WIDTH, 460 + Math.max(0, workers - 1) * MEMBER_PITCH);
}

/** 队长判定：命中名册里 sessionId 与团队 leadSessionId 一致者，退化为名字/首位。 */
function pickLead(snapshot: TeamWorkbenchSnapshot): WorkbenchMember | null {
  const members = snapshot.members;
  if (members.length === 0) return null;
  const bySession = snapshot.team.leadSessionId
    ? members.find((member) => member.sessionId && member.sessionId === snapshot.team.leadSessionId)
    : undefined;
  return bySession
    ?? members.find((member) => member.name === "team-lead")
    ?? members[0];
}

function ownedTickets(snapshot: TeamWorkbenchSnapshot, memberId: string) {
  return snapshot.tickets.filter((ticket) => ticket.ownerId === memberId);
}

/** 成员名下票按紧急度分桶；按 URGENCY_ORDER（最紧急在前）输出有序段。 */
function memberSegments(
  snapshot: TeamWorkbenchSnapshot,
  memberId: string,
): { segments: FormationSegment[]; total: number; completed: number; urgency: TicketUrgency | null } {
  const ticketsById = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket]));
  const buckets = new Map<TicketUrgency, number>();
  const owned = ownedTickets(snapshot, memberId);
  for (const ticket of owned) {
    const urgency = getTicketUrgency(ticket, ticketsById);
    buckets.set(urgency, (buckets.get(urgency) ?? 0) + 1);
  }
  const segments = URGENCY_ORDER
    .filter((urgency) => (buckets.get(urgency) ?? 0) > 0)
    .map((urgency) => ({ urgency, count: buckets.get(urgency) ?? 0 }));
  return {
    segments,
    total: owned.length,
    completed: buckets.get("completed") ?? 0,
    urgency: segments[0]?.urgency ?? null,
  };
}

/**
 * 编队带纯布局：给定画布宽度与快照，算出队长节点、成员节点行与两条总线的坐标。
 * 成员按名册顺序（稳定）从左到右、以 MEMBER_PITCH 固定间距排布。
 */
export function layoutFormation(snapshot: TeamWorkbenchSnapshot, width: number): FormationLayout {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : CANVAS_MIN_WIDTH;
  const lead = pickLead(snapshot);
  const allMembers = snapshot.members;
  const workers = allMembers.filter((member) => member !== lead);

  const leadCenter = safeWidth / 2;
  const workerStart = leadCenter - Math.max(0, workers.length - 1) * MEMBER_PITCH / 2;
  // 队长没有独立 runner：用「名册 running + 最近活动」推断其是否在读流，
  // 长时间无活动就显示 idle，别永远假装在干活。
  const leadStreaming = lead ? leadIsStreaming(snapshot, lead) : false;

  const build = (member: WorkbenchMember, isLead: boolean, centerX: number, index: number): FormationMember => {
    const { segments, total, completed, urgency } = memberSegments(snapshot, member.id);
    return {
      member,
      isLead,
      centerX,
      top: isLead ? LEAD_TOP : MEMBER_TOP,
      accent: member.color || (isLead ? "gray" : "blue"),
      workState: getMemberWorkState(member, {
        isLead,
        leadIsStreaming: isLead ? leadStreaming : undefined,
      }),
      total,
      completed,
      percent: total === 0 ? 0 : Math.round((completed / total) * 100),
      segments,
      urgency,
    };
  };

  const leadNode = lead ? build(lead, true, leadCenter, allMembers.indexOf(lead)) : null;
  const workerNodes = workers.map((member, index) => (
    build(member, false, workerStart + index * MEMBER_PITCH, allMembers.indexOf(member))
  ));

  return {
    width: safeWidth,
    height: FORMATION_HEIGHT,
    lead: leadNode,
    workers: workerNodes,
    bus: {
      leadX: leadNode ? leadNode.centerX : null,
      firstWorkerX: workerNodes.length > 0 ? workerNodes[0].centerX : null,
      lastWorkerX: workerNodes.length > 0 ? workerNodes[workerNodes.length - 1].centerX : null,
    },
  };
}

/** 按紧急度重排成员（默认不重排，只在用户显式切换时用）；同权重保持加入顺序。 */
export function sortWorkersByUrgency(workers: FormationMember[]): FormationMember[] {
  return [...workers].sort((left, right) => {
    const leftUrgency = left.urgency ? URGENCY_WEIGHT[left.urgency] : 0;
    const rightUrgency = right.urgency ? URGENCY_WEIGHT[right.urgency] : 0;
    return rightUrgency - leftUrgency;
  });
}
