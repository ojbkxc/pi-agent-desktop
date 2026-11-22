/**
 * 挂起记录落盘（server-only）。
 *
 * 位置：`<agent dir>/pi-web/outages/<sessionId>.json`
 * （默认 `~/.pi/agent/pi-web/outages/`，与 pi-web settings / attention 同根；
 * 遵守 PI_CODING_AGENT_DIR，测试可注入 agentDir）。
 *
 * 约定：
 * - 原子写（`writePrivateFileAtomicSync`，tmp + rename）：崩溃/满盘只会留下旧文件
 *   或新文件，绝不会是截断的一半。
 * - 坏 JSON / 守卫不过 ⇒ 当作不存在（`getOutageRecord` 返回 undefined），**不删除**，
 *   留给人看。
 * - **一个会话同时只有一条挂起记录**：同 sessionId 再挂起时整体替换（supersede）。
 * - `guard.lastUserMessageId` 是防抢跑的关键：续跑前核对会话最后一条 user 消息
 *   仍是挂起时那条；用户中途发了新消息 ⇒ 记录作废（`superseded`）。
 * - 同步 IO：进程内的读-改-写在中间没有 await，不会自我交错；跨进程并发靠
 *   调度器的 pid 归属判据（见 `classifyOutageRecord`）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import {
  getPiWebSettingsPath,
  readStored,
  updatePiWebSettings,
} from "../artifact-settings";
import {
  capOutageText,
  isOutageRecord,
  normalizeOutageSettings,
  OUTAGE_RECORD_VERSION,
  OUTAGE_REASON_MAX_CHARS,
  OUTAGE_SETTINGS_DEFAULTS,
  type OutageKind,
  type OutageRecord,
  type OutageScope,
  type OutageSettings,
  type OutageSnapshot,
  type OutageSuspendKind,
  type OutageStatus,
} from "./types";

/** 会话 id 作为文件名前的清洗：只允许安全字符，防路径穿越。 */
function safeFileStem(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Invalid outage session id");
  return cleaned;
}

export function outagesDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pi-web", "outages");
}

/** 设置文件路径：显式 agentDir（测试/注入）与运行时一致地指向同一个 settings.json。 */
export function outageSettingsPath(agentDir?: string): string {
  return agentDir ? join(agentDir, "pi-web", "settings.json") : getPiWebSettingsPath();
}

