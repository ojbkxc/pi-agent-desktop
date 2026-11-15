/**
 * 团队运行时控件（暂停 / 恢复 / 成员运行时）——服务端核心。
 * 对齐 cc-haha `agentTeams.runtime.*`（desktop AgentTeamsRuntimeControls +
 * src/server/services/teamRuntimeControlService.ts）的可观测语义：
 *
 * 状态机（三态，cc-haha 同款）：
 * - `running`  团队在跑。**sidecar 缺失 = 从未暂停**（全新团队 / 重启后 sidecar 丢失
 *   都按 running 起算——pi 不依赖 sidecar 存在性判定「在跑」）；
 * - `paused`   全员已停（逐成员 release(tombstone:false) 回执确认），**只有 paused 能改
 *   成员运行时**（cc-haha「Pause again before editing」同款门禁）；
 * - `partial`  暂停/恢复过程中部分成员未确认（memberErrors），可再暂停一次收敛。
 *
 * 与 cc-haha 的 pi 适配（口径差异，勿当 bug 修）：
 * - 成员停/复活用 pi-team lifecycle 的 `release(tombstone:false)` / `ensureLive`，
 *   不是 CLI worker 进程（pi 的成员是子 agent 会话）；
 * - **lead 会话不进 release**：lead 是用户自己的会话，「停 lead 生成」由客户端做
 *   （stopGeneration/abort，见 useAgentSession.handleAbort），服务端只停成员；
 * - sidecar 落在团队目录 `runtime-control.json`（与 config/plan 同族），身份
 *   {leadSessionId, incarnationId} 由客户端携带（workbench 快照），首次写盘建档，
 *   之后每次写盘 CAS 校验（身份不符 409，同 pi-team incarnation 语义）；
 * - 不提供 pausing/resuming 瞬态：客户端用 pauseRequested / operation 表达。
 *
 * 本模块不 import pi-team：release / ensureLive / 读盘全部由调用方注入（route 接真实
 * registry 与磁盘），因此可以纯单测。
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { mergeRosterMembers, readPlanRosterMembers, type RosterMember } from "./agent-teams-roster";
import { mutateTeamConfigFile } from "./agent-teams-swimlane-store";

/** 运行时控件三态（cc-haha teamRuntimeControlStatusSchema 的桌面子集）。 */
export type RuntimeControlStatus = "running" | "paused" | "partial";

/** 视图里的成员状态（cc-haha TeamRuntimeControlView.members.status）。 */
export type RuntimeControlMemberStatus = "paused" | "running" | "waiting" | "completed" | "failed";

/** 成员生命周期状态 → 视图状态。idle = 等活，parked = 已停，aborted = 失败。 */
export interface RuntimeControlMemberView {
  agentId: string;
  sessionId: string;
  name: string;
  status: RuntimeControlMemberStatus;
  error?: string;
  /** 当前运行时（编辑弹框的初值）：config.members 优先，plan 独有成员取 plan.runtime。 */
  providerId: string;
  modelId: string;
  effortLevel: string | null;
}

export interface RuntimeControlView {
  schemaVersion: 1;
  teamName: string;
  leadSessionId: string;
  incarnationId: string;
  revision: number;
  epoch: number;
  status: RuntimeControlStatus;
  updatedAt: number;
  pausedAt?: number;
  error?: string;
  memberErrors?: Record<string, string>;
  members: RuntimeControlMemberView[];
  /** 可被 resume 复活的成员数（status=paused 的账面成员）。 */
  resumeEligibleCount: number;
}

/** sidecar 落盘记录（cc-haha TeamRuntimeControlRecord 的桌面子集）。 */
export interface RuntimeControlRecord {
  schemaVersion: 1;
  teamName: string;
  leadSessionId: string;
  incarnationId: string;
  revision: number;
  epoch: number;
  status: RuntimeControlStatus;
  ownerId: string;
  updatedAt: number;
  pausedAt?: number;
  error?: string;
  memberErrors?: Record<string, string>;
  resume?: {
    requestId: string;
    epoch: number;
    createdAt: number;
    eligibleSessionIds: string[];
    startedSessionIds: string[];
  };
}

