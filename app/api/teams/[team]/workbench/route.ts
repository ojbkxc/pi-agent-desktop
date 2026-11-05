import { NextResponse } from "next/server";
import { readTeamWorkbench } from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

// GET /api/teams/[team]/workbench - 某团队的泳道快照（live）。
// 路径落在 /api/teams/* 下；public/lane-diagram.html 消费该快照。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;
  const snapshot = await readTeamWorkbench(decodeURIComponent(team));
  if (!snapshot) {
    return NextResponse.json(
      { error: "团队不存在" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
