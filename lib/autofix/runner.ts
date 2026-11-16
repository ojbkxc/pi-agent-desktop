/**
 * 「自动修 Bug」驱动引擎（server-only）。
 *
 * 一个任务 = 一个 agent 会话 + 一个工作目录（照 dsh Executor 的「每任务一
 * Session + 一工作目录」）。循环：
 *
 *   agent 回合（修） → 引擎跑验证命令（判） → 失败输出喂回 → 再修 …
 *
 * 直到验证 exit 0（succeeded）或轮次触顶（exhausted）或用户停止（stopped）。
 * **判据永远在引擎这一侧**：模型自称「修好了」不算数，只有验证命令 exit 0 才算。
 *
 * 进度落 `<agent dir>/autofix/tasks/<id>.json`（见 store.ts / types.ts），
 * 供挂机保活接续——保活侧约定调用：
 *   - `resumeAutofixTasks({ staleMs: 600_000 })`：把「活跃 + 孤儿」的任务重新驱动；
 *   - `summarizeAutofixTasks()`：只读汇总（total/active/stuck/succeeded/failed）。
 * 两者都不抛错、幂等（进程内驱动表按 taskId 去重、启动并发上限 1）。
 *
 * 驱动进程 pid 语义：`task.pid` 是**本进程**（Next server）的 pid，不是 agent
 * 会话进程；pid 活着 ⇒ 保活绝不判孤儿（长回合可能超过任何心跳阈值）。
 */
import { randomUUID } from "node:crypto";
import { isBlockingExtensionUiRequest } from "../browser-notifications";
import { buildRecoveryNote } from "../keepalive/resume";
import { advanceOutageBudget, initialOutageBudget, isOutageDue } from "../outage/backoff";
import { classifyOutageError } from "../outage/classify";
import {
  createOutageRecord,
  finishOutageRecord,
  getOutageRecord,
  readOutageSettings,
  updateOutageRecord,
} from "../outage/store";
import {
  isOutageExpired,
  isOutageSuspendKind,
  outageMaxWaitMs,
  OUTAGE_DEFAULT_MAX_ATTEMPTS,
  type OutageSuspendKind,
} from "../outage/types";
import { isPidAlive } from "../scheduled-tasks/lease";
import type { BlockingExtensionUiRequest, ExtensionUiRequest } from "../types";
import { emitAutofixEvent } from "./events";
import { autofixSessionName, buildAutofixPrompt } from "./prompt";
import {
  getAutofixTask,
  listAutofixTasks,
  touchAutofixTask,
  updateAutofixTask,
} from "./store";
import {
  AUTOFIX_ERROR_MAX_CHARS,
  AUTOFIX_OUTPUT_TAIL_MAX_CHARS,
  AUTOFIX_TOOL_NAMES,
  AUTOFIX_TURN_TIMEOUT_MS,
  AUTOFIX_VERIFY_TIMEOUT_MS,
  isActiveAutofixStatus,
  isAutofixTaskResumable,
  summarizeAutofixTaskList,
  tailOf,
  type AutofixRound,
  type AutofixStatus,
  type AutofixSummary,
  type AutofixTask,
} from "./types";
import { runVerifyCommand, type VerifyOutcome } from "./verify";

/** 自定义会话条目类型：标记「这个会话是自动修 Bug 的修复会话」。 */
export const AUTOFIX_ENTRY_TYPE = "pi-web:autofix";
/** 进程内同时驱动的任务数上限（=1：多任务同 cwd 会抢端口/抢测试文件）。 */
const MAX_CONCURRENT_DRIVERS = 1;

// ───────────────────────────── 依赖（测试可注入） ─────────────────────────────