/** 带 HTTP 语义的错误（route 直接转 status + message）。 */
export class RuntimeControlError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "RuntimeControlError";
  }
}

export interface RuntimeControlIdentity {
  leadSessionId: string;
  incarnationId: string;
}

export interface RuntimeControlDeps {
  /**
   * 按**目录名**读团队状态：原始名 + 合并名册（config ∪ plan，与泳道 buildRoster 一致）
   * + incarnationId（plan 优先，无 plan 用目录名）。团队不存在返回 null。
   */
  readTeamState: (teamDirName: string) => Promise<{
    rawName: string;
    incarnationId: string;
    members: RosterMember[];
  } | null>;
  /** 按目录名读 lifecycle.json 成员条目（缺文件返回空表）。status 宽读（磁盘容错）。 */
  readLifecycle: (teamDirName: string) => Promise<Record<string, { status?: unknown; sessionId?: unknown; lastError?: unknown }>>;
  /** 真实 lead 会话 id（config → desktop-lead 标记 → 成员会话反推）；无证据返回 null。 */
  resolveLead: (teamDirName: string) => Promise<string | null>;
  /** 逐成员 release(tombstone:false)：返回操作后的回执（status/generation/sessionId）。 */
  release: (rawTeamName: string, memberName: string) => Promise<{ status: string; generation?: number; sessionId?: string }>;
  /** 逐成员 ensureLive（pi-team 唯一 revive 编排）：返回复活后的会话。 */
  ensureLive: (rawTeamName: string, memberName: string) => Promise<{ sessionId?: string }>;
}

/** lifecycle 条目的宽读形态（memberViewStatus 只认四态字符串，其余按 waiting）。 */
function memberViewStatus(
  entry: { status?: unknown; lastError?: unknown } | undefined,
  hasSession: boolean,
): RuntimeControlMemberStatus {
  if (!entry || typeof entry.status !== "string") return "waiting";
  switch (entry.status) {
    case "running":
      return "running";
    case "parked":
      return "paused";
    case "aborted":
      return "failed";
    default:
      return "waiting"; // idle / 未知值：TTL 窗口内或磁盘旧账，视为等活
  }
}

/** sidecar 锁与原子写的重试口径（与 plan-write 同族）。 */
const RUNTIME_CONTROL_LOCK_RETRIES = { retries: 10, minTimeout: 5, maxTimeout: 100 } as const;
const RENAME_RETRY_MAX_ATTEMPTS = 23;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 读 sidecar（缺失/损坏 ⇒ null；损坏如实上抛由调用方决定——读路径一律容错）。 */
async function readRecord(teamDir: string): Promise<RuntimeControlRecord | null> {
  const raw = await readJson<RuntimeControlRecord>(join(teamDir, "runtime-control.json"));
  if (!raw || typeof raw !== "object") return null;
  const status = raw.status;
  if (status !== "running" && status !== "paused" && status !== "partial") return null;
  return raw;
}

