/**
 * 无人值守兜底——磁盘读取 + 配置/账本持久化（服务端专用）。
 *
 * 读：从 `~/.pi/agent/teams/<team>/`（PI_TEAM_DIR 覆盖）读 pi-team 落盘的 plan.json 与
 * tickets/*.json，投影成决策核心要的 AwaitingPlan / FailedAssignment。
 *
 * ⚠️ **不 import pi-team 包**。它的 package.json exports 只暴露 `.` / `./compat` / `./policy`，
 * `listTeamPlansAwaitingReview()` 在 root 上根本没有导出（只有 setInjectedHost /
 * resolveTeamHost / getLifecycle / getBus），internal 模块又不可达。桌面侧一贯做法就是
 * 按同名规则直接读盘（见 lib/agent-teams-swimlane-store.ts），这里沿用。
 *
 * 配置与账本（approvalNudges / failureNudges）合存在
 * `~/.pi/agent/pi-web/teams-fallback.json`，紧挨 Pi Web 的其它设置，省略 SDK 依赖。
 *
 * 客户端组件不要 import 本文件（含 node:fs）。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { resolveTeamLeadSession, UNKNOWN_LEAD_SESSION } from "./agent-teams-swimlane-store";
import { remoteAccessSettingsPath } from "./remote-access";
import { userHome } from "./user-home";
import {
  DEFAULT_UNATTENDED_CONFIG,
  type AwaitingPlan,
  type AwaitingPlanMember,
  type FailedAssignment,
  type FailureNudgeRecord,
  type UnattendedConfig,
  type UnattendedState,
} from "./agent-teams-unattended";

// ─────────────────────────────────────────────────────────────────────────────
// 路径（与 pi-team constants.getTeamsDir / teamHelpers.sanitizeName 对齐）
// ─────────────────────────────────────────────────────────────────────────────

export function teamsRootDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_TEAM_DIR?.trim();
  if (configured) return configured;
  return join(userHome(), ".pi", "agent", "teams");
}

/** 与 pi-team teamHelpers.sanitizeName 一致：非字母数字转 '-' 并小写。 */
export function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

/** 兜底的配置文件：与 pi-web/settings.json 同目录。 */
export function unattendedSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(remoteAccessSettingsPath(env)), "teams-fallback.json");
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置 + 账本持久化
// ─────────────────────────────────────────────────────────────────────────────

export interface UnattendedFile {
  config: UnattendedConfig;
  state: UnattendedState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseConfig(raw: unknown): UnattendedConfig {
  if (!isRecord(raw)) return { ...DEFAULT_UNATTENDED_CONFIG };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_UNATTENDED_CONFIG.enabled,
    approvalTimeoutMs: positiveInt(raw.approvalTimeoutMs, DEFAULT_UNATTENDED_CONFIG.approvalTimeoutMs),
    maxFailureRetries: Number.isInteger(raw.maxFailureRetries) && (raw.maxFailureRetries as number) >= 0
      ? (raw.maxFailureRetries as number)
      : DEFAULT_UNATTENDED_CONFIG.maxFailureRetries,
  };
}

function parseFailureRecord(raw: unknown): FailureNudgeRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.attempts !== "number" || typeof raw.lastAssignmentId !== "string") return null;
  return {
    attempts: Math.max(0, Math.floor(raw.attempts)),
    lastAssignmentId: raw.lastAssignmentId,
    exhaustedNotified: raw.exhaustedNotified === true,
  };
}

function parseState(raw: unknown): UnattendedState {
  const state: UnattendedState = { approvalNudges: {}, failureNudges: {} };
  if (!isRecord(raw)) return state;
  if (isRecord(raw.approvalNudges)) {
    for (const [planId, revision] of Object.entries(raw.approvalNudges)) {
      if (typeof revision === "number" && Number.isFinite(revision)) state.approvalNudges[planId] = revision;
    }
  }
  if (isRecord(raw.failureNudges)) {
    for (const [ticketId, record] of Object.entries(raw.failureNudges)) {
      const parsed = parseFailureRecord(record);
      if (parsed) state.failureNudges[ticketId] = parsed;
    }
  }
  if (isRecord(raw.manualNeeds)) {
    const manual: Record<string, { at: number; reason: string }> = {};
    for (const [key, value] of Object.entries(raw.manualNeeds)) {
      if (isRecord(value) && typeof value.at === "number" && typeof value.reason === "string") {
        manual[key] = { at: value.at, reason: value.reason };
      }
    }
    if (Object.keys(manual).length > 0) state.manualNeeds = manual;
  }
  return state;
}

