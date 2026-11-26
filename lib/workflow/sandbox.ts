/**
 * Workflow 的**沙箱执行器**：只做一件事——把操作者写的脚本跑起来，并把它能用的一切
 * 限制在 `WorkflowHooks` 上。
 *
 * 为什么必须是沙箱而不是 `eval`：脚本内容是模型写的。直接在主进程 eval 等于把整个宿主
 * （fs、凭据、子进程）交给它。这里用 `node:vm` 起一个**只有钩子**的上下文：
 * - 不给 `require` / `process` / `Buffer` / 定时器；
 * - 不给 `import`（`vm.Script` 里没有模块加载器）；
 * - 只用 `runInContext` 跑一个 async 函数体，脚本拿到的自由变量只有拼进去的钩子。
 *
 * 逃逸面：`vm` 不是安全边界（同一进程、同一堆），但它把「脚本能碰到什么」从
 * 「整个 Node」收窄到「显式传进去的对象」。这条足以挡住「模型顺手读个文件/发个请求」，
 * 真正的隔离靠子 Agent 的 worktree 与会话隔离——分工在图里，执行在会话里。
 */
import vm from "node:vm";
import type { WorkflowHooks, WorkflowLimits } from "./types";
import { WorkflowError } from "./types";

/** 脚本最大长度：够写几百行的编排，又不至于把工具参数变成一份代码库。 */
export const MAX_WORKFLOW_SCRIPT_BYTES = 64 * 1024;

export interface RunSandboxOptions {
  script: string;
  hooks: WorkflowHooks;
  /** 脚本整体超时（毫秒）：沙箱里的死循环不能把进程拖住。 */
  timeoutMs: number;
  limits: WorkflowLimits;
}

/**
 * 跑脚本，返回它的 `return` 值。
 *
 * 脚本是**函数体**，不是表达式：允许 `const`、`for`、`await`，最后写 `return`。
 * 这样它读起来就是一段编排代码，而不是一个特技表达式。
 */
export async function runWorkflowScript(options: RunSandboxOptions): Promise<unknown> {
  const script = options.script;
  if (typeof script !== "string" || script.trim() === "") {
    throw new WorkflowError("no-script", "Workflow script is empty");
  }
  if (Buffer.byteLength(script, "utf8") > MAX_WORKFLOW_SCRIPT_BYTES) {
    throw new WorkflowError(
      "limit",
      `Workflow script is larger than ${MAX_WORKFLOW_SCRIPT_BYTES} bytes; move the bulk into the prompts`,
    );
  }

  // 包成 async IIFE：脚本里可以直接 `await`，`return` 值成为整个 workflow 的结果。
  const wrapped = `(async () => {\n${script}\n})()`;

  // 上下文里只放钩子 + 语言内建（JSON/Math/Date 之类由 vm 自带），不放宿主对象。
  // `console` 必须**显式抹掉**：`vm.createContext` 会自动注入一个 console，脚本一旦能用它
  // 就直接绕过了 workflow 的事件通道（进度、日志都进不了 UI）。要输出就用 `log()`。
  const context = vm.createContext(Object.freeze({
    agent: options.hooks.agent,
    parallel: options.hooks.parallel,
    pipeline: options.hooks.pipeline,
    phase: options.hooks.phase,
    log: options.hooks.log,
    console: undefined,
  }));

  let compiled: vm.Script;
  try {
    compiled = new vm.Script(wrapped, { filename: "workflow.js" });
  } catch (error) {
    throw new WorkflowError("syntax", error instanceof Error ? error.message : String(error));
  }

  // vm 的 `timeout` 只覆盖**同步**执行；脚本里 `await agent()` 会离开同步段，所以真正的
  // 墙钟上限由下面的 Promise.race 兜（它同时覆盖钩子内部的等待）。
  const execution = compiled.runInContext(context, { timeout: options.timeoutMs }) as Promise<unknown>;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WorkflowError("timeout", `Workflow exceeded its ${Math.round(options.timeoutMs / 1000)}s budget`)),
      options.timeoutMs,
    );
  });

  try {
    return await Promise.race([execution, timeout]);
  } catch (error) {
    // 按 **name** 认自己的错误，不用 `instanceof`：钩子与沙箱可能来自不同的模块实例
    // （测试夹具、多处 import 都会各拿一份类），`instanceof` 那时会静默失配，把一个
    // 明确的 `limit` / `aborted` 错误裹成 `runtime`，调用方就再也分不出「脚本写错」
    // 还是「配额用尽」。
    if (isWorkflowError(error)) throw error;
    throw new WorkflowError("runtime", error instanceof Error ? error.message : String(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 跨模块实例也成立的自识别。 */
function isWorkflowError(error: unknown): error is WorkflowError {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { name?: unknown }).name === "WorkflowError"
    && typeof (error as { code?: unknown }).code === "string",
  );
}