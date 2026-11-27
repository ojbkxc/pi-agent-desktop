/**
 * Workflow 的**编排原语**：`agent` / `parallel` / `pipeline`，以及配额与事件。
 *
 * 三条语义刻意与 DeepSeek Harness 一致：
 * - `parallel` 是**栅栏**：全部结算才返回，**普通失败**的项变 `null`（不中止其它项）；
 *   取消 / 超时 / 配额这类**终局错误**不吞，向上抛给调用方（M2：否则 `aborted` 信号丢失）；
 * - `pipeline` **没有栅栏**：每个 item 自己穿过所有 stage，一项卡住不挡别人；终局错误同样上抛；
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

/**
 * 识别「终局」错误：取消 / 超时（以及底层同族的 limit）。这些**不是**「这一项失败」，
 * 是整条 workflow 已经停了——逐项吞成 `null` 会把 `aborted` 信号吃掉，调用方拿到的
 * 就是一个看似正常但全是 null 的结果，分辨不出「子任务都失败」与「被取消」。
 *
 * 与 DSH 的 `isFatalWorkflowError` 对齐：`CANCELLED` 是 fatal，组合子必须 re-throw 而不是
 * 把 item 归零。其它错误（业务失败、stage 抛错）依旧转 `null`，不挡同批其它项。
 *
 * 识别按 `name === "WorkflowError"` 而不是 `instanceof`：钩子与调用方可能来自不同
 * 模块实例（jiti 测试夹具 / 多处 import），`instanceof` 会静默失配。
 */
function isTerminalWorkflowError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const named = error as { name?: unknown; code?: unknown };
  if (named.name !== "WorkflowError" || typeof named.code !== "string") return false;
  return named.code === "aborted" || named.code === "timeout" || named.code === "limit";
}

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
 * `parallel` 的栅栏语义：全部结算再返回；**普通失败**（业务错、stage 抛错）变 `null`，
 * 不让一个失败吃掉整批；**终局信号**（`aborted` / `timeout` / `limit`）必须向上抛，
 * 否则调用方与 UI 拿到的全是 `null`，看不出「被停了」与「都失败了」的区别（M2）。
 *
 * 单独写成泛型函数（而不是对象字面量里的方法）：`WorkflowHooks` 的同名签名是泛型，
 * 字面量方法无法引用外层泛型，回调只能退化成 `unknown`。
 */
async function runParallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
  return Promise.all(
    thunks.map(async (thunk) => {
      try {
        return await thunk();
      } catch (error) {
        if (isTerminalWorkflowError(error)) throw error;
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
      // 名额必须**先原子占**再排队。旧实现把检查放在 `await semaphore.acquire()` 之前、
      // 自增放在之后：排队期间所有等待者读到的 `started` 都还是旧值，于是
      // `maxAgents=2, maxConcurrent=2, parallel(8)` 实测**起了 8 个**——总量预算被并发
      // 窗口整体绕过（典型 TOCTOU）。这里改成「检查 + 自增」在同一次同步执行内完成。
      if (started >= limits.maxAgents) {
        throw new WorkflowError(
          "limit",
          `Workflow reached its ${limits.maxAgents}-agent budget; split it into a script with fewer nodes`,
        );
      }
      const index = started;
      started += 1;

      try {
        await semaphore.acquire();
      } catch (error) {
        // 排队失败要把刚占的名额还回去，否则预算会被永久吃掉。
        started -= 1;
        throw error;
      }
      // 取消可能发生在排队期间：拿到名额后再看一次，否则「点停止之后又起了一个节点」。
      if (cancelled()) {
        started -= 1;
        semaphore.release();
        throw new WorkflowError("aborted", "Workflow was cancelled while the agent was queued");
      }
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
      //
      // 也**逐项容错**：某项的某个 stage 抛普通错只把那项变成 `null`，与 `parallel` 一致
      // （那边就是这么做的）。旧实现直接 `Promise.all`，一项失败整个 pipeline
      // reject，已经跑完的其它项成果一起丢掉——实测「item a failed」时 b 明明已经跑完了。
      //
      // 例外：**终局错误**（取消 / 超时 / 配额）必须向上抛，不能转 `null`——否则
      // `runWorkflow` 的 `aborted` 永远 false，UI 看到一堆 null 不知道是被停了还是全失败（M2）。
      return Promise.all(
        items.map(async (item, index) => {
          let previous: unknown = item;
          try {
            for (const stage of stages) {
              previous = await stage(previous, item, index);
            }
            return previous;
          } catch (error) {
            if (isTerminalWorkflowError(error)) throw error;
            // 失败不抛出，但要让调用方能看出是哪一项坏了：记一条带下标的日志。
            // 具体错误信息由 stage 自己负责（它比这里更清楚上下文）。
            const message = error instanceof Error ? error.message : String(error);
            logs.push(`pipeline item ${index} failed: ${message}`);
            return null;
          }
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