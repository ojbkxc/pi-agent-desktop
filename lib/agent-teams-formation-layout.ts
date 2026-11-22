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

import type {
  TeamWorkbenchSnapshot,
  WorkbenchMember,
  WorkbenchMessage,
  WorkbenchTicket,
} from "./agent-teams-swimlane";
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
/**
 * 成员分行上限：单行最多 8 张卡（约 1600px 宽）。
 *
 * 为什么必须有上限：旧实现把成员排成一整行 —— 60 个成员 => 画布宽 11.8k px，整屏
 * 只剩一条细缝能看，用户还得横向滚十倍屏宽才数得清人。分行后画布宽被上限钉住，
 * 多出来的人往下排（见 formationRowCount / arrangeFormationRows）。
 * 上限同时是 formationNaturalWidth 的饱和点：成员再多也不再横向撑宽。
 */
export const MAX_MEMBERS_PER_ROW = 8;
/** 行间距：要同时容下上一行的 peer 总线（脚下方 20px）与下一行的行总线（顶边上方 26px）。 */
export const MEMBER_ROW_GAP = 56;
/** 相邻两行的卡片顶边间距（卡片高 130 + 行间 56）。 */
export const MEMBER_ROW_PITCH = (MEMBER_FOOT - MEMBER_TOP) + MEMBER_ROW_GAP;
/** 行总线在卡片顶边之上的距离（= LEAD_BUS_Y 与 MEMBER_TOP 的差，首行总线仍是 LEAD_BUS_Y）。 */
export const ROW_BUS_GAP = MEMBER_TOP - LEAD_BUS_Y;
/** peer 总线在卡片底边之下的距离。 */
export const PEER_BUS_GAP = PEER_BUS_Y - MEMBER_FOOT;
/** 编队带高度（= 任务列表标题基线的 y；单行成员时就是整条带高）。 */
export const FORMATION_HEIGHT = TASKS_TITLE_Y;
/** 编队带底边，也就是带 2 任务泳道的起点（与 DEPTH_COLUMN_TOP 一致；单行成员时）。 */
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
  /**
   * 当前正在执行的票：该成员 assignments 中 status=running、lastActivityAt 最新的票。
   * 没有 running 派活时为 null。
   */
  currentTicketId: string | null;
  /** 当前票 dependencies 中第一个仍未 ended 的依赖票 id；无当前票或依赖都已满足为 null。 */
  blockedDependencyId: string | null;
  /** 收件数：快照 messages 中 to/recipients 命中该成员的条数（不含自己发出的）。 */
  inboxCount: number;
}

/**
 * 成员排的一行（分行布局的输出单位）。
 *
 * 为什么要有它：成员多时旧实现把所有卡片排成一整行（60 人 = 11.8k px 画布），
 * 需要「按可用宽度/每行上限换行」。行对象把一行内所有卡片的几何一次给全，
 * 组件只按行画总线、按节点画卡片，不必自己算换行。
 */
export interface FormationRow {
  /** 行号（0 起，自上而下）。 */
  index: number;
  /** 行内卡片顶边 y。 */
  top: number;
  /** 行内卡片底边 y。 */
  foot: number;
  /** 行总线 y（卡片顶边之上 ROW_BUS_GAP；第 0 行正好是 LEAD_BUS_Y）。 */
  busY: number;
  /** peer 总线 y（卡片底边之下 PEER_BUS_GAP）。 */
  peerBusY: number;
  /** 行内成员卡片（按名册顺序，已带上本行的 top/centerX）。 */
  members: FormationMember[];
  /** 行内首/尾卡片中心 x（空行为 null）。 */
  firstX: number | null;
  lastX: number | null;
  /** 行中心 x（首尾中点；行间竖直连线走这里）。 */
  centerX: number | null;
}

export interface FormationLayout {
  width: number;
  /** 编队带的实际高度（含分行带来的额外行高；单行时 = FORMATION_HEIGHT）。 */
  height: number;
  /** 编队带底边：任务泳道从这里开始（单行时 = FORMATION_BOTTOM）。 */
  bottom: number;
  lead: FormationMember | null;
  /** 全部成员卡（按名册顺序、行优先展平）。 */
  workers: FormationMember[];
  /** 分行结果：每行一张卡的几何 + 行总线（组件据此画总线）。 */
  rows: FormationRow[];
  /** 行数（0 = 没有成员）。 */
  rowCount: number;
  /** 两条总线：lead bus 从队长垂到首行行总线，peer bus 每行横跨该行首尾成员。 */
  bus: {
    leadX: number | null;
    /** 首行首张卡中心 x（单行时即整排最左）。 */
    firstWorkerX: number | null;
    /** 首行末张卡中心 x（单行时即整排最右）。 */
    lastWorkerX: number | null;
  };
}

