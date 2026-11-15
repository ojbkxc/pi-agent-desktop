/**
 * 「自动修 Bug」任务落盘（server-only）。
 *
 * 位置：`<agent dir>/autofix/tasks/<uuid>.json`（默认 `~/.pi/agent/autofix/tasks/`，
 * 与 goal / scheduled-tasks 同根；遵守 PI_CODING_AGENT_DIR，测试可注入 agentDir）。
 * 每任务一份 JSON，`writePrivateFileAtomicSync` 原子写：崩溃/满盘只会留下旧文件或
 * 新文件，绝不会是截断的一半。
 *
 * 所有读写都是同步的：进程内的读-改-写在中间没有 await，不会自我交错；跨进程并发
 * 由 runner 的「认领后复核 pid」处理（照 acquireLease 的写法）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import {
  AUTOFIX_DEFAULT_MAX_ROUNDS,
  AUTOFIX_MAX_ROUND_RECORDS,
  AUTOFIX_MAX_ROUNDS,
  AUTOFIX_MAX_TASKS,
  AUTOFIX_STATUSES,
  AUTOFIX_TASK_MAX_LENGTH,
  AUTOFIX_VERIFY_MAX_LENGTH,
  AutofixValidationError,
  isActiveAutofixStatus,
  type AutofixRound,
  type AutofixStatus,
  type AutofixTask,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function autofixDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "autofix");
}

export function autofixTasksDir(agentDir: string = getAgentDir()): string {
  return join(autofixDir(agentDir), "tasks");
}

export function autofixTaskPath(id: string, agentDir: string = getAgentDir()): string {
  if (!UUID_PATTERN.test(id)) throw new Error("Invalid autofix task id");
  return join(autofixTasksDir(agentDir), `${id}.json`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isRound(value: unknown): value is AutofixRound {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.round)
    && isFiniteNumber(value.at)
    && typeof value.status === "string"
    && (value.verifyExitCode === null || isFiniteNumber(value.verifyExitCode))
    && (value.error === undefined || typeof value.error === "string")
    && (value.outputTail === undefined || typeof value.outputTail === "string");
}

/** 磁盘 JSON → AutofixTask 守卫；缺字段/越界一律拒绝（当作不存在）。 */
export function isAutofixTask(value: unknown): value is AutofixTask {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.id === "string"
    && UUID_PATTERN.test(value.id)
    && typeof value.task === "string"
    && typeof value.cwd === "string"
    && typeof value.verifyCommand === "string"
    && typeof value.status === "string"
    && (AUTOFIX_STATUSES as readonly string[]).includes(value.status)
    && isFiniteNumber(value.round)
    && isFiniteNumber(value.maxRounds)
    && (value.lastError === null || typeof value.lastError === "string")
    && (value.sessionId === null || typeof value.sessionId === "string")
    && (value.pid === null || isFiniteNumber(value.pid))
    && isFiniteNumber(value.createdAt)
    && isFiniteNumber(value.updatedAt)
    && (value.finishedAt === null || isFiniteNumber(value.finishedAt))
    && Array.isArray(value.rounds)
    && value.rounds.every(isRound);
}

