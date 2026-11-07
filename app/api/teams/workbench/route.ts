import { NextResponse } from "next/server";
import { listTeams, readTeamWorkbench } from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

// GET /api/teams/workbench - 最新创建团队的泳道快照（聚合入口）。
// public/lane-diagram.html 在 URL 不带 ?session= 时回退到这里（页面本身不知道团队名）；
// 带 ?session=<id> 时走 /api/teams/session/[id]/workbench。挑团队的规则与
// components/AgentTeams/AgentTeamsView.tsx 一致：createdAt 最新的一个。
export async function GET() {
  const teams = await listTeams();
  const newest = [...teams].sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))[0];
  if (!newest) {
    return NextResponse.json(
      { error: "暂无团队" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const snapshot = await readTeamWorkbench(newest.name);
  if (!snapshot) {
    return NextResponse.json(
      { error: "团队不存在" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
