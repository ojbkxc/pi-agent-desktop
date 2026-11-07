import { NextResponse } from "next/server";
import {
  applyTeamMemberModelChanges,
  type TeamMemberModelUpdate,
  type MemberModelDelivery,
} from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/teams/[team]/members —— 改团队成员模型（单个或批量）。
 *
 * body: { memberId?: string; memberIds?: string[]; provider: string; modelId: string }
 * 返回逐条结果（applied / saved / failed+reason），不吞错、不谎报已生效。
 */

interface MemberModelBody {
  memberId?: unknown;
  memberIds?: unknown;
  provider?: unknown;
  modelId?: unknown;
}

/** 单个 memberId 或 memberIds 数组 → 去重后的非空字符串数组；不合法返回 null。 */
function normalizeMemberIds(body: MemberModelBody): string[] | null {
  const raw = body.memberIds !== undefined
    ? body.memberIds
    : body.memberId !== undefined
      ? [body.memberId]
      : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((id): id is string => typeof id === "string" && id.length > 0)) return null;
  return [...new Set(raw)];
}

/**
 * 把 { type: "set_model" } 投递到进程内会话注册表。
 *
 * 结构与 pi-team-host 的 wake() 一致：读 `globalThis.__piSessions`（rpc-manager 的
 * getRpcSession 就是 `registry.get(id)`），**不 import rpc-manager**——它会把 pi SDK 拖进来，
 * 且测不了。会话不在（未派发/已死/parked）返回 unavailable，交给调用方标成「已保存待复活」。
 * 命令失败（如模型不存在）原样抛出，由 store 透传给该成员的结果。
 */
async function deliverSetModel(
  sessionId: string,
  update: { provider: string; modelId: string },
): Promise<MemberModelDelivery> {
  const session = globalThis.__piSessions?.get(sessionId);
  if (!session || !session.isAlive()) return { kind: "unavailable" };
  await session.send({ type: "set_model", provider: update.provider, modelId: update.modelId });
  return { kind: "applied" };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;

  let body: MemberModelBody;
  try {
    body = await req.json() as MemberModelBody;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const memberIds = normalizeMemberIds(body);
  if (!memberIds) {
    return NextResponse.json(
      { error: "memberId 或 memberIds 必须是非空字符串（数组）" },
      { status: 400 },
    );
  }
  if (typeof body.provider !== "string" || !body.provider || typeof body.modelId !== "string" || !body.modelId) {
    return NextResponse.json({ error: "provider 与 modelId 必填" }, { status: 400 });
  }
  const provider = body.provider;
  const modelId = body.modelId;

  const updates: TeamMemberModelUpdate[] = memberIds.map((memberId) => ({ memberId, provider, modelId }));
  const outcome = await applyTeamMemberModelChanges({
    teamName: decodeURIComponent(team),
    updates,
    deliver: deliverSetModel,
  });

  if (!outcome.teamExists) {
    return NextResponse.json({ error: "团队不存在" }, { status: 404 });
  }

  const summary = {
    applied: outcome.results.filter((result) => result.status === "applied").length,
    saved: outcome.results.filter((result) => result.status === "saved").length,
    failed: outcome.results.filter((result) => result.status === "failed").length,
  };
  return NextResponse.json(
    { results: outcome.results, summary },
    { headers: { "Cache-Control": "no-store" } },
  );
}
