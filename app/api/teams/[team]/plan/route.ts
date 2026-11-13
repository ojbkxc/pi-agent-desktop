import { NextResponse } from "next/server";
import { readTeamPlanView } from "@/lib/agent-teams-plan-store";
import {
  applyTeamPlanEdits,
  TeamPlanWriteError,
  type PlanMemberEdit,
  type PlanTaskEdit,
} from "@/lib/agent-teams-plan-write";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isLocalRequest } from "@/lib/remote-access";

export const dynamic = "force-dynamic";

/**
 * GET /api/teams/[team]/plan —— 计划卡的数据源（只读）。
 *
 * 返回 `{ plan: TeamPlanView | null }`：团队没有 plan.json（或解析失败 / state 未知）时为
 * `null`，界面据此不渲染卡片。这里不触发任何副作用——审批走
 * `POST /api/teams/[team]/plan/approve`（投递 prompt 给 lead）。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;
  try {
    const plan = await readTeamPlanView(team);
    return NextResponse.json({ plan });
  } catch (error) {
    return NextResponse.json(
      { plan: null, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/teams/[team]/plan —— 用户在计划卡里保存编辑（成员模型 / agent 预设 /
 * 任务负责人）。
 *
 * 与 cc-haha 的 `PATCH /api/teams/:name/plan` 同口径：带四字段乐观并发身份
 * （planId / sessionId / incarnationId / expectedRevision），保存后**保持** draft 或
 * review_pending 状态（评审中保存不该把计划打回草稿）。真正批准与派发仍在 lead 会话里，
 * 本路由只改字段。
 *
 * 写盘是本机行为：远程（中继手机）请求一律拒绝，与其它本地设置路由一致。
 */
interface PatchBody {
  planId?: unknown;
  sessionId?: unknown;
  incarnationId?: unknown;
  expectedRevision?: unknown;
  members?: unknown;
  tasks?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

function parseMembers(raw: unknown): PlanMemberEdit[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const edits: PlanMemberEdit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asString(record.id);
    if (!id) continue;
    const agentType = asString(record.agentType) ?? undefined;
    const runtimeRaw = record.runtime;
    let runtime: PlanMemberEdit["runtime"];
    if (runtimeRaw && typeof runtimeRaw === "object") {
      const runtimeRecord = runtimeRaw as Record<string, unknown>;
      const providerId = asString(runtimeRecord.providerId);
      const modelId = asString(runtimeRecord.modelId);
      if (!providerId || !modelId) {
        throw new TeamPlanWriteError(`成员 ${id} 的模型必须同时给出 provider 与 modelId`, 400);
      }
      const effortLevel = asString(runtimeRecord.effortLevel) ?? undefined;
      runtime = { providerId, modelId, ...(effortLevel ? { effortLevel } : {}) };
    }
    if (!agentType && !runtime) continue;
    edits.push({ id, ...(agentType ? { agentType } : {}), ...(runtime ? { runtime } : {}) });
  }
  return edits;
}

function parseTasks(raw: unknown): PlanTaskEdit[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const edits: PlanTaskEdit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asString(record.id);
    if (!id) continue;
    // 空串 = 取消分配（界面下拉的「未分配」）。
    if (typeof record.ownerId !== "string") continue;
    edits.push({ id, ownerId: record.ownerId });
  }
  return edits;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Team plans can only be edited on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { team } = await params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const planId = asString(body.planId);
  const sessionId = asString(body.sessionId);
  const incarnationId = asString(body.incarnationId);
  const expectedRevision =
    typeof body.expectedRevision === "number" && Number.isFinite(body.expectedRevision)
      ? body.expectedRevision
      : null;
  if (!planId || !sessionId || !incarnationId || expectedRevision === null) {
    return NextResponse.json(
      { error: "planId / sessionId / incarnationId / expectedRevision are required" },
      { status: 400 },
    );
  }

  try {
    const members = parseMembers(body.members);
    const tasks = parseTasks(body.tasks);
    const plan = await applyTeamPlanEdits(team, {
      planId,
      sessionId,
      incarnationId,
      expectedRevision,
      ...(members ? { members } : {}),
      ...(tasks ? { tasks } : {}),
    });
    return NextResponse.json({ plan });
  } catch (error) {
    if (error instanceof TeamPlanWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}