/** 读配置 + 账本；文件缺失/损坏一律回落到默认值，绝不抛。 */
export function readUnattendedFile(path = unattendedSettingsPath()): UnattendedFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { config: { ...DEFAULT_UNATTENDED_CONFIG }, state: { approvalNudges: {}, failureNudges: {} } };
  }
  if (!isRecord(raw)) return { config: { ...DEFAULT_UNATTENDED_CONFIG }, state: { approvalNudges: {}, failureNudges: {} } };
  return { config: parseConfig(raw.config), state: parseState(raw.state) };
}

/** 原子写回（父目录自动创建，权限 0600）。 */
export function writeUnattendedFile(file: UnattendedFile, path = unattendedSettingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** 只替换 state、保留磁盘上的 config（用户手改的阈值不被覆盖）。 */
export function writeUnattendedState(state: UnattendedState, path = unattendedSettingsPath()): void {
  const current = readUnattendedFile(path);
  writeUnattendedFile({ config: current.config, state }, path);
}

/**
 * 只替换 config、保留磁盘上的 state（approvalNudges / failureNudges / manualNeeds 原样保留）。
 * 与 writeUnattendedState 相对：设置面改阈值绝不能顺手清账本。
 */
export function writeUnattendedConfig(config: UnattendedConfig, path = unattendedSettingsPath()): void {
  const current = readUnattendedFile(path);
  writeUnattendedFile({ config, state: current.state }, path);
}

/**
 * 只从 manualNeeds 删除指定 key，其余（config、approvalNudges、failureNudges）一个不动。
 * 返回落盘后的 state，供调用方回显。
 */
export function clearManualNeeds(keys: readonly string[], path = unattendedSettingsPath()): UnattendedState {
  const current = readUnattendedFile(path);
  const manual = { ...(current.state.manualNeeds ?? {}) };
  for (const key of keys) delete manual[key];
  const state: UnattendedState = { ...current.state };
  if (Object.keys(manual).length > 0) state.manualNeeds = manual;
  else delete state.manualNeeds;
  writeUnattendedFile({ config: current.config, state }, path);
  return state;
}

/** 兜底是否被环境变量整体关闭（instrumentation-node.ts 用它决定是否起循环）。 */
export function isUnattendedDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_WEB_DISABLE_TEAMS_FALLBACK === "1";
}

// ─────────────────────────────────────────────────────────────────────────────
// 读盘投影
// ─────────────────────────────────────────────────────────────────────────────

/** plan.json 里我们关心的字段（结构类型，不 import pi-team）。 */
interface PlanFileLike {
  planId?: unknown;
  sessionId?: unknown;
  /** 团队原始名（非 sanitize 目录名）：pi-team teamPlanStore.js:113 落盘时写入。 */
  teamName?: unknown;
  revision?: unknown;
  state?: unknown;
  updatedAt?: unknown;
  members?: unknown;
}

interface TicketAssignmentFileLike {
  id?: unknown;
  assignee?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  result?: unknown;
  outcome?: unknown;
}

interface TicketFileLike {
  id?: unknown;
  subject?: unknown;
  status?: unknown;
  assignments?: unknown;
}

/** config.json 的名册（D4-5：失败提醒的模型以 config 为权威）。 */
interface ConfigFileLike {
  members?: unknown;
}

export interface UnattendedInput {
  awaitingPlans: AwaitingPlan[];
  failedAssignments: FailedAssignment[];
  /** 解析失败或缺少 plan.json 而被跳过的团队目录（诊断用）。 */
  skippedTeams: string[];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const asString = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function readPlanMembers(raw: unknown): AwaitingPlanMember[] {
  if (!Array.isArray(raw)) return [];
  const members: AwaitingPlanMember[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    const name = asString(item.name);
    const runtime = isRecord(item.runtime) ? item.runtime : null;
    members.push({
      id: id ?? name ?? "?",
      name: name ?? id ?? "?",
      providerId: (runtime && asString(runtime.providerId)) ?? "",
      modelId: (runtime && asString(runtime.modelId)) ?? "",
    });
  }
  return members;
}

/**
 * 成员名 → 当前模型（用于失败提醒里写明「用哪个模型失败」）。
 *
 * 口径与投影层 buildRoster 对齐（D4-5，v2 裁定）：config.json 的 members[].model
 * 是权威（PATCH /api/teams/[team]/members 只写那里，plan.approvedSnapshot/plan.members
 * 的 runtime 不随后续改模刷新——B5 是另一条，不在此修），plan.runtime 仅兜底。
 */
function memberModel(
  config: ConfigFileLike | null,
  plan: PlanFileLike | null,
  member: string,
): { providerId: string | null; modelId: string | null } {
  const fromConfig = configMemberModel(config, member);
  if (fromConfig) return fromConfig;
  if (!plan || !Array.isArray(plan.members)) return { providerId: null, modelId: null };
  for (const item of plan.members) {
    if (!isRecord(item)) continue;
    if (asString(item.name) !== member) continue;
    const runtime = isRecord(item.runtime) ? item.runtime : null;
    return {
      providerId: runtime ? asString(runtime.providerId) : null,
      modelId: runtime ? asString(runtime.modelId) : null,
    };
  }
  return { providerId: null, modelId: null };
}

/** config.json 名册条目里该成员的 model/providerId；没有非空值则回 null。 */
function configMemberModel(config: ConfigFileLike | null, member: string): { providerId: string | null; modelId: string | null } | null {
  if (!config || !Array.isArray(config.members)) return null;
  for (const item of config.members) {
    if (!isRecord(item)) continue;
    if (asString(item.name) !== member) continue;
    const providerId = asString(item.providerId);
    const modelId = asString(item.model);
    if (providerId === null && modelId === null) continue;
    return { providerId, modelId };
  }
  return null;
}

/**
 * 读出一个团队的 plan.json 与 tickets/*.json，投影成等待审批的计划与失败派活。
 * 目录缺失 / 单文件损坏一律静默跳过。
 */
export async function collectUnattendedInput(env: NodeJS.ProcessEnv = process.env): Promise<UnattendedInput> {
  const root = teamsRootDir(env);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return { awaitingPlans: [], failedAssignments: [], skippedTeams: [] };
  }

