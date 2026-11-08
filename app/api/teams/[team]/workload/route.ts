import { NextResponse } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveTeamWorkload,
  type TeamWorkloadQuota,
  type WorkloadTicket,
} from "@/lib/agent-teams-workload";
import {
  readGlobalRosterWorkers,
  readTeamConfigSnapshot,
  readTeamQuotaLimits,
  resolveLeadNames,
  teamDirFor,
} from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/teams/[team]/workload —— 团队忙闲/积压/一键调度建议（#54，只读）。
 *
 * 返回 `{ members:[{ name, state, runningCount, pendingCount }], orphans:[...],
 * suggestions:[...], quota:{ perTeamLimit, globalLimit, rosterWorkers, globalWorkers } }`
 * ——字段即 #55 前端稳定契约。纯派生不写文件；建议只展示，执行走
 * POST /api/teams/[team]/assignments 与 members。
 */

interface TicketAssignmentFileLike {
  id?: unknown;
  assignee?: unknown;
  status?: unknown;
  updatedAt?: unknown;
}

async function readTickets(teamDir: string): Promise<WorkloadTicket[]> {
  let names: string[] = [];
  try {
    names = await readdir(join(teamDir, "tickets"));
  } catch {
    return [];
  }
  const tickets: WorkloadTicket[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(teamDir, "tickets", name), "utf8")) as Record<string, unknown>;
      if (typeof parsed.id !== "string") continue;
      const assignments = Array.isArray(parsed.assignments)
        ? (parsed.assignments as TicketAssignmentFileLike[]).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          if (typeof item.id !== "string" || typeof item.assignee !== "string" || typeof item.status !== "string") return [];
          return [{
            id: item.id,
            assignee: item.assignee,
            status: item.status,
            updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
          }];
        })
        : [];
      tickets.push({
        id: parsed.id,
        subject: typeof parsed.subject === "string" ? parsed.subject : parsed.id,
        status: typeof parsed.status === "string" ? parsed.status : "open",
        assignments,
      });
    } catch {
      // 撕裂/损坏票：跳过（与泳道读取同口径）。
    }
  }
  return tickets;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;
  const teamDirName = decodeURIComponent(team);


  const teamDir = teamDirFor(teamDirName);
  // lead 排除走可靠判定链（readTeamConfigSnapshot+resolveLeadNames：leadSessionId 优先、
  // 无证据才回退首位；改名 lead 不再漏，已知 lead 身份时不误伤首位普通 worker）。
  const snapshot = await readTeamConfigSnapshot(teamDirName);
  if (!snapshot) {
    return NextResponse.json({ error: "团队不存在" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const leadNames = resolveLeadNames(snapshot);
  const memberNames = snapshot.members.map((member) => member.name).filter((name) => !leadNames.has(name));

  // 配额快照：只读路径**不进 withQuotaLock**（它会落占位文件——GET 必须零写盘）。
  // 无锁重读的短暂竞态对建议端点无害（建议本就只展示）；写者侧已由 quota.lock 串行。
  const limits = readTeamQuotaLimits();
  const { total: globalWorkers } = await readGlobalRosterWorkers();
  const quota: TeamWorkloadQuota = {
    perTeamLimit: limits.perTeamLimit,
    globalLimit: limits.globalLimit,
    rosterWorkers: memberNames.length,
    globalWorkers,
  };

  const tickets = await readTickets(teamDir);
  // 两段式（lead 复核）：先派生负载，再**只把 state==='idle' 的成员**作接收候选——
  // pending/running 成员再被推荐等于同一成员重复派活。
  const workload = deriveTeamWorkload({ memberNames, idleNames: memberNames, tickets, quota });
  const idleNames = workload.members.filter((member) => member.state === "idle").map((member) => member.name);
  const suggestions = deriveTeamWorkload({ memberNames, idleNames, tickets, quota }).suggestions;

  return NextResponse.json(
    { team: teamDirName, displayName: snapshot.rawName, ...workload, suggestions },
    { headers: { "Cache-Control": "no-store" } },
  );
}
