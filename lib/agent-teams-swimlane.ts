/**
 * 泳道数据投影（pi-web 专属，只读）。
 *
 * 设计文档 docs/agent-teams-design.md §7 定义了给 H5 渲染的 `TeamWorkbenchSnapshot`：
 * 每成员一条水平泳道（y=成员，x=时间），成员事件节点 + 跨泳道流向 + 任务依赖。
 * 本模块把它从 pi-team 落盘的团队文件投影出来，**只读、不改会话内部状态**。
 *
 * 数据来源（~/.pi/agent/teams/<team>/，见 pi-team teamHelpers / teamPlanStore /
 * teamLifecycle / teammateMailbox）：
 *   - config.json     TeamFile（成员名册）
 *   - plan.json       TeamPlanRecord（tasks = 任务依赖图；members 带运行时）
 *   - lifecycle.json  成员运行态（idle/running/parked/aborted）
 *   - inboxes/*.json + *.history.jsonl  邮箱消息（谁→谁）
 *   - accepted.jsonl  验收账本（成员→lead 的交付）
 *   - tickets/<id>.json  pi-team team_ticket 的运行时工单（真实派活与状态）
 *   - acks/receipts.jsonl  消息已读回执（谁确认读过）
 *
 * 纯投影 + 纯布局：本模块**不 import node:fs**，客户端组件（AgentTermsView）与
 * 服务端路由都能安全 import。磁盘读取在 lib/agent-teams-swimlane-store.ts（服务端专用）。
 *
 * 兼容层：快照同时输出 `tasks[]`（lane-diagram.html 消费的 `{id,subject,owner,status,blockedBy}`
 * 形态）与设计文档 §7.1 的 `tickets[]/lanes[]/flows[]/taskAnchors[]`，一份数据喂两种渲染。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 输入：pi-team 落盘结构的结构类型（不 import pi-team，投影保持独立可测）
// ─────────────────────────────────────────────────────────────────────────────

/** config.json 里的成员（子集，够投影用）。 */
export interface TeamFileMemberLike {
  agentId: string;
  name: string;
  agentType?: string;
  model?: string;
  providerId?: string | null;
  providerName?: string;
  effortLevel?: string;
  color?: string;
  joinedAt: number;
  cwd: string;
  worktreePath?: string;
  sessionId?: string;
  isActive?: boolean;
  lastError?: string;
}

/** config.json（TeamFile）。 */
export interface TeamFileLike {
  name: string;
  description?: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId?: string;
  members: TeamFileMemberLike[];
}

/** plan.json 的成员（带运行时）。 */
export interface PlanMemberLike {
  id: string;
  name: string;
  agentType?: string;
  runtime?: { providerId?: string; modelId?: string; effortLevel?: string };
}

/** plan.json 的任务（依赖图的一环）。 */
export interface PlanTaskLike {
  id: string;
  subject: string;
  description?: string;
  ownerId?: string;
  dependencies: string[];
}

/** plan.json（TeamPlanRecord，取投影需要的字段）。 */
export interface PlanLike {
  planId?: string;
  state?: string;
  revision?: number;
  incarnationId?: string;
  createdAt?: number;
  updatedAt?: number;
  members?: PlanMemberLike[];
  tasks?: PlanTaskLike[];
}

/** lifecycle.json 的成员条目。 */
export type LifecycleStatus = "idle" | "running" | "parked" | "aborted";

export interface LifecycleEntryLike {
  name: string;
  sessionId?: string;
  sessionFile?: string;
  status: LifecycleStatus;
  generation?: number;
  parkedAt?: number;
  updatedAt?: number;
  lastError?: string;
}

/** 邮箱消息（inboxes/*.json 与 *.history.jsonl）。 */
export interface MailboxMessageLike {
  id?: string;
  from: string;
  /** 收件人：邮箱是按收件人分目录的，读取时由读取器补上（落盘消息体本身没有该字段）。 */
  to?: string;
  text: string;
  timestamp: string;
  read?: boolean;
  color?: string;
  summary?: string;
}

/** accepted.jsonl 的一条验收记录。 */
export interface AcceptedRecordLike {
  member: string;
  sessionId?: string;
  summary?: string;
  result?: string;
  at: string;
}

