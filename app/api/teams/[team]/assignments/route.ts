import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveTeamHost } from "pi-team";
import {
  dispatchAssignment,
  dispatchViaBus,
  AssignmentConflictError,
  AssignmentNotFoundError,
  isValidTicketId,
  type DispatchAssignmentInput,
} from "@/lib/agent-teams-assignments";
import { readTeamConfigSnapshot, teamDirFor } from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/teams/[team]/assignments —— 工单首次分配 / 改派（#54）。
 *
 * 首次分配：{ clientRequestId, ticketId, toMember, note? }
 * 改派：    { clientRequestId, ticketId, assignmentId, toMember, note?, expectedUpdatedAt }
 * 返回 { ok, ticketId, assignment:{ id, assignee, status, updatedAt }, delivery:{ to, outcome, error? } | { to, skipped:"already-delivered" }, warnings?, error? }。
 *
 * 语义（v5 设计钉死）：持久化归属 + 真正通知/唤醒接手成员（绝不只写盘）；幂等按
 * clientRequestId sidecar 多记录精确指纹；running（含 orphan-running）改派 409；
 * delivery.outcome 的 UI 文案契约：woken = 「已投递，唤醒中」（#flush void 且 wake
 * 失败被吞，teamBus.js:326-345——不得标「已执行」）。
 */

interface AssignmentsBody {
  clientRequestId?: unknown;
  ticketId?: unknown;
  assignmentId?: unknown;
  toMember?: unknown;
  note?: unknown;
  expectedUpdatedAt?: unknown;
}

function asString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;
  const teamDirName = decodeURIComponent(team);

  let body: AssignmentsBody;
  try {
    body = await req.json() as AssignmentsBody;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const clientRequestId = asString(body.clientRequestId, 128);
  const ticketId = asString(body.ticketId, 128);
  const toMember = asString(body.toMember, 64);
  if (!clientRequestId || !ticketId || !toMember) {
    return NextResponse.json(
      { error: "clientRequestId、ticketId、toMember 必填且长度受限（128/128/64）" },
      { status: 400 },
    );
  }
  if (!isValidTicketId(ticketId)) {
    return NextResponse.json({ error: "ticketId 含非法字符" }, { status: 400 });
  }
  const isReassign = typeof body.assignmentId === "string" && body.assignmentId.length > 0;
  const assignmentId = isReassign ? asString(body.assignmentId, 128) : null;
  if (isReassign && !assignmentId) {
    return NextResponse.json({ error: "assignmentId 长度受限（128）" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 2000) : undefined;
  const expectedUpdatedAtRaw = body.expectedUpdatedAt;
  const expectedUpdatedAt = typeof expectedUpdatedAtRaw === "number" && Number.isFinite(expectedUpdatedAtRaw)
    ? expectedUpdatedAtRaw
    : undefined;
  if (isReassign && expectedUpdatedAt === undefined) {
    return NextResponse.json({ error: "改派必须带 expectedUpdatedAt（读取工单时的 assignment.updatedAt）" }, { status: 400 });
  }

  const config = await readTeamConfigSnapshot(teamDirName);
  if (!config) {
    return NextResponse.json({ error: "团队不存在" }, { status: 404 });
  }
  const teamDir = teamDirFor(teamDirName);
  const rawTeamName = config.rawName;

  const input: DispatchAssignmentInput = {
    action: isReassign ? "reassign" : "assign",
    clientRequestId,
    ticketId,
    ...(assignmentId ? { assignmentId } : {}),
    toMember,
    ...(note !== undefined ? { note } : {}),
    ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
  };

  const deps = {
    teamDir,
    rawTeamName,
    // route 时刻快照（回退用）；真实判定在票锁内经 roster() 重读（lead 复核）。
    memberNames: config.members.map((member) => member.name),
    roster: async () => {
      // 团队消失/损坏 => 返回 null（核心侧如实失败，**不回退旧快照后照常派发**——
      // lead 复核：过期名册派发会把活派给已删成员造成孤儿）。带 members（含 sessionId）
      // 供投递段取新鲜会话 id——入队前 config 可能过期（lead 退回②）。
      const fresh = await readTeamConfigSnapshot(teamDirName);
      return fresh
        ? { names: fresh.members.map((member) => member.name), members: fresh.members.map((member) => ({ name: member.name, ...(member.sessionId ? { sessionId: member.sessionId } : {}) })) }
        : null;
    },
    now: () => Date.now(),
    uuid: () => randomUUID(),
    send: (to: string, bodyText: string, summary: string) =>
      dispatchViaBus(teamDirName, rawTeamName, to, bodyText, summary),
    wake: async (sessionId: string, text: string) => {
      try {
        const host = resolveTeamHost();
        await host.wake({ sessionId, text });
        return true;
      } catch {
        return false;
      }
    },
    memberSessionId: (memberName: string) => {
      const member = config.members.find((item) => item.name === memberName);
      return member?.sessionId;
    },
  };

  try {
    const result = await dispatchAssignment(deps, input);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AssignmentNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof AssignmentConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(
      { error: `分配失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