export function outageRecordPath(sessionId: string, agentDir: string = getAgentDir()): string {
  return join(outagesDir(agentDir), `${safeFileStem(sessionId)}.json`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * 磁盘 JSON → OutageRecord 的完整守卫。比 `isOutageRecord` 更严：所有可选字段的
 * 类型也逐项校验，坏一份文件只损失那一条记录。
 */
export function isStoredOutageRecord(value: unknown): value is OutageRecord {
  if (!isOutageRecord(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  if (typeof record.reason !== "string") return false;
  if (!["chat", "goal", "autofix", "scheduled", "team", "campaign"].includes(record.scope as string)) return false;
  if (!isRecord(record.origin)) return false;
  if (!isRecord(record.resume) || record.resume.mode !== "followup" || typeof record.resume.note !== "string") return false;
  if (!isRecord(record.guard)) return false;
  if (record.pid !== null && !isFiniteNumber(record.pid)) return false;
  if (!isFiniteNumber(record.createdAt)) return false;
  return true;
}

/** 读一个会话的挂起记录；缺文件 / 坏 JSON / 守卫不过一律 undefined。 */
export function getOutageRecord(sessionId: string, agentDir: string = getAgentDir()): OutageRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(outageRecordPath(sessionId, agentDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredOutageRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 会话是否处于挂起等待（任何读路径的快捷判据；坏文件视为未挂起）。 */
export function isSessionSuspended(sessionId: string, agentDir: string = getAgentDir()): boolean {
  return getOutageRecord(sessionId, agentDir)?.status === "waiting";
}

/** 全部记录（含已结束的，除非 `waitingOnly`），最新更新的在前。坏文件跳过不删。 */
export function listOutageRecords(
  options: { agentDir?: string; waitingOnly?: boolean } = {},
): OutageRecord[] {
  const dir = outagesDir(options.agentDir ?? getAgentDir());
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const records: OutageRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!isStoredOutageRecord(parsed)) continue;
    if (options.waitingOnly && parsed.status !== "waiting") continue;
    records.push(parsed);
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeRecord(record: OutageRecord, agentDir: string): void {
  mkdirSync(outagesDir(agentDir), { recursive: true });
  writePrivateFileAtomicSync(outageRecordPath(record.sessionId, agentDir), `${JSON.stringify(record, null, 2)}\n`);
}

export interface CreateOutageRecordInput {
  sessionId: string;
  kind: OutageSuspendKind;
  /** 原始故障分类（落盘只记 suspend 类，但调用方可能带 transient 用于日志）。 */
  sourceKind?: OutageKind;
  reason: string;
  scope: OutageScope;
  origin?: OutageRecord["origin"];
  resume: OutageRecord["resume"];
  budget: OutageRecord["budget"];
  guard?: OutageRecord["guard"];
  sessionFile?: string | null;
  cwd?: string | null;
  /** 覆盖 pid（测试用）；默认本进程。 */
  pid?: number | null;
  now: number;
}

/**
 * 建/替换挂起记录（同 sessionId 只有一条：整体替换 = supersede 旧记录）。
 * 返回写入后的记录。
 */
export function createOutageRecord(input: CreateOutageRecordInput, agentDir: string = getAgentDir()): OutageRecord {
  const record: OutageRecord = {
    version: OUTAGE_RECORD_VERSION,
    sessionId: input.sessionId,
    kind: input.kind,
    reason: capOutageText(input.reason, OUTAGE_REASON_MAX_CHARS),
    scope: input.scope,
    origin: {
      provider: input.origin?.provider ?? null,
      modelId: input.origin?.modelId ?? null,
    },
    resume: {
      mode: input.resume.mode,
      note: input.resume.note,
      ...(typeof input.resume.promptText === "string" ? { promptText: input.resume.promptText } : {}),
      ...(typeof input.resume.promptPersisted === "boolean" ? { promptPersisted: input.resume.promptPersisted } : {}),
    },
    budget: { ...input.budget },
    guard: { ...input.guard },
    status: "waiting",
    pid: input.pid === undefined ? process.pid : input.pid,
    createdAt: input.now,
    updatedAt: input.now,
    postResumeFailures: 0,
    ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    finishedAt: null,
  };
  writeRecord(record, agentDir);
  return record;
}

/** 读-改-写一条记录；记录不存在/不可读时返回 undefined（不新建）。 */
export function updateOutageRecord(
  sessionId: string,
  patch: (record: OutageRecord) => OutageRecord,
  agentDir: string = getAgentDir(),
): OutageRecord | undefined {
  const current = getOutageRecord(sessionId, agentDir);
  if (!current) return undefined;
  const next = patch(current);
  writeRecord(next, agentDir);
  return next;
}

/** 把记录标成终态并落盘（resumed / expired / cancelled / superseded / failed）。 */
export function finishOutageRecord(
  sessionId: string,
  status: Extract<OutageRecord["status"], "resumed" | "expired" | "cancelled" | "superseded" | "failed">,
  now: number,
  extra: { lastError?: string | null } = {},
  agentDir: string = getAgentDir(),
): OutageRecord | undefined {
  return updateOutageRecord(sessionId, (record) => ({
    ...record,
    status,
    updatedAt: now,
    finishedAt: now,
    ...(extra.lastError !== undefined ? { lastError: extra.lastError } : {}),
  }), agentDir);
}

/** 用户取消等待：删记录（设计 §3「取消」）。返回是否真的存在过。 */
export function cancelOutageRecord(sessionId: string, agentDir: string = getAgentDir()): boolean {
  const path = outageRecordPath(sessionId, agentDir);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 防抢跑守卫：会话最后的 user 消息仍是挂起时那条才算「还是原来的任务」。
 *
 * `currentLastUserMessageId` 由调用方从会话（内存 wrapper 或磁盘）读出。
 * 返回 `true` 表示记录已作废（superseded），调用方应停止续跑。
 *
 * 判据：
 * - 记录里没有 `lastUserMessageId`（挂起时还读不到）⇒ 不判定（返回 false），
 *   依赖 attempts/deadline 兜底；
 * - 读音返回 undefined（会话读不到）⇒ 不判定（保守：宁可持续失败上限）。
 */
export function isOutageSuperseded(record: OutageRecord, currentLastUserMessageId: string | null | undefined): boolean {
  const guard = record.guard.lastUserMessageId;
  if (!guard) return false;
  if (!currentLastUserMessageId) return false;
  return guard !== currentLastUserMessageId;
}

/** 轻量投影（列表 / 设置页 / 任务页用；不暴露 prompt 文本与内部错误）。 */
export function toOutageSnapshot(record: OutageRecord): OutageSnapshot {
  return {
    sessionId: record.sessionId,
    kind: record.kind,
    scope: record.scope,
    status: record.status,
    reason: record.reason,
    attempts: record.budget.attempts,
    maxAttempts: record.budget.maxAttempts,
    nextAttemptAt: record.budget.nextAttemptAt,
    deadlineAt: record.budget.deadlineAt,
    updatedAt: record.updatedAt,
  };
}

/** 全部等待中记录的投影（任务页 / 设置页计数用）。 */
export function listOutageSnapshots(options: { agentDir?: string; waitingOnly?: boolean } = {}): OutageSnapshot[] {
  return listOutageRecords(options).map(toOutageSnapshot);
}

// ───────────────────────────── 设置读写 ─────────────────────────────

const OUTAGE_SETTINGS_KEY = "outage";

/**
 * 读取设置。默认**开**、6 小时 / 24 小时；文件坏了或字段非法一律退回默认
 * （与 `isArtifactsPromptEnabled` 的口径一致：错在「开着」代价小，错在「关了」
 * 看起来像功能坏了）。
 */
export function readOutageSettings(settingsPath: string = getPiWebSettingsPath()): OutageSettings {  try {
    return normalizeOutageSettings(readStored(settingsPath)[OUTAGE_SETTINGS_KEY]);
  } catch {
    return { ...OUTAGE_SETTINGS_DEFAULTS };
  }
}

/** 写设置（局部合并，保留 settings.json 里的其它键）。返回落盘后的生效值。 */
export function writeOutageSettings(
  patch: Partial<OutageSettings>,
  settingsPath: string = getPiWebSettingsPath(),
): OutageSettings {
  const current = readOutageSettings(settingsPath);
  const next = normalizeOutageSettings({ ...current, ...patch });
  updatePiWebSettings({ [OUTAGE_SETTINGS_KEY]: next }, settingsPath);
  return next;
}

/** 设置里的总开关是否允许挂起这一类故障。 */
export function isOutageSuspendedEnabled(kind: OutageSuspendKind, settings: OutageSettings): boolean {
  if (!settings.enabled) return false;
  if (kind === "quota" && settings.quotaMaxWaitHours === 0) return false;
  return true;
}

export type { OutageStatus };