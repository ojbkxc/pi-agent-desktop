/**
 * 后台 job 的**磁盘存储**与输出文件管理。
 *
 * 目录布局（都在 `<agent dir>/pi-web/`）：
 *   jobs/<id>.json   一条 job 记录（原子写，0600）
 *   jobs/<id>.log    stdout+stderr 全量输出
 *
 * 为什么落盘而不是 `globalThis`：`lib/subagent-runtime.ts` 的 `__piSubagentRuns` 只在
 * 进程内存里，重启即丢——那是既有的已知缺陷，这里不重复它。落盘后：
 * - 服务重启，遗留 `running` 能被结算成 `interrupted`（`settleOrphanedJob`）；
 * - 用户在 UI/工具里能查历史 job，而不是重启就查不到。
 *
 * 输出文件用**追加写**而非原子替换：它是长任务的流式日志，可能几十 MB，
 * 原子替换要整份重写。记录文件很小，仍走原子写。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import {
  BACKGROUND_JOB_MAX_KEPT,
  BACKGROUND_JOB_MAX_OUTPUT_BYTES,
  BACKGROUND_JOB_VERSION,
  settleOrphanedJob,
  selectJobsToPrune,
  type BackgroundJob,
  type BackgroundJobStatus,
} from "./types";

export function jobsDir(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "jobs");
}

export function jobRecordPath(id: string, agentDir = getAgentDir()): string {
  return join(jobsDir(agentDir), `${id}.json`);
}

export function jobOutputPath(id: string, agentDir = getAgentDir()): string {
  return join(jobsDir(agentDir), `${id}.log`);
}

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const STATUSES: ReadonlySet<string> = new Set<BackgroundJobStatus>([
  "running", "completed", "failed", "stopped", "timedout", "interrupted",
]);

/** job id 直接来自路径参数，必须校验形状再拼路径——否则 `../` 可穿越目录。 */
export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value);
}

export function newJobId(): string {
  return randomUUID();
}

