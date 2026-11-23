import { NextResponse } from "next/server";
import { enqueueTeamMutation, teamDirFor } from "@/lib/agent-teams-swimlane-store";
import { readLifecycleSnapshot } from "@/lib/agent-teams-team-actions";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  readTeamStateForRuntime,
  RuntimeControlError,
  updateMemberRuntime,
} from "@/lib/agent-teams-runtime-control";

export const dynamic = "force-dynamic";

/**
 * POST /api/teams/[team]/runtime-control/member —— 更新成员运行时（模型 / 推理级别）。
 *
 * body: { agentId, sessionId?, providerId, modelId, effortLevel?, leadSessionId, incarnationId }
 * **只有 paused 能改**（cc-haha「Pause again before editing」门禁）：暂停后成员都 parked，
 * 改的是磁盘 config，成员在 resume 复活时带上新模型。身份 CAS（leadSessionId +
 * incarnationId 必须与 sidecar 一致）。共享 per-team mutation 队列。
 */

const readDeps = {
  readTeamState: (teamDirName: string) => readTeamStateForRuntime(teamDirName, teamDirFor),
  readLifecycle: (teamDirName: string) => readLifecycleSnapshot(teamDirName, teamDirFor),
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { team } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const leadSessionId = typeof body.leadSessionId === "string" ? body.leadSessionId.trim() : "";
  const incarnationId = typeof body.incarnationId === "string" ? body.incarnationId.trim() : "";
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
  const effortLevel = typeof body.effortLevel === "string" && body.effortLevel.trim() ? body.effortLevel.trim() : undefined;
  if (!leadSessionId || !incarnationId || !agentId || !providerId || !modelId) {
    return NextResponse.json(
      { error: "leadSessionId / incarnationId / agentId / providerId / modelId 必填" },
      { status: 400 },
    );
  }

  const teamDirName = decodeURIComponent(team);
  try {
    // updateMemberRuntime 只用 readTeamState / readLifecycle / release / ensureLive 中的
    // 前两者（不改成员生命周期）；release/ensureLive 不会被触达，stub 即可（纯模块单测
    // 同款约束：不 import pi-team）。
    const view = await enqueueTeamMutation(`team:${teamDirFor(teamDirName)}`, () =>
      updateMemberRuntime(teamDirName, teamDirFor, {
        readTeamState: readDeps.readTeamState,
        readLifecycle: readDeps.readLifecycle,
        release: async () => {
          throw new Error("成员运行时更新不停止成员（内部约束被触达）");
        },
        ensureLive: async () => {
          throw new Error("成员运行时更新不复活成员（内部约束被触达）");
        },
        resolveLead: async () => null,
      }, { leadSessionId, incarnationId }, {
        agentId,
        ...(sessionId ? { sessionId } : {}),
        providerId,
        modelId,
        ...(effortLevel ? { effortLevel } : {}),
      }),
    );
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RuntimeControlError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
