import { NextResponse } from "next/server";
import { findTeamByLeadSession, readTeamWorkbench } from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

// GET /api/teams/session/[id]/workbench - 以 lead 会话 id 反查团队并返回泳道快照。
// 路径落在 /api/teams/* 下；public/lane-diagram.html
// 用 `?session=<leadSessionId>` 直接命中它。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const teamName = await findTeamByLeadSession(decodeURIComponent(id));
  if (!teamName) {
    return NextResponse.json(
      { error: "没有以该会话为 lead 的团队" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const snapshot = await readTeamWorkbench(teamName);
  if (!snapshot) {
    return NextResponse.json(
      { error: "团队不存在" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