/** runner 需要的最小会话面（AgentSessionWrapper / 测试桩都满足）。 */
export interface AutofixSessionLike {
  send(command: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  isAlive?(): boolean;
  isRunning?(): boolean;
  inner?: { sessionManager?: { appendCustomEntry?(customType: string, data: unknown): unknown } };
}

export interface OpenedAutofixSession {
  session: AutofixSessionLike;
  sessionId: string;
  /** True when a brand-new session was created (vs. reattached by sessionId). */
  created: boolean;
}

export interface AutofixDeps {
  agentDir?: string;
  now(): number;
  /** 打开（或新建）该任务的修复会话。 */
  openSession(task: AutofixTask): Promise<OpenedAutofixSession>;
  /** 跑验证命令；exit code 0 = 修好。 */
  runVerify(command: string, cwd: string, options: { timeoutMs: number }): Promise<VerifyOutcome>;
  isPidAlive(pid: number): boolean;
  turnTimeoutMs?: number;
  verifyTimeoutMs?: number;
  /** 用户停止 / 进程退出时的中止信号。 */
  signal?: AbortSignal;
}

type TurnOutcome =
  | { kind: "ok" }
  | { kind: "error"; error: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "attention"; error: string };

// ───────────────────────────── 进程内驱动表 ─────────────────────────────

interface RunningDriver {
  controller: AbortController;
  promise: Promise<void>;
}

const DRIVERS_KEY = Symbol.for("pi-web:autofix-drivers");

function drivers(): Map<string, RunningDriver> {
  const holder = globalThis as unknown as Record<symbol, Map<string, RunningDriver> | undefined>;
  return (holder[DRIVERS_KEY] ??= new Map<string, RunningDriver>());
}

export function isAutofixTaskDriving(id: string): boolean {
  return drivers().has(id);
}

export function activeAutofixDriverCount(): number {
  return drivers().size;
}

// ───────────────────────────── 启动 / 停止 ─────────────────────────────

/**
 * 启动驱动（后台跑，立即返回 promise）。同一任务重复调用返回同一个 promise
 * （幂等）；任务已被另一进程驱动时 `driveAutofixTask` 会自行放弃。
 */
export function startAutofixTask(
  id: string,
  options: { agentDir?: string; deps?: Partial<AutofixDeps> } = {},
): Promise<void> {
  // 测试/e2e 缝：只建任务不驱动（避免真去跑 npm test / 建真会话）。
  if (process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER === "1") return Promise.resolve();
  const running = drivers().get(id);
  if (running) return running.promise;
  const controller = new AbortController();
  const deps = createLiveAutofixDeps({ ...options.deps, agentDir: options.agentDir, signal: controller.signal });
  const promise = driveAutofixTask(id, deps)
    .catch((error) => {
      console.error("[autofix] drive failed:", error instanceof Error ? error.message : error);
    })
    .finally(() => {
      if (drivers().get(id)?.controller === controller) drivers().delete(id);
    });
  drivers().set(id, { controller, promise });
  return promise;
}

/** 用户停止：立刻落 stopped（循环在每个检查点都会看到），再中止会话与驱动。 */
export async function stopAutofixTask(
  id: string,
  options: { agentDir?: string } = {},
): Promise<AutofixTask | undefined> {
  const task = getAutofixTask(id, options.agentDir);
  if (!task) return undefined;
  drivers().get(id)?.controller.abort();
  const updated = touchAutofixTask(
    id,
    { status: "stopped", pid: null, finishedAt: Date.now() },
    options.agentDir,
  );
  emitAutofixEvent({ type: "task_changed", taskId: id, status: "stopped" });
  if (task.sessionId) {
    try {
      const { getRpcSession } = await import("../rpc-manager");
      const wrapper = getRpcSession(task.sessionId);
      if (wrapper?.isAlive() && wrapper.isRunning()) {
        void wrapper.send({ type: "abort" }).catch(() => undefined);
      }
    } catch {
      // A session that is gone needs no abort.
    }
  }
  return updated;
}

/**
 * 手动继续（UI「继续」）。给一轮**全新预算**：round/rounds 归零、状态回 queued，
 * 然后立刻驱动。修好/正在驱动的任务原样返回（幂等）。
 */
export async function resumeAutofixTask(
  id: string,
  options: { agentDir?: string } = {},
): Promise<AutofixTask | undefined> {
  const task = getAutofixTask(id, options.agentDir);
  if (!task) return undefined;
  if (task.status === "succeeded") return task;
  if (isActiveAutofixStatus(task.status) && isAutofixTaskDriving(id)) return task;
  const updated = touchAutofixTask(
    id,
    { status: "queued", pid: null, round: 0, rounds: [], finishedAt: null },
    options.agentDir,
  );
  if (updated) {
    emitAutofixEvent({ type: "task_changed", taskId: id, status: "queued" });
    void startAutofixTask(id, { agentDir: options.agentDir });
  }
  return updated;
}

// ───────────────────────────── 核心循环 ─────────────────────────────

/**
 * 驱动一个任务直到终结。导出供测试注入 deps；生产入口用 `startAutofixTask`。
 *
 * 认领：把 status 置 running、pid 置本进程，再**复核**落盘结果（跨进程同样发起
 * 认领时，落盘较晚者赢，另一侧看到 pid 不是自己就放弃——照 acquireLease 的写法）。
 */
export async function driveAutofixTask(id: string, deps: AutofixDeps): Promise<void> {
  const agentDir = deps.agentDir;
  const now = () => deps.now();

  let task = getAutofixTask(id, agentDir);
  if (!task || !isActiveAutofixStatus(task.status)) return;
  if (
    (task.status === "running" || task.status === "verifying")
    && typeof task.pid === "number"
    && task.pid !== process.pid
    && deps.isPidAlive(task.pid)
  ) {
    return; // 另一活着的进程正在驱动，绝不去抢
  }

  touchAutofixTask(id, { status: "running", pid: process.pid }, agentDir);
  const claimed = getAutofixTask(id, agentDir);
  if (!claimed || claimed.pid !== process.pid || !isActiveAutofixStatus(claimed.status)) return;
  task = claimed;
  emitAutofixEvent({ type: "task_changed", taskId: id, status: "running" });

  const turnTimeoutMs = deps.turnTimeoutMs ?? AUTOFIX_TURN_TIMEOUT_MS;
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? AUTOFIX_VERIFY_TIMEOUT_MS;

  for (;;) {
    if (deps.signal?.aborted) {
      finishTask(id, "stopped", null, deps);
      return;
    }
    // 每一轮都重读：外部（UI / 保活 / 删除）可能改了状态。
    task = getAutofixTask(id, agentDir);
    if (!task) return;
    if (!isActiveAutofixStatus(task.status)) return;
    if (task.round >= task.maxRounds) {
      finishTask(id, "exhausted", null, deps);
      return;
    }

    const round = task.round + 1;
    // 从 Provider 中断恢复：注入接续注记（buildRecoveryNote，此前无人调用），
    // 让模型先核对工作目录真实状态，别把已完成的步骤再做一遍。
    const outage = task.sessionId ? getOutageRecord(task.sessionId, agentDir) : undefined;
    const recovery = outage?.status === "waiting"
      ? buildRecoveryNote({ task: task.task, cwd: task.cwd, round: task.round, lastError: outage.reason })
      : null;
    const prompt = [
      recovery,
      buildAutofixPrompt({
        task: task.task,
        cwd: task.cwd,
        verifyCommand: task.verifyCommand,
        round,
        maxRounds: task.maxRounds,
        lastError: task.lastError,
        lastOutputTail: lastVerifyTail(task),
      }),
    ].filter(Boolean).join("\n\n");
    task = touchAutofixTask(id, { status: "running", round, pid: process.pid }, agentDir) ?? task;
    emitAutofixEvent({ type: "task_changed", taskId: id, status: "running" });

    let opened: OpenedAutofixSession;
    try {
      opened = await deps.openSession(task);
    } catch (error) {
      finishTask(id, "failed", `Could not open the fix session: ${errorText(error)}`, deps);
      return;
    }
    if (opened.sessionId !== task.sessionId) {
      task = touchAutofixTask(id, { sessionId: opened.sessionId }, agentDir) ?? task;
    }

    const turn = await runAgentTurn(opened.session, prompt, { timeoutMs: turnTimeoutMs, signal: deps.signal });
    if (deps.signal?.aborted) {
      finishTask(id, "stopped", null, deps);
      return;
    }
    if (turn.kind === "aborted") {
      finishTask(id, "stopped", "Stopped while the agent was working", deps);
      return;
    }
    if (turn.kind === "attention") {
      finishTask(id, "stopped", turn.error, deps);
      return;
    }
    if (turn.kind !== "ok") {
      const error = turn.kind === "timeout"
        ? `Agent turn timed out after ${Math.round(turnTimeoutMs / 60_000)} minutes`
        : turn.error;
      // Provider 中断（5xx/连接拒绝/流中断）或额度耗尽：**不消耗轮次**，
      // 任务转 waiting-provider 并落一条挂起记录；恢复后由 sweep 重新驱动。
      // `turn.kind === "error"` 才分类（timeout/aborted/attention 与上游无关）。
      if (turn.kind === "error") {
        const classification = classifyOutageError({ errorText: error });
        if (classification.suspend && isOutageSuspendKind(classification.kind)) {
          suspendForProviderOutage(id, task, round - 1, classification.kind, error, deps);
          return;
        }
      }
      recordRound(id, {
        round,
        at: now(),
        status: turn.kind === "timeout" ? "timeout" : "agent-error",
        verifyExitCode: null,
        error: tailOf(error, AUTOFIX_ERROR_MAX_CHARS),
      }, deps);
      if (round >= task.maxRounds) {
        finishTask(id, "failed", error, deps);
        return;
      }
      continue;
    }

    // 上游恢复、本轮跑通：挂起记录收口（attempts/退避作废，不再续跑该会话）。
    if (task.sessionId) finishRunOutageRecord(task.sessionId, agentDir);

    // ── 判据：引擎自己跑验证命令 ──
    touchAutofixTask(id, { status: "verifying", pid: process.pid }, agentDir);
    emitAutofixEvent({ type: "task_changed", taskId: id, status: "verifying" });
    let verify: VerifyOutcome;
    try {
      verify = await deps.runVerify(task.verifyCommand, task.cwd, { timeoutMs: verifyTimeoutMs });
    } catch (error) {
      verify = { exitCode: null, timedOut: false, outputTail: errorText(error), durationMs: 0 };
    }
    if (deps.signal?.aborted) {
      finishTask(id, "stopped", null, deps);
      return;
    }
    const passed = !verify.timedOut && verify.exitCode === 0;
    const failure = passed ? null : verifyFailureText(verify);
    recordRound(id, {
      round,
      at: now(),
      status: passed ? "verify-passed" : "verify-failed",
      verifyExitCode: verify.timedOut ? null : verify.exitCode,
      ...(passed
        ? { outputTail: tailOf(verify.outputTail, AUTOFIX_OUTPUT_TAIL_MAX_CHARS) }
        : {
            error: tailOf(failure ?? "Verification failed", AUTOFIX_ERROR_MAX_CHARS),
            outputTail: tailOf(verify.outputTail, AUTOFIX_OUTPUT_TAIL_MAX_CHARS),
          }),
    }, deps);

    if (passed) {
      finishTask(id, "succeeded", null, deps);
      return;
    }
    if (round >= task.maxRounds) {
      finishTask(id, "exhausted", failure, deps);
      return;
    }
  }
}

// ───────────────────────────── 回合 / 落盘辅助 ─────────────────────────────

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 最近一次验证失败输出（给下一轮 prompt）。 */
function lastVerifyTail(task: AutofixTask): string | null {  for (let index = task.rounds.length - 1; index >= 0; index -= 1) {
    const round = task.rounds[index];
    if (round.status === "verify-failed" && round.outputTail) return round.outputTail;
  }
  return null;
}

function verifyFailureText(verify: VerifyOutcome): string {
  if (verify.timedOut) return "Verification timed out";
  return `Verification failed with exit code ${verify.exitCode ?? "unknown"}`;
}

function recordRound(id: string, round: AutofixRound, deps: AutofixDeps): void {
  const updated = updateAutofixTask(id, (task) => ({
    ...task,
    rounds: [...task.rounds, round],
    lastError: round.error ?? task.lastError,
    updatedAt: deps.now(),
  }), deps.agentDir);
  if (updated) {
    emitAutofixEvent({ type: "task_changed", taskId: id, status: updated.status });
  }
}

function finishTask(
  id: string,
  status: AutofixStatus,
  lastError: string | null,
  deps: AutofixDeps,
): void {
  touchAutofixTask(id, {
    status,
    pid: null,
    finishedAt: deps.now(),
    ...(lastError ? { lastError: tailOf(lastError, AUTOFIX_ERROR_MAX_CHARS) } : {}),
  }, deps.agentDir);
  emitAutofixEvent({ type: "task_changed", taskId: id, status });
}

/**
 * Provider 中断：**不消耗轮次**、不判失败——把 round 退回触发这一轮之前的数值，
 * 任务转 `waiting-provider`，并在该修复会话上落一条 outage 记录（scope="autofix"）。
 *
 * 为什么 scope 是 "autofix"：这条记录的**驱动者是 autofix sweep**，不是通用
 * outage scheduler（后者只续跑普通会话）。scheduler 见到 scope="autofix" 会跳过。
 */
function suspendForProviderOutage(
  id: string,
  task: AutofixTask,
  previousRound: number,
  kind: OutageSuspendKind,
  error: string,
  deps: AutofixDeps,
): void {
  const agentDir = deps.agentDir;
  const now = deps.now();
  const settings = readOutageSettings();
  const maxWaitMs = outageMaxWaitMs(kind, settings);

  // 用户关闭了自动等待（或额度等待设为 0）：按普通失败轮上报，尊重设置。
  if (!settings.enabled || maxWaitMs <= 0) {
    recordRound(id, {
      round: previousRound + 1,
      at: now,
      status: "agent-error",
      verifyExitCode: null,
      error: tailOf(error, AUTOFIX_ERROR_MAX_CHARS),
    }, deps);
    if (previousRound + 1 >= task.maxRounds) {
      finishTask(id, "failed", error, deps);
    } else {
      touchAutofixTask(id, { status: "queued", pid: null }, agentDir);
      emitAutofixEvent({ type: "task_changed", taskId: id, status: "queued" });
    }
    return;
  }

  const sessionId = task.sessionId;
  if (sessionId) {
    const existing = getOutageRecord(sessionId, agentDir);
    let expired = false;
    if (existing?.status === "waiting") {
      const advanced = advanceOutageBudget(existing, now);
      expired = advanced.expired;
      updateOutageRecord(sessionId, () => ({
        ...advanced.record,
        reason: tailOf(error, AUTOFIX_ERROR_MAX_CHARS),
        lastAttemptAt: now,
        lastError: null,
      }), agentDir);
    } else {
      // 没有等待中的记录（首次挂起，或旧记录已结束）：新建一条。
      // 会话文件不在任务里；runner 按 sessionId 重开，不需要 sessionFile。
      createOutageRecord({
        sessionId,
        kind,
        reason: tailOf(error, AUTOFIX_ERROR_MAX_CHARS),
        scope: "autofix",
        // autofix 的重试由本 sweep 驱动，不经过通用探针；origin 留空。
        origin: { provider: null, modelId: null },
        resume: { mode: "followup", note: "Autofix round interrupted by a provider outage." },
        budget: initialOutageBudget({
          kind,
          now,
          maxWaitMs,
          maxAttempts: OUTAGE_DEFAULT_MAX_ATTEMPTS,
        }),
        guard: {},
        pid: process.pid,
        now,
      }, agentDir);
    }
    if (expired) {
      finishOutageRecord(sessionId, "expired", now, { lastError: tailOf(error, AUTOFIX_ERROR_MAX_CHARS) }, agentDir);
      finishTask(id, "failed", `Provider unavailable for too long: ${error}`, deps);
      return;
    }
  }

  touchAutofixTask(id, {
    status: "waiting-provider",
    round: previousRound,
    pid: null,
    lastError: tailOf(error, AUTOFIX_ERROR_MAX_CHARS),
  }, agentDir);
  emitAutofixEvent({ type: "task_changed", taskId: id, status: "waiting-provider" });
}

/** 一轮成功跑通 ⇒ 上游已恢复：挂起记录收口为 resumed（不删除，保留排障轨迹）。 */
function finishRunOutageRecord(sessionId: string, agentDir: string | undefined): void {
  const record = getOutageRecord(sessionId, agentDir);
  if (record?.status !== "waiting") return;
  finishOutageRecord(sessionId, "resumed", Date.now(), {}, agentDir);
}

/**
 * 发一轮 prompt 并等这一回合结束。
 *
 * 结束判据：`prompt_done`（SDK 在回合彻底结束后发；含 retry/续跑管线）。
 * 阻断型扩展对话框（confirm/select/input/editor/custom）在无人值守时没人回答，
 * 直接判 attention 并中止，避免每轮都干等到超时。
 */
function runAgentTurn(
  session: AutofixSessionLike,
  prompt: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve) => {
    let settled = false;
    let lastAssistant: Record<string, unknown> | undefined;
    let promptError: string | undefined;
    let unsubscribe: () => void = () => {};
    // 可写持有者：timer / onAbort 在事件接线之后才赋值，又要在 settle 里清理。
    const cleanup: { timer?: ReturnType<typeof setTimeout>; onAbort?: () => void } = {};

    const settle = (outcome: TurnOutcome): void => {
      if (settled) return;
      settled = true;
      if (cleanup.timer) clearTimeout(cleanup.timer);
      if (cleanup.onAbort) options.signal?.removeEventListener("abort", cleanup.onAbort);
      unsubscribe();
      resolve(outcome);
    };

    const abortRun = (): void => {
      void session.send({ type: "abort" }).catch(() => undefined);
    };

    unsubscribe = session.onEvent((event) => {
      if (event.type === "extension_ui_request") {
        const request = event as unknown as ExtensionUiRequest;
        if (isBlockingExtensionUiRequest(request)) {
          abortRun();
          settle({
            kind: "attention",
            error: `The agent is waiting for an answer to a "${(request as BlockingExtensionUiRequest).method}" dialog; open the session to continue`,
          });
        }
        return;
      }
      if (event.type === "message_end") {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role === "assistant") lastAssistant = message;
        return;
      }
      if (event.type === "prompt_error") {
        promptError = typeof event.errorMessage === "string" ? event.errorMessage : "Prompt failed";
        return;
      }
      if (event.type !== "prompt_done") return;
      if (promptError) {
        settle({ kind: "error", error: promptError });
        return;
      }
      const stopReason = lastAssistant?.stopReason;
      if (stopReason === "error") {
        settle({
          kind: "error",
          error: typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : "Model request failed",
        });
        return;
      }
      if (stopReason === "aborted") {
        settle({ kind: "aborted" });
        return;
      }
      settle({ kind: "ok" });
    });
    // onEvent 会同步回放 pending 事件（可能在我们拿到退订函数之前就 settle 了）。
    if (settled) {
      unsubscribe();
      return;
    }

