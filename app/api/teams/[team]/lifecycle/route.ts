import { NextResponse } from "next/server";
import { getLifecycle, resolveTeamHost } from "pi-team";
import { teamDirFor } from "@/lib/agent-teams-swimlane-store";
import {
  readTeamConfig,
  readLifecycleSnapshot,
  removeTeamDirectory,
  runTeamLifecycleAction,
  type LifecycleSnapshotEntry,
  type TeamActionDeps,
  type TeamLifecycleAction,
} from "@/lib/agent-teams-team-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/teams/[team]/lifecycle —— 停止 / 回收团队。
 *
 * body: { action: "stop" | "reclaim" }
 * - stop：逐成员 release(tombstone:false)，保留 sessionFile，之后可复活；
 * - reclaim：先逐成员停止并校验回执，全部成功才删团队目录（不可逆）。
 *
 * [team] 是**目录名**（sanitize 后）；生命周期 registry 的 key 是 config.json 的
 * **原始团队名**——两者不同，混用会「停止成功但什么都没停」。
 */

const LIFECYCLE_GLOBAL_KEY = "__piTeamLifecycles";

/**
 * 本进程是否已有该团队的生命周期实例。
 *
 * 不能拿 getLifecycle 当探测：它**会创建**一个空实例（随后 release 静默失效，表现为
 * 「停止成功但什么都没停」）。这里直接看 pi-team 的进程级 registry。
 */
function hasLifecycleInstance(rawTeamName: string): boolean {
  const registry = (globalThis as Record<string, unknown>)[LIFECYCLE_GLOBAL_KEY];
  return registry instanceof Map && registry.has(rawTeamName);
}

const deps: TeamActionDeps = {
  readTeamConfig: (teamDirName) => readTeamConfig(teamDirName, teamDirFor),
  readLifecycle: (teamDirName) => readLifecycleSnapshot(teamDirName, teamDirFor),
  hasLifecycleInstance,
  async release(rawTeamName, memberName): Promise<LifecycleSnapshotEntry> {
    // 实例已由上一步确认存在，getLifecycle 返回既有实例，不会新建。
    // host 传 resolveTeamHost()：实例存在时该参数被忽略。
    const lifecycle = getLifecycle(rawTeamName, resolveTeamHost());
    return await lifecycle.release(memberName, { tombstone: false });
  },
  removeTeamDir: (teamDirName) => removeTeamDirectory(teamDirName, teamDirFor),
};

function parseAction(value: unknown): TeamLifecycleAction | null {
  return value === "stop" || value === "reclaim" ? value : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;

  let body: { action?: unknown };
  try {
    body = await req.json() as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const action = parseAction(body?.action);
  if (!action) {
    return NextResponse.json({ error: "action 必须是 stop 或 reclaim" }, { status: 400 });
  }

  const teamDirName = decodeURIComponent(team);
  const result = await runTeamLifecycleAction(deps, { teamDirName, action });

  // 团队不存在 → 404；其余失败（实例不在、成员停止失败）→ 409，逐条 results 如实带出。
  const status = result.error === "团队不存在" ? 404 : result.ok ? 200 : 409;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
}