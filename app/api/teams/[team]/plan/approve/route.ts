import { NextResponse } from "next/server";
import { readTeamPlanView } from "@/lib/agent-teams-plan-store";
import { buildUserApprovalPrompt, checkPlanIdentity, desktopApprovalRequestId } from "@/lib/agent-teams-plan";
import { resolveTeamLeadSession } from "@/lib/agent-teams-swimlane-store";
import { defaultDeliver } from "@/lib/agent-teams-unattended-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * POST /api/teams/[team]/plan/approve —— 用户在计划卡上点「批准」。
 *
 * **不写 plan.json**：真正的 approve 是 lead 的 `team_plan` 工具（原子写 approvedSnapshot +
 * launch.status=pending），而 launch 要 TeamHost 逐个 spawn 子会话——桌面都没有这两样能力。
 * 自写盘会漏掉 approvedSnapshot，`isTeamExecutionApproved()` 判定 false，团队起不来。
 *
 * 所以这里只做一件事：把批准指令**投递给 lead 会话**（复用兜底提醒同一条投递链路，lead
 * 不在会先 revive），由 lead 用 team_plan 分两步执行 approve → launch。幂等键由 planId +
 * revision 确定性生成（上游 A8：同 requestId 会先于 revision/state 校验直接 committed=false，
 * 随机 id 会导致重复批准）。
 *
 * 三重门（与其它会触发副作用的 POST 路由一致）：
 * - host/Origin 校验：挡掉跨站页面借用户浏览器发起的「批准」（本路由会让 lead 立刻 spawn
 *   一整个团队，是最贵的副作用之一）；
 * - `application/json`：挡掉表单/text-plain 的「简单请求」CSRF（那种请求不触发预检，也不
 *   被 Origin 头覆盖）；
 * - **不**要求 `isLocalRequest`：中继手机/Tailscale 上的用户也该能批准自己团队的计划，
 *   投递目标仍是本机的 lead 会话（与远程用户发一条聊天消息等价）。
 *
 * body: { planId, sessionId, incarnationId, expectedRevision, requestId? }
 * 返回: { ok, requestId, reason? }（投递失败不静默：ok=false + reason，HTTP 502）
 */
interface ApproveBody {
  planId?: unknown;
  sessionId?: unknown;
  incarnationId?: unknown;
  expectedRevision?: unknown;
  requestId?: unknown;
}

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, reason: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { ok: false, reason: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  const { team } = await params;

  let body: ApproveBody;
  try {
    body = (await req.json()) as ApproveBody;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid JSON body" }, { status: 400 });
  }

  const planId = asNonEmptyString(body.planId);
  const sessionId = asNonEmptyString(body.sessionId);
  const incarnationId = asNonEmptyString(body.incarnationId);
  const expectedRevision =
    typeof body.expectedRevision === "number" && Number.isFinite(body.expectedRevision)
      ? body.expectedRevision
      : null;
  if (!planId || !sessionId || !incarnationId || expectedRevision === null) {
    return NextResponse.json(
      { ok: false, reason: "planId / sessionId / incarnationId / expectedRevision are required" },
      { status: 400 },
    );
  }

  const plan = await readTeamPlanView(team);
  if (!plan) {
    return NextResponse.json({ ok: false, reason: "plan not found" }, { status: 404 });
  }
  // 乐观并发：identity 四字段必须与磁盘一致（对齐 pi-team requireCurrent）。
  const identityCheck = checkPlanIdentity(plan, { planId, sessionId, incarnationId, expectedRevision });
  if (!identityCheck.ok) {
    return NextResponse.json({ ok: false, reason: identityCheck.reason }, { status: 409 });
  }
  if (plan.state !== "review_pending") {
    return NextResponse.json(
      { ok: false, reason: `plan is not awaiting review (state ${plan.state})` },
      { status: 409 },
    );
  }

  // 幂等键只认 planId + revision 的确定性值。调用方**可以**传 requestId，但只要跟确定性
  // 值不一致就一律 400：上游对同一个 requestId 会在 revision/state 校验之前直接返回
  // committed=false，一个随机/过期 id 会让「批准」看起来成功、实际什么都没派发。
  const requestId = desktopApprovalRequestId(plan);
  const suppliedRequestId = asNonEmptyString(body.requestId);
  if (suppliedRequestId && suppliedRequestId !== requestId) {
    return NextResponse.json(
      {
        ok: false,
        reason: `requestId must be the deterministic value ${requestId} (planId + revision); a random id silently skips the upstream revision check`,
      },
      { status: 400 },
    );
  }

  const prompt = buildUserApprovalPrompt(plan);
  // 投递目的地：**不能**直接用 plan.sessionId —— 那也是 pi-team 读 PI_SESSION_ID 记的
  // 占位 'unknown-session'（见 docs/agents/agent-teams-upstream-defects.md B1）。优先用
  // 磁盘上可反推的真实 lead 会话（成员会话的 parentSessionId），其次才是 plan 里的值。
  // identity 校验仍用请求里的 sessionId（那是审批幂等语义的一部分），只有投递换目标。
  const leadSessionId = await resolveTeamLeadSession(team).catch(() => null);
  const deliverTo = leadSessionId ?? plan.sessionId;
  const result = await defaultDeliver(deliverTo, prompt);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, requestId, reason: result.reason ?? "delivery failed" },
      { status: 502 },
    );
  }
  // 回一份投递后立刻读到的计划视图：客户端据此省掉「等下一轮 2s 轮询才发现状态变了」。
  // 读失败不影响投递本身——批准已经送达，这里只是让界面早一点知道。
  const after = await readTeamPlanView(team).catch(() => null);
  return NextResponse.json({ ok: true, requestId, plan: after ?? undefined });
}
