import { NextResponse } from "next/server";
import { findTeamBySession, readTeamWorkbench } from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

// GET /api/teams/session/[id]/workbench - 按会话 id 反查团队并返回泳道快照。
// lead 会话与成员会话都能命中；public/lane-diagram.html
// 用 `?session=<sessionId>` 直接命中它。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const teamName = await findTeamBySession(decodeURIComponent(id));
  if (!teamName) {
    return NextResponse.json(
      { error: "没有包含该会话的团队" },
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
