import { NextResponse } from "next/server";
import { listTeams } from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

// GET /api/teams - 本机团队名册，供 Agents 面板选择。
export async function GET() {
  const teams = await listTeams();
  return NextResponse.json({ teams }, { headers: { "Cache-Control": "no-store" } });
}
