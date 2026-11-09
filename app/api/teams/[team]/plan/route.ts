import { NextResponse } from "next/server";
import { readTeamPlanView } from "@/lib/agent-teams-plan-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/teams/[team]/plan —— 计划卡的数据源（**纯只读**）。
 *
 * 返回 `{ plan: TeamPlanView | null }`：团队没有 plan.json（或解析失败 / state 未知）时为
 * `null`，界面据此不渲染卡片。这里不触发任何副作用——审批走
 * `POST /api/teams/[team]/plan/approve`（投递 prompt 给 lead），本路由绝不写盘。
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
