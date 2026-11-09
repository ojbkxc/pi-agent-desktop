import { NextResponse } from "next/server";
import { findTeamBySession, readTeamWorkbench } from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

// GET /api/teams/session/[id]/workbench - 按会话 id 反查团队并返回泳道快照。
// lead 会话与成员会话都能命中；public/lane-diagram.html
// 用 `?session=<sessionId>` 直接命中它。
//
// 「该会话不属于任何团队」是**正常状态**，返回 200 `{ team: null }` 而不是 404：
// 桌面每次打开会话都会探测一次（团队条、计划卡、内联卡各自可能再查），而绝大多数
// 会话本来就没有团队。用 404 表达常态会让浏览器把每次探测记成一条 console error，
// 既污染用户控制台，也让 e2e 的「页面无错误」断言永远不可能通过。
// 团队目录存在但读不出快照才是真的异常，仍走 404。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const teamName = await findTeamBySession(decodeURIComponent(id));
  if (!teamName) {
    return NextResponse.json({ team: null }, { headers: { "Cache-Control": "no-store" } });
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