/** 视图：record（缺省 running）+ 合并名册 + lifecycle 条目。leadSessionId 缺省用真实解析值。 */
export function buildView(
  record: RuntimeControlRecord | null,
  state: { rawName: string; incarnationId: string; members: RosterMember[] },
  lifecycle: Record<string, { status?: unknown; sessionId?: unknown; lastError?: unknown }>,
  resolvedLead: string | null,
  now: number = Date.now(),
): RuntimeControlView {
  const members: RuntimeControlMemberView[] = [];
  for (const member of state.members) {
    const entry = lifecycle[member.name];
    const sessionId = (typeof entry?.sessionId === "string" ? entry.sessionId : "") || (member.sessionId ?? "");
    const status = memberViewStatus(entry, Boolean(sessionId));
    const lastError = typeof entry?.lastError === "string" && entry.lastError ? entry.lastError : null;
    members.push({
      agentId: member.agentId,
      sessionId,
      name: member.name,
      status,
      providerId: member.runtime?.providerId ?? "",
      modelId: member.runtime?.modelId ?? "",
      effortLevel: member.runtime?.effortLevel ?? null,
      ...(lastError ? { error: lastError } : {}),
    });
  }
  return {
    schemaVersion: 1,
    teamName: state.rawName,
    leadSessionId: record?.leadSessionId ?? resolvedLead ?? "",
    incarnationId: record?.incarnationId ?? state.incarnationId,
    revision: record?.revision ?? 1,
    epoch: record?.epoch ?? 0,
    status: record?.status ?? "running",
    updatedAt: record?.updatedAt ?? now,
    ...(record?.pausedAt !== undefined ? { pausedAt: record.pausedAt } : {}),
    ...(record?.error ? { error: record.error } : {}),
    ...(record?.memberErrors ? { memberErrors: record.memberErrors } : {}),
    members,
    resumeEligibleCount: members.filter((member) => member.status === "paused").length,
  };
}

/**
 * 只读视图（GET 用）。团队不存在 ⇒ null。
 */
export async function readRuntimeControlView(
  teamDirName: string,
  dirFor: (name: string) => string,
  deps: RuntimeControlDeps,
): Promise<RuntimeControlView | null> {
  const teamDir = dirFor(teamDirName);
  const state = await deps.readTeamState(teamDirName);
  if (!state) return null;
  const [record, lifecycle, resolvedLead] = await Promise.all([
    readRecord(teamDir),
    deps.readLifecycle(teamDirName),
    deps.resolveLead(teamDirName),
  ]);
  return buildView(record, state, lifecycle, resolvedLead);
}

/** 读团队状态的磁盘默认实现（config + plan 合并名册 + incarnationId）。 */
export async function readTeamStateForRuntime(
  teamDirName: string,
  dirFor: (name: string) => string,
): Promise<{ rawName: string; incarnationId: string; members: RosterMember[] } | null> {
  const teamDir = dirFor(teamDirName);
  const config = await readJson<{ name?: unknown; leadSessionId?: unknown; members?: unknown }>(join(teamDir, "config.json"));
  if (!config || !Array.isArray(config.members)) return null;
  const rosterMembers: RosterMember[] = [];
  for (const item of config.members) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const agentId = typeof record.agentId === "string" ? record.agentId : "";
    const name = typeof record.name === "string" ? record.name : "";
    if (!agentId || !name) continue;
    const sessionId = typeof record.sessionId === "string" && record.sessionId ? record.sessionId : undefined;
    rosterMembers.push(sessionId ? { agentId, name, sessionId } : { agentId, name });
  }
  const plan = await readPlanRosterMembers(teamDir);
  const planFull = await readJson<{ incarnationId?: unknown }>(join(teamDir, "plan.json"));
  return {
    rawName: typeof config.name === "string" ? config.name : "",
    incarnationId: typeof planFull?.incarnationId === "string" && planFull.incarnationId ? planFull.incarnationId : teamDirName,
    members: mergeRosterMembers(rosterMembers, plan),
  };
}