    if (options.signal?.aborted) {
      settle({ kind: "aborted" });
      return;
    }
    cleanup.onAbort = () => {
      abortRun();
      settle({ kind: "aborted" });
    };
    options.signal?.addEventListener("abort", cleanup.onAbort, { once: true });

    cleanup.timer = setTimeout(() => {
      abortRun();
      settle({ kind: "timeout" });
    }, options.timeoutMs);
    cleanup.timer.unref?.();

    void Promise.resolve()
      .then(() => session.send({ type: "prompt", message: prompt }))
      .catch((error) => settle({ kind: "error", error: errorText(error) }));
  });
}

// ───────────────────────────── 保活接续（t4 约定出口） ─────────────────────────────

export interface ResumeAutofixOptions {
  staleMs?: number;
  now?: number;
  agentDir?: string;
}

/**
 * 扫全量任务，把「活跃 + 孤儿」的重新驱动。**不抛错、幂等**（保活 tick 直接调用）：
 * - 孤儿判定见 `isAutofixTaskResumable`（pid 活着 ⇒ 永不判孤儿）；
 * - 已在本进程驱动中的任务跳过；
 * - 并发上限 MAX_CONCURRENT_DRIVERS：一次最多启动一个，其余保持 queued，
 *   下一次 tick 再继续（queued 永远视为可接续）。
 */
