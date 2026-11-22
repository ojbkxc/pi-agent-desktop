/**
 * B3 计划卡——**纯逻辑层**（客户端可安全 import，不含 node:fs）。
 *
 * 计划卡展示 `plan.json` 的评审态（launch 之前）：成员名册 + 任务依赖图 + 审批。
 * 真实的审批/派发副作用都在 pi-team 的 lead 会话里，桌面只投递 prompt（见
 * app/api/teams/[team]/plan/approve），这里只做纯派生：可见性、审批前置校验、文案构造。
 *
 * 契约（pi-team 8165e15 teamPlan.ts / teamPlanStore.ts）：
 * - `state` 取值 draft / review_pending / launching / running / launch_failed / cancelled /
 *   interrupted（`cancelled` / `interrupted` 在 schema 里，但 pi-team 没有 writer，只有
 *   服务端/界面能触发）。
 * - `revision` 是乐观并发版本号，每次写 +1；`expectedRevision` 不匹配即 409。
 * - `approveTeamPlan` 的幂等键是 `requestId`，同 id 会**先于 revision/state 校验**直接
 *   返回 committed=false（上游缺陷 A8）——所以 requestId 必须由 planId+revision 确定性
 *   生成，绝不能随机。
 */

export type PlanState =
  | "draft"
  | "review_pending"
  | "launching"
  | "running"
  | "launch_failed"
  | "cancelled"
  | "interrupted";

export type PlanRuntimeView = {
  providerId: string;
  modelId: string;
  effortLevel?: string;
};

export type PlanMemberView = {
  id: string;
  name: string;
  agentType: string;
  prompt: string;
  runtime: PlanRuntimeView;
  reason?: string;
  difficulty?: "low" | "medium" | "high";
};

export type PlanTaskView = {
  id: string;
  subject: string;
  description?: string;
  ownerId?: string;
  dependencies: string[];
};

/** GET /api/teams/[team]/plan 的载荷（plan.json 的展示子集）。 */
export type TeamPlanView = {
  planId: string;
  sessionId: string;
  teamName: string;
  incarnationId: string;
  state: PlanState;
  revision: number;
  leaderRuntime: PlanRuntimeView | null;
  members: PlanMemberView[];
  tasks: PlanTaskView[];
  parentPlanId?: string;
  feedback?: string;
  launch?: { status: "pending" | "running" | "failed"; error?: string };
  approvedSnapshot?: { revision: number; requestId: string };
  updatedAt: number;
};

export const PLAN_STATES: readonly PlanState[] = [
  "draft",
  "review_pending",
  "launching",
  "running",
  "launch_failed",
  "cancelled",
  "interrupted",
];

export function isPlanState(value: unknown): value is PlanState {
  return typeof value === "string" && (PLAN_STATES as readonly string[]).includes(value);
}

/**
 * 计划卡是否应显示（对齐 cc-haha AgentTeamsPlanCard.tsx:83 的收尾口径）：
 * - 无 plan / launching / running → 不显示（控制权已交给运行的团队）；
 * - cancelled **且无 parentPlanId** → 不显示（自己取消的团队，没什么可决定）；
 * - cancelled **带 parentPlanId**（并入运行中团队的增量计划）→ 显示，留给该团队的 Stop；
 * - 其余（draft / review_pending / launch_failed / interrupted）→ 显示。
 */
export function isPlanCardVisible(
  plan: Pick<TeamPlanView, "state" | "parentPlanId"> | null | undefined,
): boolean {
  if (!plan) return false;
  if (plan.state === "launching" || plan.state === "running") return false;
  if (plan.state === "cancelled") return Boolean(plan.parentPlanId);
  return true;
}

/** 与 pi-team teamPlan.ts:isValidTeamMemberName 一致：字母/数字/下划线/连字符，"team-lead" 保留。 */
export function isValidTeamMemberName(name: string): boolean {
  return /^[\p{L}\p{N}_-]+$/u.test(name) && name !== "team-lead";
}

