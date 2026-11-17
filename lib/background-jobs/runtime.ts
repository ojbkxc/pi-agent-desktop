/**
 * 后台 job 的**运行时**：真正启动子进程、收集输出、结束通知。
 *
 * 与 SDK 前台 bash 的差异只在「等不等」：这里 `execute` 立刻返回，进程在后台跑完
 * 再把结果作为**新事件**投回会话（`sendCustomMessage({triggerTurn:true})`）。
 *
 * 三条实现纪律：
 * 1. **进程组**：Unix `detached: true` + `process.kill(-pid)` 杀整组；Windows
 *    `taskkill /T /F` 连子孙。SDK 前台 bash 同策略——只杀 shell 会让 `node` 变孤儿。
 * 2. **不挂在 stdio 上等**：子进程的 stdout/stderr 被 `data` 监听并写文件，
 *    不能 `await` 一个「管道关闭」的 promise——后台守护进程持有管道时那就永远不结束
 *    （SDK 注释里的 #11613 正是这个坑）。这里只等 `exit` 事件。
 * 3. **通知只在终态发一次**：`notifyOnTerminal` 由结束路径统一调用；stop 与超时
 *    也走同一条路，避免「stop 后还收到一条 completed」。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import {
  appendOutput,
  createOutputFile,
  forgetOutputBytes,
  isJobId,
  jobOutputPath,
  jobsDir,
  newJobId,
  pruneJobs,
  readJob,
  readOutput,
  writeJob,
} from "./store";
import {
  BACKGROUND_JOB_TAIL_CHARS,
  backgroundJobNotificationText,
  clampTimeoutSec,
  jobTail,
  statusFromExit,
  type BackgroundJob,
} from "./types";

/** 活跃句柄：只在本进程内有效，重启后消失（落盘记录由 settleOrphanedJobs 结算）。 */
interface ActiveJob {
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout> | null;
  /** 谁先决议终态谁赢：stop / 超时 / 进程退出三路并发。 */
  settled: boolean;
  outputTruncated: boolean;
  /** 结束时用于通知的会话 id（构造时固定，避免记录被改写后发错人）。 */
  sessionId: string;
  /**
   * 子进程 pid 的内存副本。**不能只依赖落盘记录里的 pid**：`finish()` 里如果
   * `readJob()` 失败（记录损坏/被并发清理），落盘那份读不到，而停止/超时仍必须
   * 能杀进程——否则进程变孤儿，且句柄已被删除，之后 stop 永远返回 null。
   */
  pid?: number;
}

// globalThis：Next.js 热重载会重建模块作用域，模块级 Map 会丢句柄——
// 丢掉的句柄意味着 stop 找不到进程、进程变成孤儿。与 rpc-manager 的 registry 同理。
declare global {
  var __piBackgroundJobs: Map<string, ActiveJob> | undefined;
}

function activeJobs(): Map<string, ActiveJob> {
  if (!globalThis.__piBackgroundJobs) globalThis.__piBackgroundJobs = new Map();
  return globalThis.__piBackgroundJobs;
}

export interface StartJobRequest {
  sessionId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  label: string;
  timeoutSec?: number;
}

export interface StartJobResult {
  job: BackgroundJob;
}

export class BackgroundJobError extends Error {
  readonly code: "validation" | "spawn";
  constructor(code: "validation" | "spawn", message: string) {
    super(message);
    this.name = "BackgroundJobError";
    this.code = code;
  }
}

/** 杀整个进程树。Unix 杀进程组；Windows 用 taskkill /T。忽略「已退出」的错误。 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      // 必须监听 error：taskkill 不存在（ENOENT）或参数异常时，spawn 会发异步
      // 'error' 事件；没有监听器就是一个 unhandled 'error'，Node 下直接崩掉整个服务。
      killer.on("error", (error) => {
        console.error(
          `[pi-web] taskkill 启动失败，无法结束进程树 ${pid}:`,
          error instanceof Error ? error.message : error,
        );
      });
    } catch {
      // spawn 同步抛（极少见）；此时确实没有别的办法，记录一条便于排查。
      console.error(`[pi-web] 无法启动 taskkill，进程树 ${pid} 可能仍在运行`);
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ }
  }
}

export function startBackgroundJob(request: StartJobRequest): StartJobResult {
  const command = request.command?.trim();
  if (!command) throw new BackgroundJobError("validation", "command must not be empty");
  if (!request.cwd || !existsSync(request.cwd)) {
    throw new BackgroundJobError("validation", `Working directory does not exist: ${request.cwd}`);
  }
  const timeoutSec = clampTimeoutSec(request.timeoutSec);
  const id = newJobId();
  const outputPath = createOutputFile(id);
  const startedAt = new Date().toISOString();
  const shell = getShellConfig();

  let child: ChildProcess;
  try {
    child = spawn(shell.shell, [...shell.args, command], {
      cwd: request.cwd,
      // 进程组：stop 时能连子孙一起杀（与 SDK 前台 bash 同策略）。
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    // 输出文件已经建好，删掉它，别留孤儿文件。
    forgetOutputBytes(id);
    throw new BackgroundJobError("spawn", error instanceof Error ? error.message : String(error));
  }

  const job: BackgroundJob = {
    version: 1,
    id,
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    command,
    cwd: request.cwd,
    label: request.label || command.slice(0, 80),
    status: "running",
    startedAt,
    outputPath,
    outputTruncated: false,
    timeoutSec,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
  };
  writeJob(job);

  const entry: ActiveJob = {
    child,
    timer: null,
    settled: false,
    outputTruncated: false,
    sessionId: request.sessionId,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
  };
  activeJobs().set(id, entry);

  const onData = (chunk: Buffer): void => {
    if (appendOutput(id, chunk.toString("utf8"))) entry.outputTruncated = true;
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  if (timeoutSec > 0) {
    entry.timer = setTimeout(() => {
      finish(id, "timedout", { exitCode: null, signal: null, error: `超时（${timeoutSec}s）` });
    }, timeoutSec * 1000);
    entry.timer.unref?.();
  }

  child.once("error", (error) => {
    finish(id, "failed", { exitCode: null, signal: null, error: error.message });
  });
  child.once("exit", (exitCode, signal) => {
    finish(id, statusFromExit(exitCode, signal), { exitCode, signal });
  });

  return { job };
}

interface FinishDetails {
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

/**
 * 终态收敛 + 通知。三路（exit / timeout / stop）都可能先到，先到者赢；
 * 后到者只看不改。终态消息**总是**写盘后发一条，且只发一条。
 */
