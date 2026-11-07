/**
 * 无人值守兜底——决策核心。
 *
 * 痛点：团队计划提交后 `state === "review_pending"`，要等人批准；用户不在，lead 就
 * 一直等，团队永远不启动。本模块不替用户做决定，只决定「该提醒哪个 lead、提醒什么」，
 * 由 runtime 层把话带给 lead，让它用自己的 team_plan 工具完成降级与审批（AI 能判断
 * 边界：计划非法、降级不可行时应当拒绝而不是硬批）。
 *
 * 设计约束（勿破）：
 * - **纯函数、可注入时间**：不 import node:fs、不 import pi SDK，客户端也能安全 import；
 * - 输入「等待中的计划 + 失败派活 + 配置 + 已有记录」→ 输出「动作列表 + 下一份记录」，
 *   同输入恒同输出（排序全按 id 字典序），便于单测；
 * - 记录（approvalNudges / failureNudges）由本模块推进：调用方把返回的 `state` 持久化，
 *   等价于「已提醒」的账本，保证不重复提醒、失败恢复限次。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────────────────

export interface UnattendedConfig {
  /** 总开关；默认开（默认模型本就是 Flash，降级风险低）。 */
  enabled: boolean;
  /** 计划等待超过该时长仍未批准即提醒 lead（毫秒）。 */
  approvalTimeoutMs: number;
  /** 每张票最多自动提醒几次失败恢复；超过只通知用户，绝不无限重试。 */
  maxFailureRetries: number;
}

export const DEFAULT_UNATTENDED_CONFIG: UnattendedConfig = Object.freeze({
  enabled: true,
  approvalTimeoutMs: 10 * 60_000,
  maxFailureRetries: 2,
});

// ─────────────────────────────────────────────────────────────────────────────
// 输入
// ─────────────────────────────────────────────────────────────────────────────

export interface AwaitingPlanMember {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
}

export interface AwaitingPlan {
  teamName: string;
  planId: string;
  revision: number;
  /** lead 会话 id（plan.json 的 sessionId，见 store 的说明——不读 config 的 leadSessionId）。 */
  sessionId: string;
  /**
   * 计划最后一次写入的时间（epoch ms）。
   *
   * ⚠️ 近似：`TeamPlanRecord` 只有 createdAt / updatedAt / approvedAt，**没有 submittedAt**。
   * 在 `review_pending` 下，最后一次写盘就是「提交待批」，故用 updatedAt 近似提交时刻。
   * 这是近似而非精确值——和 startedAt 是同一类语义陷阱，别再埋一个。
   */
  updatedAt: number;
  members: readonly AwaitingPlanMember[];
}