/** 磁盘 JSON → BackgroundJob 守卫。结构损坏抛错，不静默当作空记录。 */
export function asBackgroundJob(value: unknown, source = "job"): BackgroundJob {
  if (!isRecord(value)) throw new Error(`Invalid background job ${source}: expected an object`);
  if (value.version !== BACKGROUND_JOB_VERSION) {
    throw new Error(`Invalid background job ${source}: unsupported version ${JSON.stringify(value.version)}`);
  }
  const required = ["id", "sessionId", "toolCallId", "command", "cwd", "label", "status", "startedAt", "outputPath"] as const;
  for (const key of required) {
    if (typeof value[key] !== "string") {
      throw new Error(`Invalid background job ${source}: ${key} must be a string`);
    }
  }
  if (!STATUSES.has(value.status as string)) {
    throw new Error(`Invalid background job ${source}: unknown status ${JSON.stringify(value.status)}`);
  }
  if (typeof value.timeoutSec !== "number" || typeof value.outputTruncated !== "boolean") {
    throw new Error(`Invalid background job ${source}: timeoutSec/outputTruncated malformed`);
  }
  const optionalString = (key: string): string | undefined => {
    const raw = value[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") throw new Error(`Invalid background job ${source}: ${key} must be a string`);
    return raw;
  };
  const exitCode = value.exitCode;
  if (exitCode !== undefined && exitCode !== null && typeof exitCode !== "number") {
    throw new Error(`Invalid background job ${source}: exitCode malformed`);
  }
  const signal = value.signal;
  if (signal !== undefined && signal !== null && typeof signal !== "string") {
    throw new Error(`Invalid background job ${source}: signal malformed`);
  }
  const pid = value.pid;
  if (pid !== undefined && typeof pid !== "number") {
    throw new Error(`Invalid background job ${source}: pid malformed`);
  }
  return {
    version: BACKGROUND_JOB_VERSION,
    id: value.id as string,
    sessionId: value.sessionId as string,
    toolCallId: value.toolCallId as string,
    command: value.command as string,
    cwd: value.cwd as string,
    label: value.label as string,
    status: value.status as BackgroundJobStatus,
    startedAt: value.startedAt as string,
    ...(optionalString("finishedAt") === undefined ? {} : { finishedAt: optionalString("finishedAt") }),
    ...(exitCode === undefined ? {} : { exitCode: exitCode as number | null }),
    ...(signal === undefined ? {} : { signal: signal as string | null }),
    outputPath: value.outputPath as string,
    outputTruncated: value.outputTruncated as boolean,
    ...(optionalString("tail") === undefined ? {} : { tail: optionalString("tail") }),
    timeoutSec: value.timeoutSec as number,
    ...(pid === undefined ? {} : { pid: pid as number }),
    ...(optionalString("error") === undefined ? {} : { error: optionalString("error") }),
  };
}

export function readJob(id: string, agentDir = getAgentDir()): BackgroundJob | null {
  if (!isJobId(id)) return null;
  const filePath = jobRecordPath(id, agentDir);
  if (!existsSync(filePath)) return null;
  return asBackgroundJob(JSON.parse(readFileSync(filePath, "utf8")), filePath);
}

export function writeJob(job: BackgroundJob, agentDir = getAgentDir()): void {
  const dir = jobsDir(agentDir);
  mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(jobRecordPath(job.id, agentDir), JSON.stringify(job, null, 2));
}

/** 列出全部 job（按 startedAt 倒序）。坏记录跳过并告警，不阻断列表。 */
export function listJobs(agentDir = getAgentDir()): BackgroundJob[] {
  const dir = jobsDir(agentDir);
  if (!existsSync(dir)) return [];
  const jobs: BackgroundJob[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isJobId(id)) continue;
    try {
      const job = readJob(id, agentDir);
      if (job) jobs.push(job);
    } catch (error) {
      console.warn(`[pi-web] 跳过损坏的后台 job 记录 ${name}:`, error instanceof Error ? error.message : error);
    }
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** 删除超出保留上限的终态 job（记录 + 输出文件）。 */
export function pruneJobs(agentDir = getAgentDir(), maxKept = BACKGROUND_JOB_MAX_KEPT): string[] {
  const jobs = listJobs(agentDir);
  const pruned = selectJobsToPrune(jobs, maxKept);
  for (const id of pruned) {
    try { unlinkSync(jobRecordPath(id, agentDir)); } catch { /* 已不存在 */ }
    try { unlinkSync(jobOutputPath(id, agentDir)); } catch { /* 已不存在 */ }
  }
  return pruned;
}

// ───────────────────── 输出文件 ─────────────────────

/** 输出文件的上限追踪：同进程内按 id 记住已写字节数，避免每次 stat。 */
const outputBytes = new Map<string, number>();

/** 建一个空输出文件（O_EXCL，0600），返回实际写入的路径。 */
export function createOutputFile(id: string, agentDir = getAgentDir()): string {
  mkdirSync(jobsDir(agentDir), { recursive: true });
  const path = jobOutputPath(id, agentDir);
  closeSync(openSync(path, "wx", 0o600));
  outputBytes.set(id, 0);
  return path;
}

/**
 * 追加一段输出。超过上限后**停止写入**并返回 true（调用方据此记 `outputTruncated`）。
 * 已经截断过的 job 直接返回 true，不再写盘。
 */
export function appendOutput(id: string, chunk: string, agentDir = getAgentDir()): boolean {
  if (!chunk) return false;
  const already = outputBytes.get(id) ?? 0;
  if (already >= BACKGROUND_JOB_MAX_OUTPUT_BYTES) return true;
  const bytes = Buffer.byteLength(chunk, "utf8");
  const remaining = BACKGROUND_JOB_MAX_OUTPUT_BYTES - already;
  if (bytes <= remaining) {
    appendFileSync(jobOutputPath(id, agentDir), chunk, { encoding: "utf8", mode: 0o600 });
    outputBytes.set(id, already + bytes);
    return false;
  }
  // 只写能放下的部分，宁可截在字符中间也不能越过上限。
  const head = Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
  appendFileSync(jobOutputPath(id, agentDir), head, { encoding: "utf8", mode: 0o600 });
  outputBytes.set(id, BACKGROUND_JOB_MAX_OUTPUT_BYTES);
  return true;
}

/** 读输出文件；可选只读尾部（注入摘要用，避免把 8 MB 读进内存）。 */
export function readOutput(id: string, agentDir = getAgentDir(), tailBytes?: number): string {
  const path = jobOutputPath(id, agentDir);
  if (!existsSync(path)) return "";
  if (tailBytes === undefined) return readFileSync(path, "utf8");
  const size = statSync(path).size;
  if (size <= tailBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(tailBytes);
    const bytesRead = readSync(fd, buffer, 0, tailBytes, size - tailBytes);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** 进程退出/重启时清掉内存里的字节计数。 */
export function forgetOutputBytes(id: string): void {
  outputBytes.delete(id);
}

/** 遗留结算：把落盘仍是 `running` 的记录改成 `interrupted`。 */
export function settleOrphanedJobs(agentDir = getAgentDir()): BackgroundJob[] {
  const settled: BackgroundJob[] = [];
  const now = new Date().toISOString();
  for (const job of listJobs(agentDir)) {
    const next = settleOrphanedJob(job, now);
    if (!next) continue;
    writeJob(next, agentDir);
    settled.push(next);
  }
  return settled;
}