/**
 * 画布自然宽度：按成员间距撑开，至少 CANVAS_MIN_WIDTH（照上游 :813）。
 *
 * 成员数超过 MAX_MEMBERS_PER_ROW 后**饱和**：多出来的人分成新行往下排，画布不再
 * 横向撑宽（旧实现 60 人 = 11.8k px，见 MEMBER_ROW_GAP / formationRowCount）。
 */
export function formationNaturalWidth(memberCount: number): number {
  const workers = Math.max(0, memberCount - 1);
  const inRow = Math.min(workers, MAX_MEMBERS_PER_ROW);
  return Math.max(CANVAS_MIN_WIDTH, 460 + Math.max(0, inRow - 1) * MEMBER_PITCH);
}

/**
 * 可用宽度下一行能放几张成员卡：按 MEMBER_PITCH 间距与 MEMBER_SLOT_WIDTH 卡宽算，
 * 再被 MAX_MEMBERS_PER_ROW 钉住，至少 1（极窄画布也不出现「0 张/行」死循环）。
 */
export function membersPerRow(availableWidth: number): number {
  const width = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : CANVAS_MIN_WIDTH;
  const fitted = Math.floor((width - MEMBER_SLOT_WIDTH) / MEMBER_PITCH) + 1;
  return Math.max(1, Math.min(MAX_MEMBERS_PER_ROW, fitted));
}

/** 给定成员（worker）数与画布宽度，需要几行（0 = 没有成员）。 */
export function formationRowCount(workerCount: number, availableWidth: number): number {
  const total = Math.max(0, Math.floor(workerCount));
  if (total === 0) return 0;
  return Math.ceil(total / membersPerRow(availableWidth));
}

/** 编队带高度（rows 行）：单行时 = FORMATION_HEIGHT，每多一行加 MEMBER_ROW_PITCH。 */
export function formationBandHeight(rows: number): number {
  const extra = Math.max(0, Math.floor(rows) - 1);
  return FORMATION_HEIGHT + extra * MEMBER_ROW_PITCH;
}

/** 编队带底边（rows 行）：单行时 = FORMATION_BOTTOM，任务泳道据此下移。 */
export function formationBandBottom(rows: number): number {
  const extra = Math.max(0, Math.floor(rows) - 1);
  return FORMATION_BOTTOM + extra * MEMBER_ROW_PITCH;
}

/**
 * 把成员卡按行排开（分行布局的唯一几何真源）。
 *
 * - 每行 membersPerRow(width) 张，行内以 MEMBER_PITCH 间距、整体水平居中；
 * - 行 y 按 MEMBER_ROW_PITCH 递增，首行仍是 MEMBER_TOP；
 * - 节点对象浅拷贝后写回 top/centerX（不就地修改入参，纯函数、可缓存）。
 *
 * 布局与「按紧急度重排」共用它：重排只是换一组入参，几何完全同一套口径。
 */