export interface FailedAssignment {
  teamName: string;
  /** lead 会话 id（来自该团队的 plan.json）。 */
  sessionId: string;
  ticketId: string;
  ticketSubject: string;
  assignmentId: string;
  /** 成员名（assignee，pi-team 落的是名字不是 agentId）。 */
  member: string;
  providerId: string | null;
  modelId: string | null;
  /** 失败原因（assignments[].result 或缺失）。 */
  error: string | null;
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 记录（持久化的账本）
// ─────────────────────────────────────────────────────────────────────────────

export interface FailureNudgeRecord {
  /** 已就「第几次失败」提醒过 lead（= 已处理的失败次数，按 ticket 累计）。 */
  attempts: number;
  /** 最近处理的那个失败 assignment id，用于「同一失败不重复提醒」。 */
  lastAssignmentId: string;
  /** 已达上限并通知过用户；避免每 tick 重复通知。 */
  exhaustedNotified: boolean;
}

export interface UnattendedState {
  /** planId -> 已提醒过的 revision（计划改版后 revision 变，可再提醒一次）。 */
  approvalNudges: Record<string, number>;
  /** ticketId -> 失败恢复账本。 */
  failureNudges: Record<string, FailureNudgeRecord>;
  /**
   * 需要人工介入的项（送达失败 / 已耗尽重试）。
   * key: `plan:<planId>` 或 `ticket:<ticketId>`。本模块不写、只透传。
   */
  manualNeeds?: Record<string, { at: number; reason: string }>;
}

export const EMPTY_UNATTENDED_STATE: UnattendedState = Object.freeze({
  approvalNudges: {},
  failureNudges: {},
});

// ─────────────────────────────────────────────────────────────────────────────
// 输出：动作
// ─────────────────────────────────────────────────────────────────────────────

export interface NudgeApprovalAction {
  kind: "nudge-approval";
  teamName: string;
  sessionId: string;
  planId: string;
  revision: number;
  waitedMs: number;
  members: readonly AwaitingPlanMember[];
  prompt: string;
}

export interface NudgeFailureAction {
  kind: "nudge-failure";
  teamName: string;
  sessionId: string;
  ticketId: string;
  ticketSubject: string;
  assignmentId: string;
  member: string;
  attempts: number;
  maxRetries: number;
  prompt: string;
}

export interface NotifyExhaustedAction {
  kind: "notify-exhausted";
  teamName: string;
  sessionId: string;
  ticketId: string;
  ticketSubject: string;
  member: string;
  attempts: number;
}

export type UnattendedAction = NudgeApprovalAction | NudgeFailureAction | NotifyExhaustedAction;

export interface UnattendedDecision {
  actions: UnattendedAction[];
  /** 下一份记录（应持久化；即使动作送达失败也要落盘，否则会每 tick 重发）。 */
  state: UnattendedState;
}

// ─────────────────────────────────────────────────────────────────────────────
// 文案
// ─────────────────────────────────────────────────────────────────────────────

/** 把毫秒等待时长写成人类可读的中文（分钟 / 小时）。 */
export function formatWaited(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** 提醒 lead：计划久等未批，请自行降级并批准（含边界与汇报要求）。 */
export function buildApprovalPrompt(plan: AwaitingPlan, waitedMs: number): string {
  const models = plan.members
    .map((member) => `${member.name}（当前 ${member.providerId}/${member.modelId}）`)
    .join("、");
  return [
    `【无人值守提醒】团队「${plan.teamName}」的计划已提交并等待人工批准约 ${formatWaited(waitedMs)}，用户当前不在。`,
    `请你自己完成收尾，不要再等用户：`,
    `1. 用 team_plan 的 approve 操作批准当前计划（planId=${plan.planId}，revision=${plan.revision}）。`,
    `2. 批准前先把重模型成员降级：优先挑 modelId 匹配 /flash/i 的模型，且优先与成员同一 provider；找不到 Flash 就保持原样，别硬改。成员与当前模型：${models || "（未列出）"}。`,
    `3. 若计划本身非法或无法执行（例如 validateTeamPlanGraph 会拒绝），不要硬批——直接停下并说明原因。`,
    `4. 完成后用一句话汇报你到底做了什么（降级了谁、是否批准、理由）。`,
  ].join("\n");
}

/** 提醒 lead：成员失败，请判断换模型重派还是自己接管（含限次与边界）。 */
export function buildFailurePrompt(
  assignment: FailedAssignment,
  attempts: number,
  maxRetries: number,
): string {
  const model = assignment.providerId && assignment.modelId
    ? `${assignment.providerId}/${assignment.modelId}`
    : "（未知模型）";
  return [
    `【失败恢复提醒】团队成员「${assignment.member}」用模型 ${model} 执行工单「${assignment.ticketSubject}」(id=${assignment.ticketId}) 时失败，用户当前不在。`,
    `失败原因：${assignment.error ?? "（未记录）"}`,
    `请你自己处理，不要再等用户：`,
    `1. 先判断是模型能力不足、依赖/环境问题，还是任务定义本身有问题。`,
    `2. 适合换模型重派就换一个更稳/更强的模型重新派发这张票。`,
    `3. 不适合重派就你自己接管这张票。`,
    `4. 若判断无法安全重试（例如任务定义有错），不要硬试——说明原因并停下。`,
    `5. 完成后用一句话汇报你做了什么。`,
    `（本票累计已自动提醒 ${attempts} 次，上限 ${maxRetries} 次；达到上限后系统只通知用户、不再提醒。）`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 决策
// ─────────────────────────────────────────────────────────────────────────────

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface PlanUnattendedInput {
  /** 当前时间（epoch ms）。 */
  now: number;
  config: UnattendedConfig;
  awaitingPlans: readonly AwaitingPlan[];
  failedAssignments: readonly FailedAssignment[];
  state: UnattendedState;
}

/**
 * 求「这一 tick 该发什么」。
 *
 * 审批提醒：等待 ≥ approvalTimeoutMs 且该 planId 的该 revision 尚未提醒过 → 提醒一次；
 * 计划改版（revision 变）后允许再提醒一次。
 * 失败恢复：每张票只认「最新那个失败 assignment」；同一 assignment 不重复提醒；出现新的
 * 失败（新 assignmentId）才 +1；达到上限后只发一次 notify-exhausted。
 *
 * 无 sessionId（无从投递）的计划/工单一律跳过。
 */
export function planUnattendedActions(input: PlanUnattendedInput): UnattendedDecision {
  const keepState = input.state;
  if (!input.config.enabled) return { actions: [], state: keepState };

  const approvalNudges = { ...input.state.approvalNudges };
  const failureNudges = { ...input.state.failureNudges };
  const actions: UnattendedAction[] = [];

  // ── 超时降级审批 ──
  const plans = input.awaitingPlans
    .filter((plan) => !!plan.sessionId && Number.isFinite(plan.updatedAt))
    .slice()
    .sort((a, b) => byId(a.planId, b.planId));
  for (const plan of plans) {
    const waitedMs = input.now - plan.updatedAt;
    if (waitedMs < input.config.approvalTimeoutMs) continue;
    if (approvalNudges[plan.planId] === plan.revision) continue;
    approvalNudges[plan.planId] = plan.revision;
    actions.push({
      kind: "nudge-approval",
      teamName: plan.teamName,
      sessionId: plan.sessionId,
      planId: plan.planId,
      revision: plan.revision,
      waitedMs,
      members: plan.members,
      prompt: buildApprovalPrompt(plan, waitedMs),
    });
  }

  // ── 失败恢复 ──
  const latestByTicket = new Map<string, FailedAssignment>();
  for (const assignment of input.failedAssignments) {
    const prev = latestByTicket.get(assignment.ticketId);
    if (
      !prev
      || assignment.updatedAt > prev.updatedAt
      || (assignment.updatedAt === prev.updatedAt && byId(prev.assignmentId, assignment.assignmentId) < 0)
    ) {
      latestByTicket.set(assignment.ticketId, assignment);
    }
  }
  const tickets = [...latestByTicket.values()]
    .filter((assignment) => !!assignment.sessionId)
    .sort((a, b) => byId(a.ticketId, b.ticketId));
  for (const assignment of tickets) {
    const prev = failureNudges[assignment.ticketId];
    if (prev && prev.lastAssignmentId === assignment.assignmentId) continue;
    const attempts = (prev?.attempts ?? 0) + 1;
    if (attempts <= input.config.maxFailureRetries) {
      failureNudges[assignment.ticketId] = {
        attempts,
        lastAssignmentId: assignment.assignmentId,
        exhaustedNotified: prev?.exhaustedNotified ?? false,
      };
      actions.push({
        kind: "nudge-failure",
        teamName: assignment.teamName,
        sessionId: assignment.sessionId,
        ticketId: assignment.ticketId,
        ticketSubject: assignment.ticketSubject,
        assignmentId: assignment.assignmentId,
        member: assignment.member,
        attempts,
        maxRetries: input.config.maxFailureRetries,
        prompt: buildFailurePrompt(assignment, attempts, input.config.maxFailureRetries),
      });
    } else {
      const alreadyNotified = prev?.exhaustedNotified ?? false;
      failureNudges[assignment.ticketId] = { attempts, lastAssignmentId: assignment.assignmentId, exhaustedNotified: true };
      if (!alreadyNotified) {
        actions.push({
          kind: "notify-exhausted",
          teamName: assignment.teamName,
          sessionId: assignment.sessionId,
          ticketId: assignment.ticketId,
          ticketSubject: assignment.ticketSubject,
          member: assignment.member,
          attempts: input.config.maxFailureRetries,
        });
      }
    }
  }

  return { actions, state: { ...keepState, approvalNudges, failureNudges } };
}

/** 一份送给用户的通知文案（push body）。 */
export function describeAction(action: UnattendedAction): string {
  switch (action.kind) {
    case "nudge-approval":
      return `团队「${action.teamName}」的计划等待批准超过 ${formatWaited(action.waitedMs)}，已自动提醒 lead 降级为 Flash 并批准。`;
    case "nudge-failure":
      return `工单「${action.ticketSubject}」的成员「${action.member}」执行失败，已第 ${action.attempts}/${action.maxRetries} 次自动提醒 lead 换模型重派或接管。`;
    case "notify-exhausted":
      return `工单「${action.ticketSubject}」失败已达自动重试上限（${action.attempts} 次），已停止自动提醒，需要你人工处理。`;
  }
}
