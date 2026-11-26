/**
 * Workflow 的**编排原语**：`agent` / `parallel` / `pipeline`，以及配额与事件。
 *
 * 三条语义刻意与 DeepSeek Harness 一致：
 * - `parallel` 是**栅栏**：全部结算才返回，抛错的项变 `null`（不中止其它项）；
 * - `pipeline` **没有栅栏**：每个 item 自己穿过所有 stage，一项卡住不挡别人；
 * - `agent` 默认**不继承父上下文**：workflow 的价值是「每个节点只看自己那部分」。
 *
 * 另外两件事这里负责，脚本作者不用管：
 * - **并发闸**（`maxConcurrent`）：同时起的子 Agent 不超过它，多的排队；
 * - **总量闸**（`maxAgents`）：一个脚本最多起这么多个，防止刷出几百个会话。
 */
import type { SubagentRunInfo } from "../subagents";
import { subagentFinalText } from "../subagent-extension";
import type {
  WorkflowAgentOptions,
  WorkflowAgentRuntime,
  WorkflowEvent,
  WorkflowHooks,
  WorkflowLimits,
} from "./types";
import { WorkflowError } from "./types";

export interface CreateHooksOptions {
  parentContext: Parameters<WorkflowAgentRuntime["start"]>[0]["parentContext"];
  runtime: WorkflowAgentRuntime;
  limits: WorkflowLimits;
  onEvent?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
  /** 由沙箱注入的「脚本已结束」判断，用于停止发放新名额。 */
  isCancelled?: () => boolean;
}

export interface HooksHandle {
  hooks: WorkflowHooks;
  /** 每个子 Agent 的结果，按启动顺序。 */
  results: Array<{ description: string; text: string | null; error?: string }>;
  startedAgents: () => number;
  phases: string[];
  logs: string[];
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "aborted", "interrupted"]);

/** 极简信号量：`maxConcurrent` 个名额，先到先得。 */
function createSemaphore(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
      active += 1;
    },
    release(): void {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

/**
 * `parallel` 的栅栏语义：全部结算再返回；抛错变 `null`，不让一个失败吃掉整批。
 *
 * 单独写成泛型函数（而不是对象字面量里的方法）：`WorkflowHooks` 的同名签名是泛型，
 * 字面量方法无法引用外层泛型，回调只能退化成 `unknown`。
 */
async function runParallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
  return Promise.all(
    thunks.map(async (thunk) => {
      try {
        return await thunk();
      } catch {
        return null;
      }
    }),
  );
}

export function createWorkflowHooks(options: CreateHooksOptions): HooksHandle {
  const { limits, runtime, parentContext, onEvent, signal } = options;
  const semaphore = createSemaphore(Math.max(1, limits.maxConcurrent));
  const results: HooksHandle["results"] = [];
  const phases: string[] = [];
  const logs: string[] = [];
  let started = 0;

  const cancelled = (): boolean => Boolean(options.isCancelled?.() || signal?.aborted);

  const hooks: WorkflowHooks = {
    async agent(prompt, agentOptions) {
      if (cancelled()) throw new WorkflowError("aborted", "Workflow was cancelled before the agent started");
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new WorkflowError("runtime", "agent() needs a non-empty prompt");
      }
      if (started >= limits.maxAgents) {
        throw new WorkflowError(
          "limit",
          `Workflow reached its ${limits.maxAgents}-agent budget; split it into a script with fewer nodes`,
        );
      }

      await semaphore.acquire();
      const index = started;
      started += 1;
      const description = describeAgent(agentOptions, index);
      onEvent?.({ type: "agent_start", index, description });
      try {
        const execution = await runtime.start({
          parentContext,
          parentToolCallId: `workflow-${index}`,
          profile: agentOptions?.subagentType ?? "general-purpose",
          task: prompt,
          description,
          // 前台：workflow 的语义是「等这个节点出结果再往下走」。后台模式会把结果投递成
          // 一条 custom 消息，脚本拿不到，编排就没有意义了。
          runInBackground: false,
          ...(agentOptions?.model ? { model: agentOptions.model } : {}),
          ...(agentOptions?.thinking ? { thinking: agentOptions.thinking } : {}),
          ...(agentOptions?.maxTurns ? { maxTurns: agentOptions.maxTurns } : {}),
          ...(agentOptions?.inheritContext !== undefined ? { inheritContext: agentOptions.inheritContext } : {}),
          ...(agentOptions?.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
          ...(signal ? { signal } : {}),
        });

        const run = await execution.completion;
        const ok = run.status === "completed";
        results.push({
          description,
          text: ok ? (run.result?.trim() ?? "") : null,
          ...(ok ? {} : { error: subagentFinalText(run) }),
        });
        onEvent?.({ type: "agent_end", index, description, ok });
        if (!ok) {
          // 失败不抛出：脚本里 `parallel` 还要把其它项跑完，`pipeline` 也要让别的 item 继续。
          // 脚本可以自己检查返回值是不是空串来决定要不要放弃。
          return "";
        }
        return run.result?.trim() ?? "";
      } finally {
        semaphore.release();
      }
    },

    parallel: runParallel,

    async pipeline(items, ...stages) {
      if (!Array.isArray(items)) throw new WorkflowError("runtime", "pipeline() needs an array of items");
      // **没有栅栏**：每个 item 独立穿过所有 stage，一项慢不挡别人。
      return Promise.all(
        items.map(async (item, index) => {
          let previous: unknown = item;
          for (const stage of stages) {
            previous = await stage(previous, item, index);
          }
          return previous;
        }),
      );
    },

    phase(title) {
      const text = String(title ?? "").trim();
      if (!text) return;
      phases.push(text);
      onEvent?.({ type: "phase", title: text });
    },

    log(message) {
      const text = String(message ?? "");
      if (!text) return;
      logs.push(text);
      onEvent?.({ type: "log", message: text });
    },
  };

  return { hooks, results, startedAgents: () => started, phases, logs };
}

/** 子 Agent 的 UI 标签：优先用脚本给的，其次按序号编一个。 */
function describeAgent(options: WorkflowAgentOptions | undefined, index: number): string {
  const given = typeof options?.description === "string" ? options.description.trim() : "";
  return given || `workflow node ${index + 1}`;
}

/** 结果里只保留终态信息：脚本拿到的就是文本，这里给调用方一份可读的摘要。 */
export function describeRun(run: SubagentRunInfo): string {
  return TERMINAL.has(run.status) ? subagentFinalText(run) : `Subagent ${run.sessionId} is ${run.status}.`;
}