/**
 * tickets/<ticketId>.json 的运行时工单（pi-team team_ticket 工具写入，取投影需要的字段）。
 * 注意：assignee / subscribers 存的是**成员名**，不是 agentId（与 pi-team 落盘一致）。
 */
export interface RuntimeAssignmentLike {
  id: string;
  /** 成员名（不是 agentId）。 */
  assignee: string;
  status: "pending" | "running" | "ended";
  createdAt: number;
  updatedAt: number;
  result?: string;
  outcome?: "completed" | "failed" | "cancelled";
}

export interface RuntimeTicketLike {
  id: string;
  subject: string;
  description?: string;
  status: "open" | "ended";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  assignments: RuntimeAssignmentLike[];
  subscribers?: string[];
}

/** acks/receipts.jsonl 的一条已读回执；reader 是成员名。 */
export interface ReceiptLike {
  messageId: string;
  /** 成员名（不是 agentId）。 */
  reader: string;
  ackedAt: number;
}

export interface SwimlaneInput {
  teamName: string;
  team: TeamFileLike;
  plan?: PlanLike | null;
  lifecycle?: Record<string, LifecycleEntryLike>;
  /** 该团队全部邮箱消息（各成员 live + history 合并去重后由调用方提供）。 */
  messages?: MailboxMessageLike[];
  accepted?: AcceptedRecordLike[];
  /** pi-team team_ticket 写入的运行时工单（tickets/<id>.json）；缺省视为无。 */
  runtimeTickets?: RuntimeTicketLike[];
  /** acks/receipts.jsonl 的已读回执；缺省视为无。 */
  receipts?: ReceiptLike[];
  /** 快照生成时间（ISO）；缺省由调用方传入，保持纯函数确定性。 */
  generatedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出：TeamWorkbenchSnapshot（设计文档 §7.1）+ lane-diagram 兼容的 tasks[]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 成员在泳道/名册里的状态（由 lifecycle.json 投影；lead 恒 running）。
 * `parked` 是独立态：成员被挂起/停止后进 parked，**不并入 idle**——
 * 否则「停止成员」在界面上看不出生效（用户会以为操作失败）。
 */
export type MemberStatus = "running" | "idle" | "parked" | "completed" | "failed" | "aborted" | "queued";

export interface WorkbenchTeam {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  leadSessionId: string | null;
  status: "forming" | "running" | "finishing" | "completed" | "ended";
  incarnationId: string;
}

export interface WorkbenchMember {
  id: string;
  name: string;
  role: string;
  model: string | null;
  providerName: string | null;
  color: string;
  status: MemberStatus;
  activity: "active" | "idle";
  sessionId: string | null;
  cwd: string;
  worktreePath: string | null;
  lastError: string | null;
  joinedAt: string;
}

export interface WorkbenchAssignment {
  id: string;
  status: "pending" | "running" | "ended";
  /** 承担该派活的成员 agentId；名不在名册时为 null。 */
  memberId: string | null;
  /** 落盘原样的成员名（runtime 票的 assignee；plan 派生时为 owner 名）。 */
  assignee: string;
  sessionId: string | null;
  /**
   * ⚠️ 语义混合的兼容字段，**不要直接当「开始时间」消费**：
   * - plan 派生票：装的是成员 lifecycle 的 updatedAt（该成员「最后一次更新」时刻）；
   * - runtime 票：装的是 assignment 的 createdAt（该派活「开始」时刻）。
   * 同一字段名两种含义——对 plan 票画甘特是错的、对 runtime 票做停滞检测是错的。
   * 需要「最后活动时间」请用 lastActivityAt（语义单一）；需要「开始时间」请另建字段。
   * 此取值保持不变，以兼容未知消费方。
   */
  startedAt: string | null;
  /**
   * 最后一次活动时间（ISO，取底层记录的毫秒时间戳；无来源时为 null）。语义单一，可放心消费：
   * - runtime 票：assignment.updatedAt（该派活最后更新时间；RuntimeAssignmentLike 有该字段）；
   * - plan 派生票：成员 lifecycle.updatedAt（该成员最后更新时刻）。
   * 「停滞检测」应基于这里，而不是 startedAt。
   */
  lastActivityAt: string | null;
  result: string | null;
  outcome: "completed" | "failed" | "cancelled" | null;
}

export interface WorkbenchTicket {
  id: string;
  subject: string;
  description: string;
  ownerId: string | null;
  status: "open" | "ended";
  dependencies: string[];
  assignments: WorkbenchAssignment[];
  /** 来源：plan 任务派生、pi-team 运行时工单、或两者合并（同 id）。 */
  source: "plan" | "runtime" | "merged";
  /** 创建时间（ISO 字符串，取底层记录的毫秒时间戳；不可用时为空串）。用于泳道内追加式排序。 */
  createdAt: string;
}

export type SwimlaneEventType = "spawn" | "task" | "message" | "report";

export interface SwimlaneEvent {
  seq: number;
  at: string;
  type: SwimlaneEventType;
  /** 事件摘要（中文可读）。 */
  detail: string;
  /** task 事件：任务 ID。 */
  taskId?: string;
  /** message 事件：来源与去向。 */
  from?: string;
  to?: string;
  text?: string;
}

export interface WorkbenchLane {
  memberId: string;
  name: string;
  role: string;
  color: string;
  status: MemberStatus;
  events: SwimlaneEvent[];
}

export interface WorkbenchFlow {
  from: string;
  to: string;
  at: string;
  text: string;
  kind: "message" | "report";
  ticketId?: string;
  state?: string;
}

export interface WorkbenchTaskAnchor {
  ticketId: string;
  memberId: string;
  status: "pending" | "in_progress" | "completed" | "aborted";
  messageId: string | null;
  timestamp: string;
}

/** acks/receipts.jsonl 投影出的已读回执；reader 为成员名，readerId 为映射后的 agentId（不在名册则 null）。 */
export interface WorkbenchReceipt {
  messageId: string;
  reader: string;
  readerId: string | null;
  ackedAt: string;
}

/** lane-diagram.html 消费的扁平任务形态（cc-haha agentTeamsModel 对齐）。 */
export interface WorkbenchTask {
  id: string;
  subject: string;
  owner: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: string[];
}

export interface TeamWorkbenchSnapshot {
  version: 1;
  generatedAt: string;
  team: WorkbenchTeam;
  members: WorkbenchMember[];
  tickets: WorkbenchTicket[];
  lanes: WorkbenchLane[];
  flows: WorkbenchFlow[];
  taskAnchors: WorkbenchTaskAnchor[];
  /** lane-diagram.html 直接消费的兼容数组（由 tickets 投影）。 */
  tasks: WorkbenchTask[];
  /** acks/receipts.jsonl 的已读回执（新增字段，不影响既有字段语义）。 */
  receipts: WorkbenchReceipt[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯投影
// ─────────────────────────────────────────────────────────────────────────────

const PALETTE = ["blue", "green", "purple", "orange", "teal", "pink", "red"];

/** 成员组内配色：显式 color 优先，其次按名册顺序取调色板，lead 固定 gray。 */
function colorForMember(member: { color?: string }, index: number, isLead: boolean): string {
  if (member.color) return member.color;
  if (isLead) return "gray";
  return PALETTE[(index - 1 + PALETTE.length) % PALETTE.length];
}

/** pi-team 生命周期态 → 泳道成员态（lead 恒 running；parked 保持独立态，不并入 idle）。 */
function toMemberStatus(status: LifecycleStatus | undefined, isLead: boolean): MemberStatus {
  if (isLead) return "running";
  switch (status) {
    case "running":
      return "running";
    case "aborted":
      return "aborted";
    case "parked":
      return "parked";
    case "idle":
    case undefined:
      return "idle";
    default:
      return "queued";
  }
}

/** 从目标时间是否较新推断活动态；无更新时间按 idle。 */
function activityOf(status: MemberStatus): "active" | "idle" {
  return status === "running" ? "active" : "idle";
}

function isoFromMillis(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : "";
}

/**
 * 把「成员名 → 该成员是否有验收记录」建成集合，用于判定 ticket 是否 ended。
 * accepted.jsonl 的 member 是成员名。
 */
function acceptedMembers(accepted: readonly AcceptedRecordLike[]): Set<string> {
  return new Set(accepted.map((record) => record.member));
}

/**
 * 把 plan 成员 id 映射到名册成员 id（按 name 对齐）。名册已合并 config + plan，
 * 因此 plan 独有成员也能解析到自己的 memberId（见 buildRoster 的合并裁决）。
 */
function buildPlanMemberIdMap(
  members: readonly WorkbenchMember[],
  plan: PlanLike | null | undefined,
): Map<string, string> {
  const byName = new Map(members.map((member) => [member.name, member.id]));
  const map = new Map<string, string>();
  for (const planMember of plan?.members ?? []) {
    const memberId = byName.get(planMember.name);
    if (memberId) map.set(planMember.id, memberId);
  }
  return map;
}

/**
 * 合成名册：以 config.json 的成员为基准，把 plan.members 里「config 里没有的同名成员」追加在后。
 *
 * 为什么要合并：config.json 只在 `team_create` 时写一次；而 `team_plan launch` 派发成员只做
 * lifecycle.adopt、**从不写 config.json**，于是这些成员按 config 遍历时在泳道/编队带/名册/
 * 团队状态里完全不可见。tickets 早已做过 plan+runtime 合并，成员侧漏了这一层，属投影层自身
 * 的不一致。⚠️ 这是投影层对症——根因在 pi-team 的 launch 不写名册（外部包，我们改不了）。
 *
 * 合并裁决（成员身份按 name 对齐，与 tickets 的「同 id 运行时覆盖派生」不同）：
 * - 同名成员以 **config 为准**（身份 agentId、顺序、显式 color），plan 仅补 model/provider 缺口；
 * - plan 独有成员追加在后，memberId 取 plan 成员 id（plan 与 config 是两套 id 命名空间），
 *   若该 id 已被占用则追加 `#n` 后缀保证唯一（确定性）；
 * - 没有 plan.members 时结果与改动前逐字段等价。
 */
function buildRoster(
  team: TeamFileLike,
  plan: PlanLike | null | undefined,
  lifecycle: Record<string, LifecycleEntryLike>,
): WorkbenchMember[] {
  const members: WorkbenchMember[] = [];
  const seenNames = new Set<string>();
  const usedIds = new Set<string>();

  team.members.forEach((member, index) => {
    const isLead = member.name === team.leadAgentId || index === 0;
    const entry = lifecycle[member.name];
    const planMember = (plan?.members ?? []).find((item) => item.name === member.name);
    const status = toMemberStatus(entry?.status, isLead);
    members.push({
      id: member.agentId,
      name: member.name,
      role: member.agentType ?? (isLead ? "orchestrator" : "member"),
      model: member.model ?? planMember?.runtime?.modelId ?? null,
      // plan 侧没有 providerName，退用其 providerId（近似口径，仅供展示）。
      providerName: member.providerName ?? planMember?.runtime?.providerId ?? null,
      color: colorForMember(member, index, isLead),
      status,
      activity: activityOf(status),
      sessionId: member.sessionId ?? entry?.sessionId ?? null,
      cwd: member.cwd,
      worktreePath: member.worktreePath ?? null,
      lastError: member.lastError ?? entry?.lastError ?? null,
      joinedAt: isoFromMillis(member.joinedAt),
    });
    seenNames.add(member.name);
    usedIds.add(member.agentId);
  });

  (plan?.members ?? []).forEach((planMember, offset) => {
    if (!planMember.name || seenNames.has(planMember.name)) return;
    const index = team.members.length + offset;
    const isLead = planMember.name === team.leadAgentId;
    const entry = lifecycle[planMember.name];
    const status = toMemberStatus(entry?.status, isLead);
    let id = planMember.id || planMember.name;
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}#${suffix}`)) suffix += 1;
      id = `${id}#${suffix}`;
    }
    members.push({
      id,
      name: planMember.name,
      role: planMember.agentType ?? (isLead ? "orchestrator" : "member"),
      model: planMember.runtime?.modelId ?? null,
      providerName: planMember.runtime?.providerId ?? null,
      color: colorForMember({}, index, isLead),
      status,
      activity: activityOf(status),
      sessionId: entry?.sessionId ?? null,
      cwd: "",
      worktreePath: null,
      lastError: entry?.lastError ?? null,
      joinedAt: isoFromMillis(plan?.createdAt),
    });
    seenNames.add(planMember.name);
    usedIds.add(id);
  });