/**
 * 运行时三元组是否可用。
 *
 * pi-team 写 `plan.leaderRuntime` 时读 `process.env.PI_PROVIDER_ID` / `PI_MODEL_ID`，而本服务
 * 进程从不设置它们（同 `PI_SESSION_ID`，见 docs/agents/agent-teams-upstream-defects.md B1）→
 * 真实机器上队长运行时恒为 `unknown/unknown`。界面必须把它当「未知」，否则「跟随队长模型」
 * 会把成员模型写成 `unknown/unknown`（一个必然 spawn 失败的值），队长那一行也会显示得像个真值。
 */
export function isUsableRuntime(
  runtime: Pick<PlanRuntimeView, "providerId" | "modelId"> | null | undefined,
): boolean {
  if (!runtime) return false;
  const provider = runtime.providerId?.trim() ?? "";
  const model = runtime.modelId?.trim() ?? "";
  return Boolean(provider && model && provider !== "unknown" && model !== "unknown");
}

/**
 * 这个计划当前能否批准。只有 `review_pending` 可以 —— `draft` 要先 submit，
 * `launch_failed` / `interrupted` 桌面侧没有重试入口（pi-team 的 team_plan 也没有 retry）。
 * 这条门禁很重要：批准路由对非 review_pending 一律 409，没有它按钮点了必然失败。
 */
export function isPlanApprovable(plan: Pick<TeamPlanView, "state">): boolean {
  return plan.state === "review_pending";
}

export interface PlanReview {
  /** 有任务没分到（成员不存在的）owner。 */
  hasUnassignedTasks: boolean;
  /** 不合法的成员名（会渲染到界面报错行）。 */
  invalidNames: string[];
  /**
   * agent 预设被改过。**恒为 false**：桌面侧的编辑是「改完显式保存」，草稿的未保存状态
   * 由卡片自己门禁（`PlanEditor` 的 onDirtyChange → 批准按钮禁用），不走这个字段。
   * 保留字段是为了跟 cc-haha 的 disabled 公式对齐、也留给将来服务端侧判定。
   */
  presetChanged: boolean;
}

/** 审批前置校验（对齐 cc-haha：disabled = presetChanged || hasUnassignedTasks || invalidNames>0）。 */
export function derivePlanReview(plan: Pick<TeamPlanView, "members" | "tasks">): PlanReview {
  const memberIds = new Set(plan.members.map((member) => member.id));
  const hasUnassignedTasks = plan.tasks.some(
    (task) => !task.ownerId || !memberIds.has(task.ownerId),
  );
  const invalidNames = plan.members
    .filter((member) => !isValidTeamMemberName(member.name))
    .map((member) => member.name);
  // 未保存的编辑由卡片自己的 dirty 门禁处理（见 PlanReview.presetChanged 说明）。
  return { hasUnassignedTasks, invalidNames, presetChanged: false };
}

export function isApproveDisabled(plan: Pick<TeamPlanView, "members" | "tasks">): boolean {
  const review = derivePlanReview(plan);
  return review.presetChanged || review.hasUnassignedTasks || review.invalidNames.length > 0;
}

/** 审批请求的乐观并发身份（与 pi-team `TeamPlanIdentity` 对齐的四字段）。 */
export interface PlanIdentity {
  planId: string;
  sessionId: string;
  incarnationId: string;
  expectedRevision: number;
}

/**
 * 校验审批请求的 identity 是否与磁盘计划一致（对齐 pi-team `requireCurrent`）。
 * 任一字段不匹配即 409「plan changed」——由调用方翻成 HTTP 409。
 */
export function checkPlanIdentity(
  plan: Pick<TeamPlanView, "planId" | "sessionId" | "incarnationId" | "revision">,
  identity: PlanIdentity,
): { ok: boolean; reason?: string } {
  if (
    plan.planId !== identity.planId ||
    plan.sessionId !== identity.sessionId ||
    plan.incarnationId !== identity.incarnationId ||
    plan.revision !== identity.expectedRevision
  ) {
    return { ok: false, reason: "plan changed; refresh before continuing" };
  }
  return { ok: true };
}

/**
 * 审批幂等键：由 planId + revision **确定性**拼出。
 *
 * 不用 `approvalRequestId`（那是无人值守提醒的键，前缀不同、语义不同，避免两条链路互相
 * 当作对方的幂等命中）。revision 变则 id 变（改版后重新批准是允许的一次新提交）。
 */
