import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getLifecycle, resolveTeamHost } from "pi-team";
import {
  applyTeamMemberModelChanges,
  mutateTeamConfigFile,
  readGlobalRosterWorkers,
  readTeamConfigSnapshot,
  readTeamQuotaResolution,
  readTeamSpawnConcurrency,
  resolveLeadNames,
  type MemberModelDelivery,
  type TeamMemberModelUpdate,
} from "@/lib/agent-teams-swimlane-store";
import {
  addTeamMember,
  parseAddMembersBatch,
  parseRemoveMemberNames,
  removeTeamMembersBatch,
  runGlobalQuotaGate,
  type MembersDeps,
} from "@/lib/agent-teams-members";
import { dispatchViaBus } from "@/lib/agent-teams-assignments";

import { teamDirFor } from "@/lib/agent-teams-swimlane-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/teams/[team]/members —— 改团队成员模型（单个或批量）。
 *
 * body: { memberId?: string; memberIds?: string[]; provider: string; modelId: string }
 * 返回逐条结果（applied / saved / failed+reason），不吞错、不谎报已生效。
 */

interface MemberModelBody {
  memberId?: unknown;
  memberIds?: unknown;
  provider?: unknown;
  modelId?: unknown;
}

/** 单个 memberId 或 memberIds 数组 → 去重后的非空字符串数组；不合法返回 null。 */
function normalizeMemberIds(body: MemberModelBody): string[] | null {
  const raw = body.memberIds !== undefined
    ? body.memberIds
    : body.memberId !== undefined
      ? [body.memberId]
      : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((id): id is string => typeof id === "string" && id.length > 0)) return null;
  return [...new Set(raw)];
}

/**
 * 把 { type: "set_model" } 投递到进程内会话注册表。
 *
 * 结构与 pi-team-host 的 wake() 一致：读 `globalThis.__piSessions`（rpc-manager 的
 * getRpcSession 就是 `registry.get(id)`），**不 import rpc-manager**——它会把 pi SDK 拖进来，
 * 且测不了。会话不在（未派发/已死/parked）返回 unavailable，交给调用方标成「已保存待复活」。
 * 命令失败（如模型不存在）原样抛出，由 store 透传给该成员的结果。
 */