  return members;
}

/**
 * 纯投影：把团队名册 + 计划 + 生命周期 + 邮箱 + 验收账本投影成泳道快照。
 * 不读磁盘、不改任何外部状态。
 */
export function projectTeamWorkbench(input: SwimlaneInput): TeamWorkbenchSnapshot {
  const {
    teamName,
    team,
    plan = null,
    lifecycle = {},
    messages = [],
    accepted = [],
    runtimeTickets = [],
    receipts = [],
    generatedAt = "",
  } = input;

  const members = buildRoster(team, plan, lifecycle);

  const memberById = new Map(members.map((member) => [member.id, member]));
  const memberByName = new Map(members.map((member) => [member.name, member]));
  const planMemberIds = buildPlanMemberIdMap(members, plan);
  const acceptedNames = acceptedMembers(accepted);

  // ── tickets[]：plan.tasks 派生 + pi-team 运行时工单（tickets/<id>.json）合并 ──
  // 派生票在前；运行时独有的票（id 不与 plan 任务重复）按 createdAt 升序追加在后；
  // 同 id 时运行时的 assignments / status 覆盖派生值。没有运行时票时结果与改动前等价。
  const tasks = plan?.tasks ?? [];
  /**
   * accepted.jsonl 只有成员名、没有票 id（teamTools.js appendAccepted 落盘形态：
   * member/sessionId/summary/result/at），「成员被验收过」对 plan 派生票只能是成员
   * 粒度信号——成员一次验收会把名下全部 plan 派生票标 ended（D4-2，v2 裁定：
   * running 派生同为成员粒度，两口径一致，禁止大改派生口径）。
   * 唯一被认可可收窄的失真是「从未派发 runtime 票的 plan-only 票」：带 runtime 票的
   * 任务其真实状态由下方同 id 覆盖兜底，accepted 信号对它们只是占位。因此 ended
   * 只对**没有任何 runtime 票认领**的任务生效；runtime 票覆盖后，此处的 ended
   * 对这类票恒被替换为真实状态，原语义保留。
   */
  const runtimeTaskIds = new Set(
    runtimeTickets
      .map((runtime) => (typeof runtime?.id === "string" ? runtime.id : ""))
      .filter(Boolean),
  );
  const baseTickets: WorkbenchTicket[] = tasks.map((task) => {
    const ownerId = task.ownerId ? planMemberIds.get(task.ownerId) ?? null : null;
    const owner = ownerId ? memberById.get(ownerId) : undefined;
    const entry = owner ? lifecycle[owner.name] : undefined;
    const ended = Boolean(owner && acceptedNames.has(owner.name) && !runtimeTaskIds.has(task.id));
    const assignments: WorkbenchAssignment[] = [];
    if (owner) {
      assignments.push({
        id: `${task.id}-1`,
        status: ended ? "ended" : owner.status === "running" ? "running" : "pending",
        memberId: owner.id,
        assignee: owner.name,
        sessionId: owner.sessionId,
        startedAt: isoFromMillis(entry?.updatedAt) || null,
        lastActivityAt: isoFromMillis(entry?.updatedAt) || null,
        result: null,
        outcome: null,
      });
    }
    return {
      id: task.id,
      subject: task.subject,
      description: task.description ?? "",
      ownerId,
      status: ended ? "ended" : "open",
      dependencies: [...(task.dependencies ?? [])],
      assignments,
      source: "plan" as const,
      // plan 任务不带逐条创建时间，取整份计划的创建时间；同值再由 id 自然序兜底。
      createdAt: isoFromMillis(plan?.createdAt),
    };
  });

  const ticketById = new Map(baseTickets.map((ticket) => [ticket.id, ticket]));
  /** 落盘的 assignee（成员名）→ 名册成员；名不在名册则 undefined。 */
  const memberForName = (name: string | undefined): WorkbenchMember | undefined =>
    name ? memberByName.get(name) : undefined;

  const orderedRuntime = [...runtimeTickets].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  for (const runtime of orderedRuntime) {
    if (typeof runtime?.id !== "string" || !runtime.id) continue;
    const assignments: WorkbenchAssignment[] = (runtime.assignments ?? []).map((assignment) => {
      const member = memberForName(assignment.assignee);
      return {
        id: assignment.id,
        status: assignment.status,
        memberId: member?.id ?? null,
        assignee: assignment.assignee,
        sessionId: member?.sessionId ?? null,
        startedAt: isoFromMillis(assignment.createdAt) || null,
        lastActivityAt: isoFromMillis(assignment.updatedAt) || null,
        result: assignment.result ?? null,
        outcome: assignment.outcome ?? null,
      };
    });
    const existing = ticketById.get(runtime.id);
    if (existing) {
      // 同 id：运行时的 assignments/status 覆盖派生值，其余（subject/依赖）保留计划口径。
      existing.assignments = assignments;
      existing.status = runtime.status;
      existing.source = "merged";
      if (existing.ownerId === null) {
        existing.ownerId = assignments.find((item) => item.memberId)?.memberId ?? null;
      }
      continue;
    }
    const ticket: WorkbenchTicket = {
      id: runtime.id,
      subject: runtime.subject ?? "",
      description: runtime.description ?? "",
      ownerId: assignments.find((item) => item.memberId)?.memberId ?? null,
      status: runtime.status,
      dependencies: [],
      assignments,
      source: "runtime",
      createdAt: isoFromMillis(runtime.createdAt),
    };
    baseTickets.push(ticket);
    ticketById.set(ticket.id, ticket);
  }
  const tickets = baseTickets;

  // ── taskAnchors[]：每个有主的 ticket 锚到成员 lane ──────────────────────────
  /** 票内是否有 running 的派活（运行时票的主信号；派生票此时与 owner.status 等价）。 */
  const hasRunning = (ticket: WorkbenchTicket): boolean =>
    ticket.assignments.some((assignment) => assignment.status === "running");
  const anchorStatusOf = (ticket: WorkbenchTicket, owner: WorkbenchMember | undefined): WorkbenchTaskAnchor["status"] => {
    if (ticket.status === "ended") return "completed";
    if (hasRunning(ticket)) return "in_progress";
    if (owner?.status === "aborted") return "aborted";
    return "pending";
  };
  const taskAnchors: WorkbenchTaskAnchor[] = tickets
    .filter((ticket): ticket is WorkbenchTicket & { ownerId: string } => ticket.ownerId !== null)
    .map((ticket) => {
      const owner = memberById.get(ticket.ownerId);
      const entry = owner ? lifecycle[owner.name] : undefined;
      const assignmentTime = ticket.assignments.map((item) => item.startedAt).filter(Boolean).sort().at(-1);
      return {
        ticketId: ticket.id,
        memberId: ticket.ownerId,
        status: anchorStatusOf(ticket, owner),
        messageId: null,
        timestamp: isoFromMillis(entry?.updatedAt) || assignmentTime || "",
      };
    });

  // ── flows[]：邮箱消息（谁→谁）+ 验收报告（成员→lead）────────────────────────
  const flows: WorkbenchFlow[] = [];
  /**
   * 成员 → 该成员名下**最后一张**票的 id（tickets 顺序 = plan 顺序 + runtime 追加序）。
   * 口径固化（D4-7，经 v2 裁定）：邮箱消息与验收记录都不携带票 id，flow 的 ticketId
   * 只能是「收/发方成员名下某张票」的**近似**——成员多票时后写覆盖，恒指向最后一张。
   * 消费方（泳道 flow 连线）须把它当「该成员当前工作的票」提示，不是消息的精确归属；
   * 要精确归属需 pi-team 在消息/验收落盘里记 ticketId（上游契约，桌面侧改不了）。
   */
  const ticketIdByMember = new Map<string, string>();
  for (const ticket of tickets) {
    if (ticket.ownerId) ticketIdByMember.set(ticket.ownerId, ticket.id);
  }
  for (const message of messages) {
    const to = message.to ?? "";
    const toId = memberByName.get(to)?.id;
    flows.push({
      from: message.from,
      to,
      at: message.timestamp,
      text: message.summary ?? message.text,
      kind: "message",
      ...(toId && ticketIdByMember.has(toId) ? { ticketId: ticketIdByMember.get(toId) } : {}),
    });
  }
  for (const record of accepted) {
    const fromId = memberByName.get(record.member)?.id;
    flows.push({
      from: record.member,
      to: team.leadAgentId,
      at: record.at,
      text: record.summary ?? record.result ?? "已交付",
      kind: "report",
      ...(fromId && ticketIdByMember.has(fromId) ? { ticketId: ticketIdByMember.get(fromId) } : {}),
    });
  }

  // ── lanes[]：每成员一条；事件归「发起方」lane（与设计文档 §7.1 示例一致）──
  const lanes: WorkbenchLane[] = members.map((member) => {
    const events: Omit<SwimlaneEvent, "seq">[] = [];
    events.push({ at: member.joinedAt, type: "spawn", detail: `${member.name} 加入团队` });
    // 任务没有自己的时间戳：锚在计划创建/更新时间，退化到该成员生命周期更新时间，
    // 保证 lane 内顺序是「spawn → 领任务 → 消息/交付」而不是把任务排到最后。
    const taskAnchor = isoFromMillis(plan?.createdAt)
      || isoFromMillis(plan?.updatedAt)
      || isoFromMillis(lifecycle[member.name]?.updatedAt);
    for (const ticket of tickets) {
      if (ticket.ownerId !== member.id) continue;
      // plan 派生票没有自己的时间戳，沿用原锚点；运行时票用其最早的派活开始时间。
      const at = ticket.source === "plan"
        ? taskAnchor
        : ticket.assignments.map((item) => item.startedAt).filter((value): value is string => Boolean(value)).sort()[0] || taskAnchor;
      events.push({ at, type: "task", detail: ticket.subject, taskId: ticket.id });
    }
    for (const message of messages) {
      if (message.from !== member.name) continue;
      const to = message.to ?? "";
      if (!to) continue;
      events.push({ at: message.timestamp, type: "message", detail: message.summary ?? message.text, from: member.name, to, text: message.text });
    }
    for (const record of accepted) {
      if (record.member !== member.name) continue;
      events.push({ at: record.at, type: "report", detail: record.summary ?? record.result ?? "已交付", from: member.name, to: team.leadAgentId, text: record.result ?? "" });
    }
    const sorted = events
      .map((event, index) => ({ ...event, index }))
      .sort((a, b) => {
        const atA = a.at || "9999";
        const atB = b.at || "9999";
        if (atA !== atB) return atA < atB ? -1 : 1;
        return a.index - b.index;
      });
    return {
      memberId: member.id,
      name: member.name,
      role: member.role,
      color: member.color,
      status: member.status,
      events: sorted.map((event, seq) => ({ ...event, seq: seq + 1 })),
    };
  });

  // ── tasks[]：lane-diagram.html 兼容（按依赖深度分行）─────────────────────────
  const compatTasks: WorkbenchTask[] = tickets.map((ticket) => {
    const owner = ticket.ownerId ? memberById.get(ticket.ownerId) : undefined;
    const status: WorkbenchTask["status"] = ticket.status === "ended"
      ? "completed"
      : hasRunning(ticket)
        ? "in_progress"
        : "pending";
    return {
      id: ticket.id,
      subject: ticket.subject,
      owner: owner?.name ?? "",
      status,
      blockedBy: [...ticket.dependencies],
    };
  });

  // ── receipts[]：acks/receipts.jsonl 的已读回执（reader 成员名 → agentId）────
  const receiptItems: WorkbenchReceipt[] = receipts
    .filter((receipt) => receipt && typeof receipt.messageId === "string" && typeof receipt.reader === "string")
    .map((receipt) => ({
      messageId: receipt.messageId,
      reader: receipt.reader,
      readerId: memberByName.get(receipt.reader)?.id ?? null,
      ackedAt: isoFromMillis(receipt.ackedAt),
    }))
    .sort((a, b) => (a.ackedAt < b.ackedAt ? -1 : a.ackedAt > b.ackedAt ? 1 : 0));

  const teamStatus: WorkbenchTeam["status"] = (() => {
    if (tickets.length === 0) return "forming";
    const ended = tickets.filter((ticket) => ticket.status === "ended").length;
    if (ended === tickets.length) return "completed";
    if (plan?.state === "running" && ended > 0) return "finishing";
    if (plan?.state === "draft" || plan?.state === "review_pending") return "forming";
    return "running";
  })();

  return {
    version: 1,
    generatedAt,
    team: {
      id: teamName,
      name: team.name || teamName,
      description: team.description ?? "",
      createdAt: isoFromMillis(team.createdAt),
      leadSessionId: team.leadSessionId ?? null,
      status: teamStatus,
      incarnationId: plan?.incarnationId ?? teamName,
    },
    members,
    tickets,
    lanes,
    flows,
    taskAnchors,
    tasks: compatTasks,
    receipts: receiptItems,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯布局（lane canvas）：y=成员，x=时间。渲染层只消费坐标，不做数学。
// ─────────────────────────────────────────────────────────────────────────────

export const LANE_LABEL_WIDTH = 200;
export const EVENT_SPACING = 170;
export const EVENT_WIDTH = 140;
export const EVENT_HEIGHT = 44;
export const LANE_HEIGHT = 76;
export const LANE_GAP = 18;
const TIME_ORIGIN = LANE_LABEL_WIDTH + 24;

export interface LaidOutEvent {
  seq: number;
  at: string;
  type: SwimlaneEventType;
  detail: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutLane {
  memberId: string;
  name: string;
  role: string;
  status: MemberStatus;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  events: LaidOutEvent[];
}

export interface LaidOutFlow {
  from: string;
  to: string;
  kind: "message" | "report";
  text: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface SwimlaneLayout {
  lanes: LaidOutLane[];
  flows: LaidOutFlow[];
  width: number;
  height: number;
  columns: number;
}

/**
 * 纯布局：每个成员一行（lane），行内事件按时间序从左到右排。跨泳道流向用起点
 * （发送方事件右缘）到终点（收件方 lane 中线）的两点表示，由渲染层画曲线。
 */
export function layoutSwimlanes(snapshot: TeamWorkbenchSnapshot): SwimlaneLayout {
  const columns = Math.max(1, ...snapshot.lanes.map((lane) => lane.events.length));

  const lanes: LaidOutLane[] = snapshot.lanes.map((lane, rowIndex) => {
    const y = rowIndex * (LANE_HEIGHT + LANE_GAP);
    const events: LaidOutEvent[] = lane.events.map((event, columnIndex) => ({
      seq: event.seq,
      at: event.at,
      type: event.type,
      detail: event.detail,
      x: TIME_ORIGIN + columnIndex * EVENT_SPACING,
      y: y + (LANE_HEIGHT - EVENT_HEIGHT) / 2,
      width: EVENT_WIDTH,
      height: EVENT_HEIGHT,
    }));
    return {
      memberId: lane.memberId,
      name: lane.name,
      role: lane.role,
      status: lane.status,
      color: lane.color,
      x: 0,
      y,
      width: TIME_ORIGIN + columns * EVENT_SPACING,
      height: LANE_HEIGHT,
      events,
    };
  });

  const laneByMember = new Map(lanes.map((lane) => [lane.memberId, lane]));
  const laneByName = new Map(snapshot.members.map((member) => [member.name, laneByMember.get(member.id)]));

  const flows: LaidOutFlow[] = snapshot.flows.map((flow) => {
    const sender = laneByName.get(flow.from);
    const receiver = laneByName.get(flow.to);
    const anchor = sender?.events.find((event) => event.at === flow.at) ?? sender?.events[sender.events.length - 1];
    const fromX = anchor ? anchor.x + anchor.width : TIME_ORIGIN;
    const fromY = sender ? sender.y + LANE_HEIGHT / 2 : 0;
    return {
      from: flow.from,
      to: flow.to,
      kind: flow.kind,
      text: flow.text,
      fromX,
      fromY,
      toX: fromX + EVENT_SPACING,
      toY: receiver ? receiver.y + LANE_HEIGHT / 2 : fromY,
    };
  });

  return {
    lanes,
    flows,
    width: TIME_ORIGIN + columns * EVENT_SPACING + 24,
    height: Math.max(lanes.length * (LANE_HEIGHT + LANE_GAP), LANE_HEIGHT),
    columns,
  };
}
