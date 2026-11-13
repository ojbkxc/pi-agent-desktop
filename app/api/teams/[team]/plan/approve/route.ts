import { NextResponse } from "next/server";
import { readTeamPlanView } from "@/lib/agent-teams-plan-store";
import { buildUserApprovalPrompt, checkPlanIdentity, desktopApprovalRequestId } from "@/lib/agent-teams-plan";
import { resolveTeamLeadSession } from "@/lib/agent-teams-swimlane-store";
import { defaultDeliver } from "@/lib/agent-teams-unattended-runtime";

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
 * body: { planId, sessionId, incarnationId, expectedRevision, requestId? }
 * 返回: { ok, requestId, reason? }（投递失败不静默：ok=false + reason，HTTP 502）。
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

  const requestId = asNonEmptyString(body.requestId) ?? desktopApprovalRequestId(plan);
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
  return NextResponse.json({ ok: true, requestId });
}