/** 读一个任务；缺文件 / 坏 JSON / 守卫不过一律 undefined。 */
export function getAutofixTask(id: string, agentDir: string = getAgentDir()): AutofixTask | undefined {
  if (!UUID_PATTERN.test(id)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(autofixTaskPath(id, agentDir), "utf8"));
    return isAutofixTask(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 全部任务，最新的在前（列表页 / 保活扫描共用）。坏文件跳过但不删除。 */
export function listAutofixTasks(agentDir: string = getAgentDir()): AutofixTask[] {
  let files: string[];
  try {
    files = readdirSync(autofixTasksDir(agentDir));
  } catch {
    return [];
  }
  const tasks: AutofixTask[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    if (!UUID_PATTERN.test(id)) continue;
    const task = getAutofixTask(id, agentDir);
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => b.createdAt - a.createdAt);
}

function writeTask(task: AutofixTask, agentDir: string): void {
  mkdirSync(autofixTasksDir(agentDir), { recursive: true });
  writePrivateFileAtomicSync(autofixTaskPath(task.id, agentDir), `${JSON.stringify(task, null, 2)}\n`);
}

function capRounds(rounds: AutofixRound[]): AutofixRound[] {
  return rounds.length <= AUTOFIX_MAX_ROUND_RECORDS
    ? rounds
    : rounds.slice(rounds.length - AUTOFIX_MAX_ROUND_RECORDS);
}

export interface CreateAutofixTaskInput {
  task: string;
  cwd: string;
  verifyCommand: string;
  maxRounds?: number;
}

/**
 * 建一个排队任务（不做目录存在性校验——那是路由层的事，这里只保证字段合法）。
 * 任务数达到上限时拒绝，防止 autofix 目录无限膨胀。
 */
export function createAutofixTask(input: CreateAutofixTaskInput, agentDir: string = getAgentDir()): AutofixTask {
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!task) throw new AutofixValidationError("Task statement is required", "autofix.error.taskRequired");
  if (task.length > AUTOFIX_TASK_MAX_LENGTH) {
    throw new AutofixValidationError(
      `Task statement is longer than ${AUTOFIX_TASK_MAX_LENGTH} characters`,
      "autofix.error.taskTooLong",
      { max: AUTOFIX_TASK_MAX_LENGTH },
    );
  }
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!cwd) throw new AutofixValidationError("cwd is required", "autofix.error.cwdRequired");
  const verifyCommand = typeof input.verifyCommand === "string" ? input.verifyCommand.trim() : "";
  if (!verifyCommand) {
    throw new AutofixValidationError("A verification command is required", "autofix.error.verifyRequired");
  }
  if (verifyCommand.length > AUTOFIX_VERIFY_MAX_LENGTH) {
    throw new AutofixValidationError(
      `Verification command is longer than ${AUTOFIX_VERIFY_MAX_LENGTH} characters`,
      "autofix.error.verifyTooLong",
      { max: AUTOFIX_VERIFY_MAX_LENGTH },
    );
  }
  const maxRounds = input.maxRounds ?? AUTOFIX_DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > AUTOFIX_MAX_ROUNDS) {
    throw new AutofixValidationError(
      `maxRounds must be an integer between 1 and ${AUTOFIX_MAX_ROUNDS}`,
      "autofix.error.maxRoundsRange",
      { max: AUTOFIX_MAX_ROUNDS },
    );
  }
  if (listAutofixTasks(agentDir).length >= AUTOFIX_MAX_TASKS) {
    throw new AutofixValidationError(
      `At most ${AUTOFIX_MAX_TASKS} autofix tasks may exist; delete older ones first`,
      "autofix.error.tooManyTasks",
      { max: AUTOFIX_MAX_TASKS },
    );
  }
  const now = Date.now();
  const created: AutofixTask = {
    version: 1,
    id: randomUUID(),
    task,
    cwd,
    verifyCommand,
    status: "queued",
    round: 0,
    maxRounds,
    lastError: null,
    sessionId: null,
    pid: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    rounds: [],
  };
  writeTask(created, agentDir);
  return created;
}

/**
 * 同步读-改-写。`change` 返回新任务；轮次记录在这里统一裁剪。
 * 任务不存在返回 undefined（调用方自己决定是不是竞态）。
 */
export function updateAutofixTask(
  id: string,
  change: (task: AutofixTask) => AutofixTask,
  agentDir: string = getAgentDir(),
): AutofixTask | undefined {
  const current = getAutofixTask(id, agentDir);
  if (!current) return undefined;
  const next = change(current);
  const capped: AutofixTask = {
    ...next,
    status: next.status as AutofixStatus,
    rounds: capRounds(next.rounds),
    updatedAt: Number.isFinite(next.updatedAt) ? next.updatedAt : Date.now(),
  };
  writeTask(capped, agentDir);
  return capped;
}

/** 常用更新：刷新心跳（updatedAt）与零散字段。 */
export function touchAutofixTask(
  id: string,
  patch: Partial<Pick<AutofixTask, "status" | "round" | "lastError" | "sessionId" | "pid" | "finishedAt" | "rounds">>,
  agentDir: string = getAgentDir(),
): AutofixTask | undefined {
  return updateAutofixTask(id, (task) => ({
    ...task,
    ...patch,
    ...(patch.rounds ? { rounds: patch.rounds } : {}),
    updatedAt: Date.now(),
  }), agentDir);
}

export function deleteAutofixTask(id: string, agentDir: string = getAgentDir()): boolean {
  if (!UUID_PATTERN.test(id)) return false;
  const path = autofixTaskPath(id, agentDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** 供 runner 使用：任务是否正在被本进程驱动。 */
export function isActiveTask(task: AutofixTask): boolean {
  return isActiveAutofixStatus(task.status);
}
