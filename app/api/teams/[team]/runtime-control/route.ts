import { NextResponse } from "next/server";
import { getLifecycle, resolveTeamHost } from "pi-team";
import { enqueueTeamMutation, teamDirFor } from "@/lib/agent-teams-swimlane-store";
import { readLifecycleSnapshot } from "@/lib/agent-teams-team-actions";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  newResumeRequestId,
  pauseTeamRuntime,
  readRuntimeControlView,
  readTeamStateForRuntime,
  resumeTeamRuntime,
  RuntimeControlError,
  type RuntimeControlDeps,
} from "@/lib/agent-teams-runtime-control";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/teams/[team]/runtime-control —— 团队运行时控件（暂停 / 恢复）。
 *
 * [team] 是**目录名**（sanitize 后）。
 * - GET：读运行时控件视图（sidecar 缺失 = running；成员状态从 lifecycle 现读）。
 * - POST body { action: "pause" | "resume", leadSessionId, incarnationId, requestId? }：
 *   - pause：逐成员 release(tombstone:false)（**不含 lead**），回执全 parked ⇒ paused，
 *     任一失败 ⇒ partial；客户端同时停 lead 生成（abort）。
 *   - resume：逐成员 ensureLive 复活 parked/aborted ⇒ running / partial。
 *   - 共享 per-team mutation 队列（与 stop/reclaim、成员增删同 key 串行）。
 */

const deps: RuntimeControlDeps = {
  readTeamState: (teamDirName) => readTeamStateForRuntime(teamDirName, teamDirFor),
  readLifecycle: (teamDirName) => readLifecycleSnapshot(teamDirName, teamDirFor),
  resolveLead: (teamDirName) => import("@/lib/agent-teams-swimlane-store").then((m) => m.resolveTeamLeadSession(teamDirName)),
  async release(rawTeamName, memberName) {
    // 实例由 pause 前的状态保证存在（团队跑过才有 lifecycle 条目）；getLifecycle 幂等。
    const lifecycle = getLifecycle(rawTeamName, resolveTeamHost());
    return await lifecycle.release(memberName, { tombstone: false });
  },
  async ensureLive(rawTeamName, memberName) {
    const lifecycle = getLifecycle(rawTeamName, resolveTeamHost());
    return await lifecycle.ensureLive(memberName);
  },
};

function parseIdentity(body: Record<string, unknown>): { leadSessionId: string; incarnationId: string } | null {
  const leadSessionId = typeof body.leadSessionId === "string" ? body.leadSessionId.trim() : "";
  const incarnationId = typeof body.incarnationId === "string" ? body.incarnationId.trim() : "";
  if (!leadSessionId || !incarnationId) return null;
  return { leadSessionId, incarnationId };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;
  const view = await readRuntimeControlView(decodeURIComponent(team), teamDirFor, deps);
  if (!view) {
    return NextResponse.json({ error: "团队不存在" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}

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

  const action = body.action;
  if (action !== "pause" && action !== "resume") {
    return NextResponse.json({ error: "action 必须是 pause 或 resume" }, { status: 400 });
  }
  const identity = parseIdentity(body);
  if (!identity) {
    return NextResponse.json({ error: "leadSessionId 与 incarnationId 必填" }, { status: 400 });
  }

  const teamDirName = decodeURIComponent(team);
  try {
    // 共享 per-team mutation 队列：pause 的 release 与 stop/reclaim、成员增删同 key 串行。
    const view = await enqueueTeamMutation(`team:${teamDirFor(teamDirName)}`, () =>
      action === "pause"
        ? pauseTeamRuntime(teamDirName, teamDirFor, deps, identity)
        : resumeTeamRuntime(teamDirName, teamDirFor, deps, identity, newResumeRequestId()),
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