export async function resumeAutofixTasks(
  options: ResumeAutofixOptions = {},
): Promise<{ examined: number; resumed: string[] }> {
  const resumed: string[] = [];
  let examined = 0;
  try {
    const now = options.now ?? Date.now();
    const tasks = listAutofixTasks(options.agentDir);
    examined = tasks.length;
    for (const task of tasks) {
      if (isAutofixTaskDriving(task.id)) continue;
      // Provider 中断挂起：重试时机由 outage 记录决定（退避/死线），不是 pid/staleness。
      if (task.status === "waiting-provider") {
        const record = task.sessionId ? getOutageRecord(task.sessionId, options.agentDir) : undefined;
        if (!record) {
          // 记录被删（用户取消等待）：按失败收口，不静默重跑。
          finishTaskInSweep(task.id, "failed", task.lastError ?? "Provider outage record was removed", now, options.agentDir);
          continue;
        }
        if (record.status !== "waiting" || isOutageExpired(record, now)) {
          if (record.status === "waiting" && task.sessionId) {
            finishOutageRecord(task.sessionId, "expired", now, {}, options.agentDir);
          }
          finishTaskInSweep(task.id, "failed", task.lastError ?? "Provider unavailable for too long", now, options.agentDir);
          continue;
        }
        if (!isOutageDue(record, now)) continue; // 退避未到
        const requeuedWaiting = touchAutofixTask(task.id, { status: "queued", pid: null }, options.agentDir);
        if (!requeuedWaiting) continue;
        resumed.push(task.id);
        emitAutofixEvent({ type: "task_changed", taskId: task.id, status: "queued" });
        continue;
      }
      if (!isAutofixTaskResumable(task, { now, staleMs: options.staleMs, isPidAlive })) continue;
      // 释放旧 owner，排队等驱动（queued 是无主状态，任何 tick 都可接）。
      const requeued = touchAutofixTask(task.id, { status: "queued", pid: null }, options.agentDir);
      if (!requeued) continue;
      resumed.push(task.id);
      emitAutofixEvent({ type: "task_changed", taskId: task.id, status: "queued" });
    }
    if (resumed.length > 0 && activeAutofixDriverCount() < MAX_CONCURRENT_DRIVERS) {
      // listAutofixTasks 最新在前：接最老的那个（先来先修）。
      const next = resumed[resumed.length - 1];
      void startAutofixTask(next, { agentDir: options.agentDir });
    }
  } catch (error) {
    console.error("[autofix] resume failed:", error instanceof Error ? error.message : error);
  }
  return { examined, resumed };
}

