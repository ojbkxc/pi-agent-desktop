import { NextResponse } from "next/server";
import { listTeams, teamDirFor } from "@/lib/agent-teams-swimlane-store";
import { computeTeamUsage, type TeamUsage } from "@/lib/agent-teams-team-usage";

export const dynamic = "force-dynamic";

/** 与 lifecycle 路由同款的 registry 只读判定（纯读 Map，零副作用）。 */
function hasLifecycleInstance(rawTeamName: string): boolean {
  const registry = (globalThis as Record<string, unknown>).__piTeamLifecycles;
  return registry instanceof Map && registry.has(rawTeamName);
}

async function probeRunning(sessionId: string): Promise<boolean> {
  // 惰性 import：lib/rpc-manager 会拖进 pi SDK。会话不存在 → false（视为已停）。
  const { getRpcSession } = await import("@/lib/rpc-manager");
  return getRpcSession(sessionId)?.isRunning() ?? false;
}

// GET /api/teams - 本机团队名册 + 每团队只读占用（v4 §5 / v8 安全降级 B）。
// 字段按已定契约**平铺**在团队对象上：bytes/files/truncated/lastActivityAt/
// ended/idleDays/usageError。逐团队独立容错：单团队 usage 失败只损自己
// （bytes:null + usageError），绝不拖垮整个名册。纯读：前后目录与 registry 不变。
export async function GET() {
  const teams = await listTeams();

  // 小并发（≤4）限总时延，不串行卡全表；单团队失败如实带出。
  const usages: TeamUsage[] = new Array(teams.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, teams.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= teams.length) return;
      const team = teams[index]!;
      try {
        usages[index] = await computeTeamUsage(team.name, teamDirFor, {
          probeRunning,
          hasLifecycleInstance,
        });
      } catch (error) {
        usages[index] = {
          bytes: null,
          files: 0,
          truncated: false,
          lastActivityAt: null,
          ended: null,
          idleDays: null,
          usageError: error instanceof Error ? error.message : String(error),
        };
      }
    }
  });
  await Promise.all(workers);

  const teamsWithUsage = teams.map((team, index) => ({
    ...team,
    // 平铺（不藏 usage 子对象——lead 已定契约）。
    ...usages[index]!,
  }));

  return NextResponse.json({ teams: teamsWithUsage }, { headers: { "Cache-Control": "no-store" } });
}