/** sidecar 原子写：临时文件 + rename（Windows 瞬时错误有界退避），失败清临时。 */
async function writeRecordWithRetry(teamDir: string, record: RuntimeControlRecord): Promise<void> {
  const target = join(teamDir, "runtime-control.json");
  const temp = join(teamDir, `runtime-control.json.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (attempt >= RENAME_RETRY_MAX_ATTEMPTS || !transient) throw error;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(25 * 2 ** attempt, 500));
        });
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** 身份校验：record 存在且身份不符 ⇒ 409（pi-team incarnation 同款）。 */
function assertIdentity(record: RuntimeControlRecord | null, identity: RuntimeControlIdentity): void {
  if (!record) return;
  if (record.leadSessionId !== identity.leadSessionId || record.incarnationId !== identity.incarnationId) {
    throw new RuntimeControlError("团队身份已变化（lead 会话或代际不符），请刷新后重试", 409);
  }
}

/** 下一个 revision：无 sidecar 时视图虚拟 revision=1（running 起点），首写落 2。 */
function nextRevision(record: RuntimeControlRecord | null): number {
  return (record?.revision ?? 1) + 1;
}

/**
 * 暂停团队（cc-haha pauseReviewedTeam 同款语义，pi 适配）：
 * 逐成员 release(tombstone:false)（**不含 lead**——lead 是用户会话，停生成由客户端做），
 * 回执全部 parked ⇒ paused；任一失败 ⇒ partial + memberErrors（可再暂停一次收敛）。
 */
export async function pauseTeamRuntime(
  teamDirName: string,
  dirFor: (name: string) => string,
  deps: RuntimeControlDeps,
  identity: RuntimeControlIdentity,
): Promise<RuntimeControlView> {
  const teamDir = dirFor(teamDirName);
  const state = await deps.readTeamState(teamDirName);
  if (!state) throw new RuntimeControlError("团队不存在", 404);
  if (!state.rawName) throw new RuntimeControlError("团队配置缺少 name，无法定位生命周期实例", 400);

  const release = await lockfile.lock(join(teamDir, "runtime-control.json"), {
    lockfilePath: `${join(teamDir, "runtime-control.json")}.lock`,
    realpath: false,
    retries: { ...RUNTIME_CONTROL_LOCK_RETRIES },
  });
  try {
    const record = await readRecord(teamDir);
    assertIdentity(record, identity);
    if (record?.status === "paused") throw new RuntimeControlError("团队已暂停，无需再暂停", 409);

    const lifecycle = await deps.readLifecycle(teamDirName);
    // lead 成员（合并名册首位 = config members[0]，pi-team team_create 恒置 lead）不 release。
    const leadName = state.members[0]?.name ?? "";
    const memberErrors: Record<string, string> = {};
    for (const member of state.members) {
      if (!member.name || member.name === leadName) continue;
      const entry = lifecycle[member.name];
      const sessionId = (typeof entry?.sessionId === "string" ? entry.sessionId : "") || (member.sessionId ?? "");
      if (!sessionId) continue; // 从未派发：没有可停的会话
      try {
        const receipt = await deps.release(state.rawName, member.name);
        if (receipt.status !== "parked") {
          memberErrors[sessionId] = `成员「${member.name}」停止回执异常（status=${receipt.status}）`;
        }
      } catch (error) {
        memberErrors[sessionId] = error instanceof Error ? error.message : String(error);
      }
    }

    const now = Date.now();
    const next: RuntimeControlRecord = {
      schemaVersion: 1,
      teamName: state.rawName,
      leadSessionId: identity.leadSessionId,
      incarnationId: identity.incarnationId,
      revision: nextRevision(record),
      epoch: (record?.epoch ?? 0) + 1,
      status: Object.keys(memberErrors).length > 0 ? "partial" : "paused",
      ownerId: `session:${identity.leadSessionId}`,
      updatedAt: now,
      pausedAt: now,
      ...(Object.keys(memberErrors).length > 0
        ? {
            error: "部分成员未确认停止，请再暂停一次以收敛",
            memberErrors,
          }
        : { error: undefined, memberErrors: undefined }),
      ...(record?.resume ? { resume: record.resume } : {}),
    };
    await writeRecordWithRetry(teamDir, next);
    return buildView(next, state, lifecycle, null, now);
  } finally {
    await release().catch(() => undefined);
  }
}

/**
 * 恢复团队（cc-haha resumeReviewedTeam 同款语义，pi 适配）：
 * 逐成员 ensureLive 复活 parked/aborted 成员，全部成功 ⇒ running；任一失败 ⇒ partial。
 * 返回视图（含 resume 记录：requestId / eligible / started 会话 id）。
 */
export async function resumeTeamRuntime(
  teamDirName: string,
  dirFor: (name: string) => string,
  deps: RuntimeControlDeps,
  identity: RuntimeControlIdentity,
  requestId: string,
): Promise<RuntimeControlView> {
  const teamDir = dirFor(teamDirName);
  const state = await deps.readTeamState(teamDirName);
  if (!state) throw new RuntimeControlError("团队不存在", 404);
  if (!state.rawName) throw new RuntimeControlError("团队配置缺少 name，无法定位生命周期实例", 400);

  const release = await lockfile.lock(join(teamDir, "runtime-control.json"), {
    lockfilePath: `${join(teamDir, "runtime-control.json")}.lock`,
    realpath: false,
    retries: { ...RUNTIME_CONTROL_LOCK_RETRIES },
  });
  try {
    const record = await readRecord(teamDir);
    assertIdentity(record, identity);
    if (!record || record.status === "running") {
      throw new RuntimeControlError("团队未在暂停状态，无需恢复", 409);
    }

    const lifecycle = await deps.readLifecycle(teamDirName);
    const leadName = state.members[0]?.name ?? "";
    const memberErrors: Record<string, string> = {};
    const eligibleSessionIds: string[] = [];
    const startedSessionIds: string[] = [];
    for (const member of state.members) {
      if (!member.name || member.name === leadName) continue;
      const entry = lifecycle[member.name];
      const sessionId = (typeof entry?.sessionId === "string" ? entry.sessionId : "") || (member.sessionId ?? "");
      if (sessionId) eligibleSessionIds.push(sessionId);
      if (!entry || (entry.status !== "parked" && entry.status !== "aborted")) continue; // 在跑/等活：无需复活
      try {
        const live = await deps.ensureLive(state.rawName, member.name);
        if (live.sessionId) startedSessionIds.push(live.sessionId);
        else memberErrors[sessionId] = `成员「${member.name}」复活未返回会话`;
      } catch (error) {
        memberErrors[sessionId] = error instanceof Error ? error.message : String(error);
      }
    }

    const now = Date.now();
    const next: RuntimeControlRecord = {
      schemaVersion: 1,
      teamName: state.rawName,
      leadSessionId: identity.leadSessionId,
      incarnationId: identity.incarnationId,
      revision: nextRevision(record),
      epoch: (record?.epoch ?? 0) + 1,
      status: Object.keys(memberErrors).length > 0 ? "partial" : "running",
      ownerId: `session:${identity.leadSessionId}`,
      updatedAt: now,
      ...(record?.pausedAt !== undefined ? { pausedAt: record.pausedAt } : {}),
      ...(Object.keys(memberErrors).length > 0
        ? {
            error: "部分成员未确认复活，请再恢复一次以收敛",
            memberErrors,
          }
        : {}),
      resume: {
        requestId,
        epoch: (record?.epoch ?? 0) + 1,
        createdAt: now,
        eligibleSessionIds,
        startedSessionIds,
      },
    };
    await writeRecordWithRetry(teamDir, next);
    return buildView(next, state, lifecycle, null, now);
  } finally {
    await release().catch(() => undefined);
  }
}

export interface UpdateMemberRuntimeOptions {
  agentId: string;
  sessionId?: string;
  providerId: string;
  modelId: string;
  effortLevel?: string;
  /** 乐观并发：客户端视图的 revision。提供时必须与 sidecar 当前一致（不符 409）。 */
  expectedRevision?: number;
}

/**
 * 更新成员运行时（cc-haha updateMemberRuntime 同款门禁，pi 适配）：
 * **只有 paused 能改**（cc-haha「Pause again before editing」）；身份 CAS；
 * 写 config.json（model/providerId/effortLevel，plan 独有成员补写进名册，复用
 * applyTeamMemberModelChanges 的名册口径）；revision++。
 */
export async function updateMemberRuntime(
  teamDirName: string,
  dirFor: (name: string) => string,
  deps: RuntimeControlDeps,
  identity: RuntimeControlIdentity,
  options: UpdateMemberRuntimeOptions,
): Promise<RuntimeControlView> {
  const teamDir = dirFor(teamDirName);
  const state = await deps.readTeamState(teamDirName);
  if (!state) throw new RuntimeControlError("团队不存在", 404);
  if (!state.rawName) throw new RuntimeControlError("团队配置缺少 name，无法定位生命周期实例", 400);

  const target = state.members.find((member) => member.agentId === options.agentId);
  if (!target) throw new RuntimeControlError(`成员 ${options.agentId} 不在团队名册中`, 400);
  const lifecycle = await deps.readLifecycle(teamDirName);
  const entry = lifecycle[target.name];
  const memberSessionId = (typeof entry?.sessionId === "string" ? entry.sessionId : "") || (target.sessionId ?? "");
  if (options.sessionId && options.sessionId !== memberSessionId) {
    throw new RuntimeControlError(`成员「${target.name}」的会话已变化（期望 ${options.sessionId}，实际 ${memberSessionId || "无"}）`, 409);
  }

  const release = await lockfile.lock(join(teamDir, "runtime-control.json"), {
    lockfilePath: `${join(teamDir, "runtime-control.json")}.lock`,
    realpath: false,
    retries: { ...RUNTIME_CONTROL_LOCK_RETRIES },
  });
  try {
    const record = await readRecord(teamDir);
    assertIdentity(record, identity);
    if (!record || record.status !== "paused") {
      // paused 才可改（partial 也不行：cc-haha 同款——先再暂停一次收敛到 paused）。
      throw new RuntimeControlError("只有暂停状态可以修改成员运行时（先暂停团队）", 409);
    }

    // 写 config（锁内重读最新）：成员在 config 里直接改，plan 独有成员补写进名册
    // （与 applyTeamMemberModelChanges 的「阶段二」同口径，幂等由 agentId 命中保证）。
    await mutateTeamConfigFile(teamDir, {
      unreadableError: "config.json 在保存成员运行时不可读，未写盘",
      mutate: (config) => {
        const rawMembers = config.members;
        if (!Array.isArray(rawMembers)) throw new Error("config.json 在保存成员运行时不可读，未写盘");
        let member = rawMembers.find(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === "object" && (item as { agentId?: unknown }).agentId === options.agentId,
        );
        if (!member) {
          member = {
            agentId: options.agentId,
            name: target.name,
            joinedAt: typeof config.createdAt === "number" ? config.createdAt : 0,
            cwd: "",
          };
          rawMembers.push(member);
        }
        member.model = options.modelId;
        member.providerId = options.providerId;
        if (options.effortLevel) member.effortLevel = options.effortLevel;
        else delete member.effortLevel;
        return { value: undefined, next: config };
      },
    });

    const now = Date.now();
    const nextRecord: RuntimeControlRecord = {
      schemaVersion: 1,
      teamName: state.rawName,
      leadSessionId: identity.leadSessionId,
      incarnationId: identity.incarnationId,
      revision: nextRevision(record),
      epoch: record?.epoch ?? 0,
      status: record?.status ?? "running",
      ownerId: record?.ownerId ?? `session:${identity.leadSessionId}`,
      updatedAt: now,
      ...(record?.pausedAt !== undefined ? { pausedAt: record.pausedAt } : {}),
      ...(record?.resume ? { resume: record.resume } : {}),
    };
    await writeRecordWithRetry(teamDir, nextRecord);
    return buildView(nextRecord, state, lifecycle, null, now);
  } finally {
    await release().catch(() => undefined);
  }
}

/** 生成新 requestId（route 用）。 */
export function newResumeRequestId(): string {
  return randomUUID();
}