function finish(id: string, status: BackgroundJob["status"], details: FinishDetails): void {
  const entry = activeJobs().get(id);
  if (!entry || entry.settled) return;
  entry.settled = true;
  if (entry.timer) clearTimeout(entry.timer);
  activeJobs().delete(id);

  // 超时与 stop 要真的把进程杀掉，不能只改状态。
  //
  // 这件事必须发生在读盘**之前**：读盘可能失败（记录损坏、被并发清理），
  // 失败就 return 的话进程会继续跑，而 settled 已置位、句柄已删，
  // 之后 stopBackgroundJob 永远返回 null —— 进程永久孤儿。
  // pid 优先取内存副本（entry.pid），不依赖落盘记录。
  const pid = entry.pid;
  if ((status === "timedout" || status === "stopped") && pid !== undefined) {
    killProcessTree(pid);
  }

  let current: BackgroundJob;
  try {
    current = readJob(id) ?? (() => { throw new Error(`job ${id} record missing`); })();
  } catch (error) {
    console.error("[pi-web] 后台 job 记录读取失败:", error instanceof Error ? error.message : error);
    forgetOutputBytes(id);
    return;
  }

  const finishedAt = new Date().toISOString();
  const done: BackgroundJob = {
    ...current,
    status,
    finishedAt,
    exitCode: details.exitCode,
    signal: details.signal,
    outputTruncated: entry.outputTruncated,
    ...(details.error ? { error: details.error } : {}),
  };
  try {
    done.tail = jobTail(readOutput(id), BACKGROUND_JOB_TAIL_CHARS);
  } catch {
    done.tail = "";
  }
  try {
    writeJob(done);
  } catch (error) {
    console.error("[pi-web] 后台 job 结果写盘失败:", error instanceof Error ? error.message : error);
  }
  forgetOutputBytes(id);
  void notifyJobDone(done);
  try { pruneJobs(); } catch { /* 保留策略失败不影响本次 */ }
}

/**
 * 把结果投回发起它的会话。投递失败只记日志——job 本身已经结束，
 * 结果在 `jobs/<id>.json` 与 `.log` 里，用户仍能查到。
 */
async function notifyJobDone(job: BackgroundJob): Promise<void> {
  try {
    const { getRpcSession, startRpcSession } = await import("../rpc-manager");
    let wrapper = getRpcSession(job.sessionId);
    if (!wrapper?.isAlive()) {
      const { resolveSessionPath } = await import("../session-reader");
      const filePath = await resolveSessionPath(job.sessionId);
      if (!filePath) {
        console.warn(`[pi-web] 后台 job ${job.id} 完成，但发起会话已找不到`);
        return;
      }
      wrapper = (await startRpcSession(job.sessionId, filePath, undefined, {})).session;
    }
    await wrapper.waitUntilReady();
    // 会话正在跑时 followUp 只会排队到本轮结束；这不是错误路径——
    // 排队正是我们要的（结束后立刻续跑），所以不必像 subagent 那样轮询等待。
    await wrapper.inner.sendCustomMessage({
      customType: "pi-web:background-job",
      content: backgroundJobNotificationText(job),
      display: true,
      details: { kind: "pi-web-background-job", jobId: job.id, status: job.status, command: job.command, outputPath: job.outputPath },
    }, { deliverAs: "followUp", triggerTurn: true });
  } catch (error) {
    console.error("[pi-web] 后台 job 完成通知投递失败:", error instanceof Error ? error.message : error);
  }
}

/**
 * 主动停止一个 job。**只有真的从活跃态停掉才算成功**：已结束（无论什么终态）或不存在
 * 一律返回 null——调用方（工具、路由）据此报「没有正在跑的任务」，而不是拿一条早就
 * completed 的记录谎称「已停止」。
 */
export function stopBackgroundJob(id: string): BackgroundJob | null {
  if (!isJobId(id) || !activeJobs().has(id)) return null;
  finish(id, "stopped", { exitCode: null, signal: null, error: "用户停止" });
  try {
    const job = readJob(id);
    return job?.status === "stopped" ? job : null;
  } catch {
    return null;
  }
}

/** 本进程内是否还持有该 job 的句柄。 */
export function isJobActive(id: string): boolean {
  return activeJobs().has(id);
}

/** 启动时清理：上次进程带着 job 一起死了，落盘的 running 要结算成 interrupted。 */
export function ensureJobsDir(): void {
  mkdirSync(jobsDir(), { recursive: true });
}

/** 测试/重启清理用：把所有活跃 job 杀掉并清空内存表。 */
export function stopAllBackgroundJobs(): void {
  for (const id of [...activeJobs().keys()]) {
    // finish 的 stopped 分支会调 killProcessTree；先到者赢，已结算的不会再动。
    finish(id, "stopped", { exitCode: null, signal: null, error: "服务关闭" });
  }
  activeJobs().clear();
}

export { jobOutputPath, jobsDir };