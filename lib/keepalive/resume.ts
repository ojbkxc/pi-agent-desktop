import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  KEEPALIVE_AUTOFIX_STALE_MS,
  type AutofixSummary,
  type AutofixTaskLike,
} from "./types";

/**
 * 接续进度（只读半边）。
 *
 * autofix 的进度文件归 t3：`~/.pi/agent/autofix/tasks/<uuid>.json`，字段契约见
 * task#3 —— `task / cwd / status / round / maxRounds / lastError / sessionId / pid /
 * updatedAt`。**驱动/接续由 autofix 自己的 `startAutofixSweepLoop()` 完成**（它在
 * instrumentation 里自启动，进程重启后把孤儿任务重新驱动）；保活侧只做只读扫描，
 * 把「还有几个任务待接续」展示出来，绝不写对方文件、不抢驱动权。
 *
 * 孤儿判据（与 t3 逐字对齐）：
 * 1. `status ∈ {queued, running, verifying}` 才算活跃；
 * 2. `pid` 非空且进程存活 ⇒ **永不判孤儿**（长 agent 轮可能远超心跳阈值）；
 * 3. pid 缺失/已死，再看 `now - updatedAt >= staleMs`（默认 10 分钟）⇒ 可接续（stuck）。
 */

export type AutofixTaskDisposition =
  | "active"
  | "resumable"
  | "waiting"
  | "succeeded"
  | "failed"
  | "unknown";

const ACTIVE_STATUSES = new Set(["queued", "running", "verifying"]);
const SUCCEEDED_STATUSES = new Set(["succeeded"]);
const FAILED_STATUSES = new Set(["failed", "exhausted", "stopped"]);

export function autofixTasksDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "autofix", "tasks");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把一份未知形状的任务文件收窄成只读子集；关键字段缺失返回 null。 */
export function normalizeAutofixTask(value: unknown): (AutofixTaskLike & { status: string }) | null {
  if (!isRecord(value)) return null;
  if (typeof value.status !== "string") return null;
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.task === "string" ? { task: value.task } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    status: value.status,
    ...(typeof value.round === "number" ? { round: value.round } : {}),
    ...(typeof value.maxRounds === "number" ? { maxRounds: value.maxRounds } : {}),
    ...(value.lastError === null || typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
    ...(value.sessionId === null || typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(value.pid === null || typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
  };
}

/**
 * 单个任务的归属分类。`alive` 是测试缝；默认 `process.kill(pid, 0)`。
 * 返回 `waiting` 表示活跃但刚更新过（可能正被本进程的 runner 接手），不重复驱动。
 */
export function classifyAutofixTask(
  task: unknown,
  options: {
    now?: number;
    staleMs?: number;
    alive?: (pid: number) => boolean;
  } = {},
): AutofixTaskDisposition {
  const normalized = normalizeAutofixTask(task);
  if (!normalized) return "unknown";
  const status = normalized.status;
  if (SUCCEEDED_STATUSES.has(status)) return "succeeded";
  if (FAILED_STATUSES.has(status)) return "failed";
  if (!ACTIVE_STATUSES.has(status)) return "unknown";

  const alive = options.alive ?? defaultIsPidAlive;
  const pid = normalized.pid;
  if (typeof pid === "number" && pid > 0 && alive(pid)) return "active";

  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? KEEPALIVE_AUTOFIX_STALE_MS;
  const updatedAt = normalized.updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    // 没有心跳信息、又没有活着的主人：按陈旧处理（宁可提示一次，也不要永远沉默）。
    return "resumable";
  }
  return now - updatedAt >= staleMs ? "resumable" : "waiting";
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ScannedAutofixTasks {
  tasks: AutofixTaskLike[];
  summary: AutofixSummary;
  /** 可接续（孤儿）任务 id；没有 id 的用文件名占位。 */
  resumableIds: string[];
  /** 目录不存在/读不了时为 true —— UI 显示「autofix 未启用」而不是 0 个任务。 */
  unavailable: boolean;
}

/** 只读扫描 autofix 任务目录并汇总（任何 IO 错误都降级为 unavailable，不抛）。 */
export function scanAutofixTasks(
  options: {
    agentDir?: string;
    now?: number;
    staleMs?: number;
    alive?: (pid: number) => boolean;
  } = {},
): ScannedAutofixTasks {
  const dir = autofixTasksDir(options.agentDir ?? getAgentDir());
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return {
      tasks: [],
      summary: { total: 0, active: 0, stuck: 0, succeeded: 0, failed: 0 },
      resumableIds: [],
      unavailable: true,
    };
  }

  const summary: AutofixSummary = { total: 0, active: 0, stuck: 0, succeeded: 0, failed: 0 };
  const tasks: AutofixTaskLike[] = [];
  const resumableIds: string[] = [];

  for (const name of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const task = normalizeAutofixTask(parsed);
    if (!task) continue;
    tasks.push(task);
    const disposition = classifyAutofixTask(parsed, options);
    if (disposition === "unknown") continue;
    summary.total += 1;
    if (disposition === "resumable") {
      summary.stuck += 1;
      resumableIds.push(task.id ?? name.replace(/\.json$/, ""));
    } else if (disposition === "succeeded") {
      summary.succeeded += 1;
    } else if (disposition === "failed") {
      summary.failed += 1;
    } else {
      summary.active += 1;
    }
  }

  return { tasks, summary, resumableIds, unavailable: false };
}

/**
 * 接续注记（dsh 的 recovery note 思路）：进程/机器重启后接续任务时，先让执行者核对
 * 工作目录的真实状态，避免把已完成的步骤再做一遍。autofix 的续跑提示由 t3 注入；
 * 这里导出给 UI「被打断的会话」提示与未来的通用接续共用。
 */
export function buildRecoveryNote(input: {
  task?: string | null;
  cwd?: string | null;
  round?: number | null;
  lastError?: string | null;
}): string {
  const lines = ["[keepalive] 上一轮执行被进程/机器退出打断，这是接续轮，不要从头重来。"];
  if (input.task) lines.push(`任务：${input.task}`);
  if (input.cwd) lines.push(`工作目录：${input.cwd}`);
  if (typeof input.round === "number") lines.push(`已完成轮次：${input.round}`);
  lines.push("先核对当前实际状态（git status / 最近提交 / 已有改动 / 测试输出），已完成的步骤直接跳过，只继续未完成的部分。");
  if (input.lastError) lines.push(`上次错误摘要：${input.lastError.slice(0, 800)}`);
  return lines.join("\n");
}