export function arrangeFormationRows(
  workers: readonly FormationMember[],
  availableWidth: number,
): FormationRow[] {
  const width = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : CANVAS_MIN_WIDTH;
  const perRow = membersPerRow(width);
  const rows: FormationRow[] = [];
  for (let start = 0; start < workers.length; start += perRow) {
    const index = rows.length;
    const top = MEMBER_TOP + index * MEMBER_ROW_PITCH;
    const foot = MEMBER_FOOT + index * MEMBER_ROW_PITCH;
    const group = workers.slice(start, start + perRow);
    const startX = width / 2 - Math.max(0, group.length - 1) * MEMBER_PITCH / 2;
    const members = group.map((node, offset) => ({
      ...node,
      top,
      centerX: startX + offset * MEMBER_PITCH,
    }));
    const firstX = members.length > 0 ? members[0].centerX : null;
    const lastX = members.length > 0 ? members[members.length - 1].centerX : null;
    rows.push({
      index,
      top,
      foot,
      busY: top - ROW_BUS_GAP,
      peerBusY: foot + PEER_BUS_GAP,
      members,
      firstX,
      lastX,
      centerX: firstX !== null && lastX !== null ? (firstX + lastX) / 2 : null,
    });
  }
  return rows;
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

/**
 * 身份别名：同时认全名与 `name@team` 短名（与 lib/agent-teams-flight.ts 的飞行路线
 * 同口径，避免「通信流认这条消息、编队卡却不认」）。导出给组件复用。
 */
export function identityAliases(value: string | undefined): string[] {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return [];
  const short = normalized.split("@")[0] ?? normalized;
  return normalized === short ? [normalized] : [normalized, short];
}

/** 一个消息身份（from/to/recipients 里的一项）是否命中某个成员（id 或 name）。 */
export function identityMatches(
  memberId: string,
  memberName: string,
  identity: string | undefined,
): boolean {
  const target = identityAliases(identity);
  if (target.length === 0) return false;
  const own = [...identityAliases(memberId), ...identityAliases(memberName)];
  return target.some((alias) => own.includes(alias));
}

/** 该成员当前正在执行的票：assignments 中 status=running 且 lastActivityAt 最新的一张。 */
function currentTicketFor(
  snapshot: TeamWorkbenchSnapshot,
  memberId: string,
): WorkbenchTicket | null {
  let best: WorkbenchTicket | null = null;
  let bestAt = "";
  for (const ticket of snapshot.tickets) {
    let candidateAt: string | null = null;
    for (const assignment of ticket.assignments) {
      if (assignment.status !== "running" || assignment.memberId !== memberId) continue;
      const at = assignment.lastActivityAt ?? "";
      if (candidateAt === null || at > candidateAt) candidateAt = at;
    }
    if (candidateAt === null) continue;
    // 严格大于保证同刻多票时取先出现者，结果稳定可复现。
    if (best === null || candidateAt > bestAt) {
      best = ticket;
      bestAt = candidateAt;
    }
  }
  return best;
}

/** 票 dependencies 中第一个未 ended 的依赖票 id（缺失/已满足的依赖跳过）。 */
function firstOpenDependency(
  ticket: WorkbenchTicket,
  ticketsById: Map<string, WorkbenchTicket>,
): string | null {
  for (const dependencyId of ticket.dependencies) {
    const dependency = ticketsById.get(dependencyId);
    // 已从列表消失的依赖视为已解除（与画布/统计口径一致）。
    if (dependency && dependency.status !== "ended") return dependencyId;
  }
  return null;
}

/** 快照消息中命中该成员收件（to/recipients）的条数；自己发出的不计。 */
function inboxCountFor(
  messages: readonly WorkbenchMessage[],
  member: WorkbenchMember,
): number {
  let count = 0;
  for (const message of messages) {
    if (identityMatches(member.id, member.name, message.from)) continue;
    const broadcast = message.kind === "broadcast" || message.to === "*";
    const explicit = [message.to, ...(message.recipients ?? [])]
      .filter((identity) => Boolean(identity) && identity !== "*");
    if (broadcast && explicit.length === 0) {
      count += 1;
      continue;
    }
    if (explicit.some((identity) => identityMatches(member.id, member.name, identity))) count += 1;
  }
  return count;
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
 * 编队带纯布局：给定画布宽度与快照，算出队长节点、成员分行与两条总线的坐标。
 *
 * 成员按名册顺序（稳定）排布：每行 membersPerRow(width) 张（上限 MAX_MEMBERS_PER_ROW），
 * 行内以 MEMBER_PITCH 间距、整体居中，行间以 MEMBER_ROW_PITCH 往下叠 —— 成员再多也
 * 只是多几行，画布宽度不再线性膨胀（旧实现 60 人 = 11.8k px）。几何全部由
 * arrangeFormationRows 产出，与「按紧急度重排」共用同一套换行口径。
 */
export function layoutFormation(snapshot: TeamWorkbenchSnapshot, width: number): FormationLayout {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : CANVAS_MIN_WIDTH;
  const lead = pickLead(snapshot);
  const allMembers = snapshot.members;
  const workers = allMembers.filter((member) => member !== lead);

  const leadCenter = safeWidth / 2;
  // 队长没有独立 runner：用「名册 running + 最近活动」推断其是否在读流，
  // 长时间无活动就显示 idle，别永远假装在干活。
  const leadStreaming = lead ? leadIsStreaming(snapshot, lead) : false;
  const ticketsById = new Map(snapshot.tickets.map((ticket) => [ticket.id, ticket]));
  const messages = snapshot.messages ?? [];

  const build = (member: WorkbenchMember, isLead: boolean): FormationMember => {
    const { segments, total, completed, urgency } = memberSegments(snapshot, member.id);
    const currentTicket = currentTicketFor(snapshot, member.id);
    return {
      member,
      isLead,
      // 位置先给占位值，随后由 arrangeFormationRows 按行写回（几何只有一个真源）。
      centerX: isLead ? leadCenter : 0,
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
      currentTicketId: currentTicket ? currentTicket.id : null,
      blockedDependencyId: currentTicket ? firstOpenDependency(currentTicket, ticketsById) : null,
      inboxCount: inboxCountFor(messages, member),
    };
  };

  const leadNode = lead ? build(lead, true) : null;
  const rows = arrangeFormationRows(workers.map((member) => build(member, false)), safeWidth);
  const workerNodes = rows.flatMap((row) => row.members);
  const rowCount = rows.length;

  return {
    width: safeWidth,
    height: formationBandHeight(rowCount),
    bottom: formationBandBottom(rowCount),
    lead: leadNode,
    workers: workerNodes,
    rows,
    rowCount,
    bus: {
      leadX: leadNode ? leadNode.centerX : null,
      firstWorkerX: rows[0]?.firstX ?? null,
      lastWorkerX: rows[0]?.lastX ?? null,
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