  const awaitingPlans: AwaitingPlan[] = [];
  const failedAssignments: FailedAssignment[] = [];
  const skippedTeams: string[] = [];

  for (const dirName of [...names].sort()) {
    const teamDir = join(root, dirName);
    const planRaw = readJson(join(teamDir, "plan.json"));
    const plan = isRecord(planRaw) ? (planRaw as PlanFileLike) : null;
    const recorded = plan ? asString(plan.sessionId) : null;
    if (!plan || !recorded) {
      skippedTeams.push(dirName);
      continue;
    }
    // plan.json 的 sessionId 与 config.json 的 leadSessionId 同源（都读 PI_SESSION_ID，
    // 本服务进程从不设置）→ 恒为占位 'unknown-session'，投递必然找不到会话。改用磁盘上
    // 可反推的真实 lead 会话（成员会话的 parentSessionId，见 swimlane-store 的说明）。
    const sessionId = recorded === UNKNOWN_LEAD_SESSION
      ? (await resolveTeamLeadSession(dirName, env).catch(() => null)) ?? recorded
      : recorded;
    // config.json 读取失败不阻断 plan/tickets 侧（memberModel 会回退 plan.runtime）。
    const configRaw = readJson(join(teamDir, "config.json"));
    const config = isRecord(configRaw) ? (configRaw as ConfigFileLike) : null;

    if (plan.state === "review_pending") {
      const updatedAt = asNumber(plan.updatedAt) ?? 0;
      awaitingPlans.push({
        // 展示名：plan.json 记录的原始团队名（D4-4，v2 裁定），中文团队名不再显示成
        // 「------」；plan 缺该字段才回退 sanitize 目录名。
        teamName: asString(plan.teamName) ?? dirName,
        planId: asString(plan.planId) ?? "",
        revision: asNumber(plan.revision) ?? 0,
        sessionId,
        updatedAt,
        members: readPlanMembers(plan.members),
      });
    }

    const ticketDir = join(teamDir, "tickets");
    let ticketNames: string[];
    try {
      ticketNames = await readdir(ticketDir);
    } catch {
      continue;
    }
    for (const ticketName of ticketNames.sort()) {
      if (!ticketName.endsWith(".json")) continue;
      const ticketRaw = readJson(join(ticketDir, ticketName));
      if (!isRecord(ticketRaw)) continue;
      const ticket = ticketRaw as TicketFileLike;
      if (ticket.status === "ended") continue; // 已结束的票不再追
      const ticketId = asString(ticket.id);
      if (!ticketId || !Array.isArray(ticket.assignments)) continue;
      const subject = asString(ticket.subject) ?? ticketId;
      for (const item of ticket.assignments) {
        if (!isRecord(item)) continue;
        const assignment = item as TicketAssignmentFileLike;
        if (assignment.outcome !== "failed") continue;
        const assignmentId = asString(assignment.id);
        const member = asString(assignment.assignee);
        if (!assignmentId || !member) continue;
        const { providerId, modelId } = memberModel(config, plan, member);
        failedAssignments.push({
          // 同 D4-4：优先 plan 记录的原始团队名，目录名兜底。
          teamName: asString(plan.teamName) ?? dirName,
          sessionId,
          ticketId,
          ticketSubject: subject,
          assignmentId,
          member,
          providerId,
          modelId,
          error: asString(assignment.result),
          updatedAt: asNumber(assignment.updatedAt) ?? 0,
        });
      }
    }
  }

  return { awaitingPlans, failedAssignments, skippedTeams };
}