/** sweep 专用的终态收口（不持有 AutofixDeps；只落盘 + 广播）。 */
function finishTaskInSweep(
  id: string,
  status: AutofixStatus,
  lastError: string | null,
  now: number,
  agentDir: string | undefined,
): void {
  touchAutofixTask(id, {
    status,
    pid: null,
    finishedAt: now,
    ...(lastError ? { lastError: tailOf(lastError, AUTOFIX_ERROR_MAX_CHARS) } : {}),
  }, agentDir);
  emitAutofixEvent({ type: "task_changed", taskId: id, status });
}

/** 只读汇总（保活状态展示 / 列表页 badge）。不抛错。 */export async function summarizeAutofixTasks(
  options: { now?: number; staleMs?: number; agentDir?: string } = {},
): Promise<AutofixSummary> {
  try {
    return summarizeAutofixTaskList(listAutofixTasks(options.agentDir), {
      now: options.now ?? Date.now(),
      staleMs: options.staleMs,
      isPidAlive,
    });
  } catch {
    return { total: 0, active: 0, stuck: 0, succeeded: 0, failed: 0 };
  }
}

const SWEEP_KEY = Symbol.for("pi-web:autofix-sweep");

/**
 * 进程级接续循环（instrumentation 启动）：启动立刻扫一次，之后每 tick 一次。
 * 幂等（globalThis 记账）；`PI_WEB_DISABLE_SCHEDULER=1` 时由调用方不启动。
 */
