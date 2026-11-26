/**
 * Workflow 脚本编排：把「一批子 Agent 怎么分工」写成确定的 JS，而不是让模型临场决定。
 *
 * 形态对齐 DeepSeek Harness 的 workflow 钩子（同名同义），脚本里能用的只有这几个：
 * - `agent(prompt, opts?)` —— 跑一个子 Agent 并等它结束，返回它的最终文本；
 * - `parallel(thunks)` —— 并发跑一批，全部结算后返回数组（抛错的项变 `null`）；
 * - `pipeline(items, ...stages)` —— 每个 item 独立穿过所有 stage，**stage 之间没有栅栏**；
 * - `phase(title)` / `log(message)` —— 进度标记与日志。
 *
 * 为什么不让模型「自己看着办」：模型临场编排时，同一个任务两次跑出来的图不一样，
 * 没法回归也没法审。脚本是确定性的，同一个脚本 + 同样的输入 = 同样的执行图。
 *
 * 边界（与 DSH 一致）：脚本**没有** fs / 网络 / 定时器 / Node API。它能做的只有
 * 「描述分工」，真正干活的是子 Agent。这不是能力缩水，而是这张图的语义就是分工。
 */
import type { StartSubagentRequest, SubagentExecution } from "../subagent-extension";

/** 脚本里能拿到的钩子。注意：故意不含任何宿主能力（无 fs、无网络、无进程）。 */
export interface WorkflowHooks {
  agent(prompt: string, opts?: WorkflowAgentOptions): Promise<string>;
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  pipeline<T>(items: readonly T[], ...stages: Array<(prev: unknown, item: T, index: number) => unknown>): Promise<unknown[]>;
  phase(title: string): void;
  log(message: string): void;
}

export interface WorkflowAgentOptions {
  /** 子 Agent profile（默认 general-purpose，与 `Agent` 工具同义）。 */
  subagentType?: string;
  /** 覆盖模型（`provider/modelId`）。 */
  model?: string;
  /** 覆盖思考档位。 */
  thinking?: string;
  /** 这一个小任务的 UI 标签。 */
  description?: string;
  /** 每轮上限。 */
  maxTurns?: number;
  /**
   * 继承父会话的活动上下文。
   *
   * 默认 **false**：workflow 的价值就在于「每个节点只看自己那部分」，继承父上下文会让
   * 并行节点互相拖累上下文体积（也和 DSH 的子 Agent 默认隔离一致）。
   */
  inheritContext?: boolean;
  /** 在隔离的 git worktree 里跑（写盘任务用）。 */
  isolation?: "worktree";
}

export interface WorkflowLimits {
  /** 同时最多几个子 Agent 在跑（默认 8，上限 32）。 */
  maxConcurrent: number;
  /** 脚本最多能启动多少个子 Agent（默认 64）：防一个脚本刷出几百个会话。 */
  maxAgents: number;
  /** 整条 workflow 的墙钟上限（默认 30 分钟）。 */
  timeoutMs: number;
}

export const WORKFLOW_DEFAULT_LIMITS: WorkflowLimits = {
  maxConcurrent: 8,
  maxAgents: 64,
  timeoutMs: 30 * 60_000,
};

/** 交给编排器的最小运行时：从子 Agent 控制器里取，便于测试注入假实现。 */
export interface WorkflowAgentRuntime {
  start(request: StartSubagentRequest): Promise<SubagentExecution>;
}

export interface WorkflowRunOptions {
  script: string;
  /** 交给 `agent()` 的父上下文（pi 的 ExtensionContext）。 */
  parentContext: StartSubagentRequest["parentContext"];
  runtime: WorkflowAgentRuntime;
  limits?: Partial<WorkflowLimits>;
  /** 进度回调（phase / log / 每个 agent 的起止）。 */
  onEvent?: (event: WorkflowEvent) => void;
  /** 取消信号：中止后不再启动新的 agent，等已在跑的自然结束。 */
  signal?: AbortSignal;
}

export type WorkflowEvent =
  | { type: "phase"; title: string }
  | { type: "log"; message: string }
  | { type: "agent_start"; index: number; description: string }
  | { type: "agent_end"; index: number; description: string; ok: boolean };

export interface WorkflowResult {
  /** 脚本的返回值（建议返回一个可 JSON 化的摘要）。 */
  value: unknown;
  /** 实际启动的子 Agent 数。 */
  agents: number;
  /** 每个子 Agent 的结果（失败为 null）。 */
  results: Array<{ description: string; text: string | null; error?: string }>;
  /** 是否被取消 / 超时。 */
  aborted: boolean;
  phases: string[];
  logs: string[];
  elapsedMs: number;
}

/** workflow 编排过程中的可预期失败（脚本语法错、越界、超时），调用方转成工具错误。 */
export class WorkflowError extends Error {
  readonly code:
    | "syntax"
    | "runtime"
    | "limit"
    | "timeout"
    | "aborted"
    | "no-script"
    /**
     * 脚本里出现了会打通「钩子 → 宿主」的构造（`constructor` / `__proto__` / `globalThis`
     * / `Function(` / `eval(` / 动态 `import(` / `require(` / `process`）。
     * 单独一个 code 而不是复用 `limit`：这不是「跑太多」，是「想跑出去」，调用方与日志
     * 都该能分辨。
     */
    | "unsafe-script";
  constructor(code: WorkflowError["code"], message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}