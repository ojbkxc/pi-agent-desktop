/**
 * Workflow 的执行入口：把脚本、编排原语、沙箱和结果串成一次运行。
 *
 * 分工很清楚——`hooks.ts` 管「并行/串行/配额」，`sandbox.ts` 管「脚本碰到什么」，
 * 这里只负责三件事：拼限额、跑脚本、把过程中发生的事整理成 `WorkflowResult`。
 */
import { createWorkflowHooks } from "./hooks";
import { runWorkflowScript } from "./sandbox";
import {
  WORKFLOW_DEFAULT_LIMITS,
  WorkflowError,
  type WorkflowEvent,
  type WorkflowLimits,
  type WorkflowResult,
  type WorkflowRunOptions,
} from "./types";

/** 跨模块实例也成立的错误识别（`instanceof` 在双份类上会静默失配）。 */
function isWorkflowError(error: unknown): error is WorkflowError {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { name?: unknown }).name === "WorkflowError"
    && typeof (error as { code?: unknown }).code === "string",
  );
}

/** 限额归一到合法区间：调用方（工具参数）可能给出越界值。 */
export function normalizeWorkflowLimits(input?: Partial<WorkflowLimits>): WorkflowLimits {
  const positive = (value: unknown, fallback: number, max: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    const rounded = Math.floor(value);
    if (rounded < 1) return fallback;
    return Math.min(rounded, max);
  };
  return {
    maxConcurrent: positive(input?.maxConcurrent, WORKFLOW_DEFAULT_LIMITS.maxConcurrent, 32),
    maxAgents: positive(input?.maxAgents, WORKFLOW_DEFAULT_LIMITS.maxAgents, 512),
    timeoutMs: positive(input?.timeoutMs, WORKFLOW_DEFAULT_LIMITS.timeoutMs, 6 * 60 * 60_000),
  };
}

export async function runWorkflow(options: WorkflowRunOptions): Promise<WorkflowResult> {
  const limits = normalizeWorkflowLimits(options.limits);
  const startedAt = Date.now();
  const events: WorkflowEvent[] = [];
  const emit = (event: WorkflowEvent): void => {
    events.push(event);
    options.onEvent?.(event);
  };

  // 内部取消通道：超时时由沙箱的回调 abort 它，钩子据此拒绝新节点、并通过 signal 把
  // 已经在跑的子 Agent 停掉。只靠 `Promise.race` 的话，返回之后脚本还会接着起节点。
  const budgetController = new AbortController();
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, budgetController.signal])
    : budgetController.signal;

  const handle = createWorkflowHooks({
    parentContext: options.parentContext,
    runtime: options.runtime,
    limits,
    onEvent: emit,
    signal: combinedSignal,
  });

  let value: unknown;
  let aborted = false;
  try {
    value = await runWorkflowScript({
      script: options.script,
      hooks: handle.hooks,
      timeoutMs: limits.timeoutMs,
      limits,
      // 超时 = 取消：先把钩子和在跑的子 Agent 停掉，再让 race 抛。
      onTimeout: () => budgetController.abort(new Error("workflow budget exceeded")),
    });
  } catch (error) {
    // 取消与超时是「事情没做完」，不是脚本写错：带上已经跑出来的部分结果一起返回，
    // 调用方才能报告「跑了 N 个节点后被停」。
    // 按 name 认（不用 instanceof）：钩子/沙箱可能来自不同模块实例，那时 instanceof 会失配。
    const code = isWorkflowError(error) ? error.code : null;
    if (code === "aborted" || code === "timeout") {
      aborted = true;
      value = null;
    } else {
      throw error;
    }
  } finally {
    // 正常返回也要收尾：脚本可能留下了还在跑的后台节点（它自己 return 了，节点没结束）。
    if (!budgetController.signal.aborted) budgetController.abort(new Error("workflow finished"));
  }

  return {
    value,
    agents: handle.startedAgents(),
    results: handle.results,
    aborted,
    phases: handle.phases,
    logs: handle.logs,
    elapsedMs: Date.now() - startedAt,
  };
}