export function startAutofixSweepLoop(options: { tickMs?: number } = {}): void {
  const holder = globalThis as unknown as Record<symbol, { timer: ReturnType<typeof setInterval> } | undefined>;
  if (holder[SWEEP_KEY]) return;
  const tickMs = options.tickMs ?? 60_000;
  let sweeping = false;
  const sweep = (): void => {
    if (sweeping) return;
    sweeping = true;
    void resumeAutofixTasks()
      .catch((error) => console.error("[autofix] sweep failed:", error instanceof Error ? error.message : error))
      .finally(() => {
        sweeping = false;
      });
  };
  sweep();
  const timer = setInterval(sweep, tickMs);
  timer.unref?.();
  holder[SWEEP_KEY] = { timer };
}

// ───────────────────────────── 生产依赖 ─────────────────────────────

/** 组装生产 deps（rpc-manager 惰性 import，保持启动路径轻）。 */
export function createLiveAutofixDeps(overrides: Partial<AutofixDeps> = {}): AutofixDeps {
  return {
    now: () => Date.now(),
    isPidAlive,
    async openSession(task) {
      return openLiveAutofixSession(task);
    },
    runVerify(command, cwd, options) {
      return runVerifyCommand(command, cwd, { timeoutMs: options.timeoutMs });
    },
    ...overrides,
  };
}

