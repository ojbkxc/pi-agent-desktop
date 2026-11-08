import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getLifecycle, resolveTeamHost } from "pi-team";
import {
  applyTeamMemberModelChanges,
  mutateTeamConfigFile,
  readGlobalRosterWorkers,
  readTeamConfigSnapshot,
  readTeamQuotaLimits,
  resolveLeadNames,
  withQuotaLock,
  type MemberModelDelivery,
  type TeamMemberModelUpdate,
} from "@/lib/agent-teams-swimlane-store";
import {
  addTeamMember,
  removeTeamMember,
  runGlobalQuotaGate,
  type AddMemberInput,
  type MembersDeps,
  type RemoveMemberResult,
} from "@/lib/agent-teams-members";
import { MemberConflictError } from "@/lib/agent-teams-members";
import { dispatchViaBus } from "@/lib/agent-teams-assignments";

import { teamDirFor } from "@/lib/agent-teams-swimlane-store";

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
// 返回 { team, action, ok, results: [{ name, agentId?, status, sessionId?, warning?, reason? }], error? }。
// ok = 无 failed；逐条如实（spawned/respawned/failed | removed/failed），不吞错。
// 不用 DELETE：外网 DELETE+body 会被代理拦截（部署实锤），统一 POST+action。
//
// 全局配额预检在 .quota.lock 内重读全团队名册（跨桌面写者串行）；per-team 判定在
// config 文件锁临界区内复核；pi-team 侧 checkSpawnLimits 仍是跨进程迟到真闸。
// ─────────────────────────────────────────────────────────────────────────────

const MEMBER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  const limits = readTeamQuotaLimits();

  if (action === "add") {
    const rawMembers = body.members;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0 || rawMembers.length > 8) {
      return NextResponse.json({ error: "members 必须是 1..8 个对象的数组" }, { status: 400 });
    }
    const seen = new Set<string>();
    const inputs: AddMemberInput[] = [];
    for (const item of rawMembers) {
      const record = item as Record<string, unknown> | null;
      const name = typeof record?.name === "string" ? record.name : "";
      if (!MEMBER_NAME_PATTERN.test(name)) {
        return NextResponse.json(
          { error: `成员名不合法（限字母数字与 ._-，1..64 字符）：${JSON.stringify(name)}` },
          { status: 400 },
        );
      }
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push({
        name,
        ...(typeof record?.agentType === "string" && record.agentType ? { agentType: record.agentType } : {}),
        ...(typeof record?.prompt === "string" && record.prompt ? { prompt: record.prompt.slice(0, 2000) } : {}),
        ...(typeof record?.model === "string" && record.model ? { model: record.model } : {}),
      });
    }

    // 全局配额 + 真实 spawn 原子化（lead 复审）：.quota.lock 覆盖「重读全团队名册
    // 判 32 → 通过后的全部 addTeamMember」——锁内预检+锁内执行，两个并发团队的
    // add 不会同时通过预检后双双 spawn。锁跨进程互斥（proper-lockfile），pi-team
    // 侧 checkSpawnLimits 仍是迟到真闸（如实注释，不宣称完全防护）。
    const deps = buildMembersDeps(teamDirName, teamDir, config.rawName, limits.perTeamLimit, config.leadSessionId);
    // 全局配额闸 = lib runGlobalQuotaGate（route 与测试共用同一函数）：withQuotaLock
    // 锁内逐成员重读记账；spawned 占位/respawn 不占/failed 不占；MemberConflictError
    // ⇒ 整批 409。pi-team 侧 checkSpawnLimits 仍是跨进程迟到真闸。
    const { results, conflict } = await withQuotaLock(() =>
      runGlobalQuotaGate(
        {
          globalLimit: limits.globalLimit,
          readTotal: async () => (await readGlobalRosterWorkers()).total,
          addOne: (input) => addTeamMember(deps, input),
        },
        inputs,
      ),
    );
    if (conflict) {
      return NextResponse.json(
        { team: teamDirName, action, ok: false, results, error: conflict },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const ok = results.every((result) => result.status !== "failed");
    return NextResponse.json({ team: teamDirName, action, ok, results }, { headers: { "Cache-Control": "no-store" } });
  }

  // action === "remove"
  const rawNames = body.names;
  if (!Array.isArray(rawNames) || rawNames.length === 0 || rawNames.length > 12) {
    return NextResponse.json({ error: "names 必须是 1..12 个成员名的数组" }, { status: 400 });
  }
  const names: string[] = [];
  for (const item of rawNames) {
    if (typeof item !== "string" || !MEMBER_NAME_PATTERN.test(item)) {
      return NextResponse.json({ error: `成员名不合法：${JSON.stringify(item)}` }, { status: 400 });
    }
    if (!names.includes(item)) names.push(item);
  }

  const deps = buildMembersDeps(teamDirName, teamDir, config.rawName, limits.perTeamLimit, config.leadSessionId);
  const results: RemoveMemberResult[] = [];
  let conflictStatus = 0;
  for (const name of names) {
    try {
      results.push(await removeTeamMember(deps, name));
    } catch (error) {
      results.push({
        name,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof MemberConflictError) {
        conflictStatus = 409;
        break;
      }
      // MemberNotFoundError：计入 results 继续（partial success）。
    }
  }
  const ok = results.every((result) => result.status !== "failed");
  return NextResponse.json(
    { team: teamDirName, action, ok, results, ...(conflictStatus ? { error: results.find((result) => result.reason)?.reason } : {}) },
    { status: conflictStatus || 200, headers: { "Cache-Control": "no-store" } },
  );
}