async function deliverSetModel(
  sessionId: string,
  update: { provider: string; modelId: string },
): Promise<MemberModelDelivery> {
  const session = globalThis.__piSessions?.get(sessionId);
  if (!session || !session.isAlive()) return { kind: "unavailable" };
  await session.send({ type: "set_model", provider: update.provider, modelId: update.modelId });
  return { kind: "applied" };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { team } = await params;

  let body: MemberModelBody;
  try {
    body = await req.json() as MemberModelBody;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const memberIds = normalizeMemberIds(body);
  if (!memberIds) {
    return NextResponse.json(
      { error: "memberId 或 memberIds 必须是非空字符串（数组）" },
      { status: 400 },
    );
  }
  if (typeof body.provider !== "string" || !body.provider || typeof body.modelId !== "string" || !body.modelId) {
    return NextResponse.json({ error: "provider 与 modelId 必填" }, { status: 400 });
  }
  const provider = body.provider;
  const modelId = body.modelId;

  const updates: TeamMemberModelUpdate[] = memberIds.map((memberId) => ({ memberId, provider, modelId }));
  const outcome = await applyTeamMemberModelChanges({
    teamName: decodeURIComponent(team),
    updates,
    deliver: deliverSetModel,
  });

  if (!outcome.teamExists) {
    return NextResponse.json({ error: "团队不存在" }, { status: 404 });
  }

  const summary = {
    applied: outcome.results.filter((result) => result.status === "applied").length,
    saved: outcome.results.filter((result) => result.status === "saved").length,
    failed: outcome.results.filter((result) => result.status === "failed").length,
  };
  return NextResponse.json(
    { results: outcome.results, summary },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/teams/[team]/members —— 加/删团队成员（#54）。
//
// body: { action: "add", members: [{ name, agentType?, prompt?, model? }] }
//     | { action: "remove", names: string[] }
// 返回 { team, action, ok, results: [{ name, agentId?, status, sessionId?, warning?, reason? }],
//        quota: { perTeamLimit, globalLimit }, error? }。
// ok = 无 failed；逐条如实（spawned/respawned/failed | removed/failed），不吞错。
// 不用 DELETE：外网 DELETE+body 会被代理拦截（部署实锤），统一 POST+action。
//
// 并发口径（本轮重做）：
// - 名额判定原子（.quota.lock 内「读盘名册 + 在途预留」），但**锁不包 spawn**：起进程
//   在锁外按 PI_TEAM_MAX_SPAWN_CONCURRENCY（默认 4）并行，批内一个成员失败不拖垮其余；
// - per-team 判定仍在 config 文件锁临界区内复核；pi-team 侧 checkSpawnLimits 是跨进程
//   迟到的真闸（如实口径，不宣称跨进程完全防护）；
// - 批上限见 members.ts 的 MAX_BATCH_ADD_MEMBERS（64）：配额才是真闸，HTTP 层不再用
//   8 这种与配额脱节的数字把「多派成员」拦在门外。
// ─────────────────────────────────────────────────────────────────────────────

interface PostMembersBody {
  action?: unknown;
  members?: unknown;
  names?: unknown;
}

/** POST 的 deps 装配（真实宿主；members.ts 保持纯模块可测）。 */
function buildMembersDeps(teamDirName: string, teamDir: string, rawTeamName: string, quotaPerTeamLimit: number, leadSessionIdOfRequest: string | null): MembersDeps {
  return {
    teamDir,
    rawTeamName,
    quotaPerTeamLimit,
    now: () => Date.now(),
    uuid: () => randomUUID(),
    mutateConfig: (mutation) => mutateTeamConfigFile(teamDir, mutation),
    snapshotEntry: (entry) => JSON.stringify(entry),
    leadNamesOf: (members) => {
      // 可靠 lead 链（lead 退回②）：与 #55 同口径，改名 lead 不虚占 per-team 配额。
      const snapshot = {
        rawName: rawTeamName,
        leadSessionId: leadSessionIdOfRequest,
        members: members.map((member) => ({
          agentId: typeof member.agentId === "string" ? member.agentId : "",
          name: typeof member.name === "string" ? member.name : "",
          ...(typeof member.sessionId === "string" && member.sessionId ? { sessionId: member.sessionId } : {}),
        })),
      };
      return resolveLeadNames(snapshot);
    },
    lifecycle: () => {
      const lifecycle = getLifecycle(rawTeamName, resolveTeamHost());
      return {
        get: (name) => lifecycle.get(name),
        adopt: (name, info) => lifecycle.adopt(name, info),
        release: (name, options) => lifecycle.release(name, options),
        ensureLive: (name) => lifecycle.ensureLive(name),
      };
    },
    hasLifecycleInstance: () => {
      const registry = (globalThis as Record<string, unknown>).__piTeamLifecycles;
      return registry instanceof Map && registry.has(rawTeamName);
    },
    start: async (request) => {
      const handle = await resolveTeamHost().start(request);
      return { sessionId: handle.sessionId, sessionFile: handle.sessionFile };
    },
    stopSession: async (sessionId) => {
      await resolveTeamHost().stop(sessionId);
    },
    probeRunning: async (sessionId) => {
      const { getRpcSession } = await import("@/lib/rpc-manager");
      return getRpcSession(sessionId)?.isRunning() ?? false;
    },
    deliverText: (to, body, summary) => dispatchViaBus(teamDirName, rawTeamName, to, body, summary).then(() => undefined),
  };
}

async function readTeamConfigForPost(teamDirName: string): Promise<{ rawName: string; leadSessionId: string | null; names: string[] } | null> {
  const config = await readTeamConfigSnapshot(teamDirName);
  if (!config) return null;
  return { rawName: config.rawName, leadSessionId: config.leadSessionId, names: config.members.map((member) => member.name) };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { team } = await params;
  const teamDirName = decodeURIComponent(team);

  let body: PostMembersBody;
  try {
    body = await req.json() as PostMembersBody;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const action = body?.action;
  if (action !== "add" && action !== "remove") {
    return NextResponse.json({ error: "action 必须是 add 或 remove" }, { status: 400 });
  }

  const config = await readTeamConfigForPost(teamDirName);
  if (!config) {
    return NextResponse.json({ error: "团队不存在" }, { status: 404 });
  }
  const teamDir = teamDirFor(teamDirName);
  const limits = readTeamQuotaResolution();

  if (action === "add") {
    const parsed = parseAddMembersBatch(body.members);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const inputs = parsed.value;

    // 全局配额闸 = lib runGlobalQuotaGate（route 与测试共用同一函数）。名额判定在
    // `.quota.lock` 内原子完成（读盘名册 + 在途预留，不会超卖），**spawn 在锁外**按
    // PI_TEAM_MAX_SPAWN_CONCURRENCY 并行；批内单个成员失败只记 failed，不中止其余。
    const deps = buildMembersDeps(teamDirName, teamDir, config.rawName, limits.perTeamLimit, config.leadSessionId);
    const { results, conflict } = await runGlobalQuotaGate(
      {
        globalLimit: limits.globalLimit,
        readTotal: async () => (await readGlobalRosterWorkers()).total,
        addOne: (input) => addTeamMember(deps, input),
        concurrency: readTeamSpawnConcurrency(),
        limitHint: limits.sources.globalLimit === "env"
          ? `环境变量 ${limits.envNames.globalLimit}`
          : limits.sources.globalLimit === "settings"
            ? "设置项 teamQuota.globalLimit"
            : "默认值 TEAM_QUOTA_DEFAULTS.globalLimit",
      },
      inputs,
    );
    const quota = { perTeamLimit: limits.perTeamLimit, globalLimit: limits.globalLimit };
    if (conflict) {
      // 409 只用于「全局名额耗尽」：整批里已成功的照实带出（results 非空 = 部分成功），
      // 用户据 status 只重派剩余成员即可，不必整批重发。
      return NextResponse.json(
        { team: teamDirName, action, ok: false, results, quota, error: conflict },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const ok = results.every((result) => result.status !== "failed");
    return NextResponse.json(
      { team: teamDirName, action, ok, results, quota },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // action === "remove"
  const parsedNames = parseRemoveMemberNames(body.names);
  if (!parsedNames.ok) {
    return NextResponse.json({ error: parsedNames.error }, { status: 400 });
  }
  const names = parsedNames.value;

  const deps = buildMembersDeps(teamDirName, teamDir, config.rawName, limits.perTeamLimit, config.leadSessionId);
  // 逐成员失败隔离 + 小并发（旧实现遇第一个冲突就 break，后面的成员根本没被尝试）。
  const { results, conflict: removeConflict } = await removeTeamMembersBatch(deps, names, {
    concurrency: readTeamSpawnConcurrency(),
  });
  const ok = results.every((result) => result.status !== "failed");
  return NextResponse.json(
    {
      team: teamDirName,
      action,
      ok,
      results,
      ...(removeConflict ? { error: removeConflict } : {}),
    },
    { status: removeConflict ? 409 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