/**
 * 打开修复会话：已有 sessionId 且进程内存活 → 直接用；有会话文件 → 按 id 重开
 * （对话上下文继续）；都没有 → 新建。新建时钉工具集 + 写标记条目 + 命名会话。
 */
async function openLiveAutofixSession(task: AutofixTask): Promise<OpenedAutofixSession> {
  const [{ getRpcSession, startRpcSession }, { resolveSessionPath, invalidateSessionListCache }, { allowFileRoot }] =
    await Promise.all([
      import("../rpc-manager"),
      import("../session-reader"),
      import("../file-access"),
    ]);
  const toolNames = [...AUTOFIX_TOOL_NAMES];

  if (task.sessionId) {
    const existing = getRpcSession(task.sessionId);
    if (existing?.isAlive()) {
      return { session: existing as unknown as AutofixSessionLike, sessionId: task.sessionId, created: false };
    }
    const filePath = await resolveSessionPath(task.sessionId);
    if (filePath) {
      // 无人值守：没人能点确认，命令审批一律跳过（见 RpcSessionStartOptions.skipToolApproval）。
      const { session } = await startRpcSession(task.sessionId, filePath, undefined, {
        toolNames,
        skipToolApproval: true,
      });
      return { session: session as unknown as AutofixSessionLike, sessionId: task.sessionId, created: false };
    }
  }

  const { session, realSessionId } = await startRpcSession(
    `__autofix__${randomUUID()}`,
    "",
    task.cwd,
    { toolNames, allowInitialModelFallback: true, skipToolApproval: true },
  );
  allowFileRoot(task.cwd);
  invalidateSessionListCache();
  try {
    session.inner?.sessionManager?.appendCustomEntry?.(AUTOFIX_ENTRY_TYPE, {
      version: 1,
      taskId: task.id,
      task: task.task,
      verifyCommand: task.verifyCommand,
    });
    await session.send({ type: "set_session_name", name: autofixSessionName(task.task) });
  } catch {
    // 命名/标记失败只损失可读性，不影响修复循环。
  }
  return { session: session as unknown as AutofixSessionLike, sessionId: realSessionId, created: true };
}