export function desktopApprovalRequestId(plan: Pick<TeamPlanView, "planId" | "revision">): string {
  return `desktop-approve-${plan.planId}-r${plan.revision}`;
}

/** 成员名册的一行（prompt 里用；名字 + 预设 + 它负责的任务 id）。 */
function describePlanMember(plan: TeamPlanView, member: PlanMemberView): string {
  const owned = plan.tasks.filter((task) => task.ownerId === member.id).map((task) => task.id);
  const preset = member.agentType?.trim() || "general-purpose";
  return `- ${member.name}（${preset}）：${owned.length > 0 ? `负责任务 ${owned.join("、")}` : "暂无负责任务，派发后按依赖接力领活"}`;
}

/**
 * 用户手动「批准」时投递给 lead 的 prompt。
 *
 * 桌面**不能**自己 approve（会漏写 approvedSnapshot → 审批判定 false）也**不能** launch
 * （需要 TeamHost spawn 子会话）。所以让 lead 用 team_plan 工具分两步做：approve → launch。
 * 上游 approve **不会自动 launch**（计划批准后停在 launching/pending），必须显式 launch。
 *
 * 文案必须把「一次把全部成员并行派出、任务并行推进」说清楚：lead 是模型，没人催它就会
 * 图省事只派一两个成员、然后串行等每个成员返回（用户看到的是「团队只干了一件事」）。
 * 计划里的成员名册也一并列出，避免它拿着 id 猜名字派错人。四件身份信息
 * （team 名 / planId / revision / request_id）缺一个它就找不到对应计划。
 */
export function buildUserApprovalPrompt(plan: TeamPlanView): string {
  const requestId = desktopApprovalRequestId(plan);
  const memberCount = plan.members.length;
  const taskCount = plan.tasks.length;
  const roster =
    memberCount > 0
      ? plan.members.map((member) => describePlanMember(plan, member))
      : ["- （计划里没有成员：先按用户批准的这份计划补成员，再 launch，不要空跑）"];
  const launchStep =
    memberCount > 0
      ? `3. launch 要**一次把计划里的全部 ${memberCount} 个成员一起派出去**（一次 launch 就是整批派发）：不要只派队长或前几个、不要漏人、不要为同一个成员反复 launch（会重复 spawn），也不要先等某个成员跑完再派下一个。目标是 ${memberCount} 个成员同时在跑。`
      : `3. 计划里没有成员：先按用户批准的这份计划补齐成员，再用一次 launch 整批派出；不要空跑，也不要因为没成员就跳过 launch。`;
  return [
    `这是用户在界面里手动批准的「计划评审」，不是你本人（模型）发起的——用户点了「批准」，不需要再向用户确认。`,
    `团队「${plan.teamName}」的计划（team=${plan.teamName}，planId=${plan.planId}，revision=${plan.revision}）已获用户批准：成员 ${memberCount} 个、任务 ${taskCount} 个。请立刻收尾：`,
    `1. 先用 team_plan 的 approve 操作批准当前计划。批准必须带 request_id，且**只能**用这个值：${requestId}（系统按 planId + revision 生成）。不要自己另编 id——同 id 才幂等，编新 id 会导致重复批准。`,
    `2. approve 成功后**立刻**用 team_plan 的 launch 操作派发成员——上游 approve 只把计划置为 launching（launch.status=pending），不会自动派发；不 launch 计划会永远停在待派发。`,
    launchStep,
    `4. 任务并行推进，只按 dependencies 卡顺序：互不依赖的任务**同时**开工；有依赖的任务在依赖完成的第一时间接力。不要为了「稳」把本可并行的任务串成一条链，也不要把活压到一两个成员身上——成员空转时给它补活。`,
    `5. 若 approve 返回「该批准已记录过」（committed=false，幂等命中），**不要重复批准**，直接执行第 2 步的 launch。`,
    `6. 完成后用一句话汇报：approve 用的 request_id、实际 launch 的成员数、并行开出的任务。`,
    `成员与分工（同一次 launch 全部派出）：`,
    ...roster,
  ].join("\n");
}
