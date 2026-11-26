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

/**
 * 脚本里**不许出现**的标识符。
 *
 * 为什么需要这道静态闸：`vm` 不是安全边界，而钩子函数本身是**宿主函数**——
 * `agent.constructor.constructor("return process")()` 就能拿到宿主的 `process`，进而
 * `process.getBuiltinModule("node:fs")` 读任意文件、`process.env` 读凭据。实测（探针）：
 * 裸 `process` / `require` / `fetch` 都是 `undefined`，但上面那条链能读到 `package.json`
 * 与 56 个环境变量。
 *
 * 真正的隔离要靠「脚本跑不出原型链」，而 `vm` 做不到（同一堆、同一 realm 的 Function）。
 * 所以这里把**写出那条链的手段**挡在编译之前：没有 `constructor` / `__proto__` /
 * `globalThis` / `Function(` / `eval(` / 动态 `import(`，就没有从钩子爬到宿主的桥。
 *
 * 边界要说清：这是**收窄**不是隔离——它挡的是「模型顺手读个文件」，配合 worktree 与会话
 * 隔离使用。真要跑不可信代码，必须换子进程 + 权限降级，不是加固这个列表。
 */
const FORBIDDEN_SCRIPT_TOKENS: ReadonlyArray<{ token: string; why: string }> = [
  { token: "constructor", why: "原型链逃逸：hook.constructor.constructor 能拿到宿主 Function" },
  { token: "__proto__", why: "原型链逃逸" },
  { token: "prototype", why: "原型链逃逸" },
  { token: "globalThis", why: "绕开「只给钩子」的上下文约定" },
  { token: "Function(", why: "动态造函数 = 拿回完整的 JS" },
  { token: "eval(", why: "同上" },
  { token: "import(", why: "动态导入没有模块加载器也仍是逃逸面" },
  { token: "require(", why: "模块加载" },
  { token: "process", why: "宿主进程（env / getBuiltinModule）" },
];

/** 命中就抛 `unsafe-script`，并指出是哪个词、为什么。 */
function assertScriptIsSafe(script: string): void {
  for (const { token, why } of FORBIDDEN_SCRIPT_TOKENS) {
    if (!script.includes(token)) continue;
    throw new WorkflowError(
      "unsafe-script",
      `Workflow script may not contain \`${token}\` (${why}). Use the provided hooks: agent / parallel / pipeline / phase / log.`,
    );
  }
}

export interface RunSandboxOptions {
  script: string;
  hooks: WorkflowHooks;
  /** 脚本整体超时（毫秒）：沙箱里的死循环不能把进程拖住。 */
  timeoutMs: number;
  limits: WorkflowLimits;
  /**
   * 超时那一刻的回调。
   *
   * 为什么必须有：`Promise.race` 只表示「我们不再等了」，**脚本本身还在跑**，它接着还能
   * `agent()` 起新节点、写日志——实测预算 150ms 时，返回后 700ms 又起了一个、`logs` 也被
   * 追加。所以调用方要在这里 abort 一个 controller，让钩子把它们真的停掉。
   */
  onTimeout?: () => void;
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

  // 编译前先过静态闸：`vm` 挡不住原型链，那就别让它写出那条链。
  assertScriptIsSafe(script);

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
      () => {
        // 先让调用方把钩子与已起的子 Agent 停掉，再拒绝。顺序反了的话，脚本会在我们
        // 抛出之后继续跑一段（它拿到的每个 `agent()` 都还没被 abort）。
        try {
          options.onTimeout?.();
        } catch {
          // 取消钩子自己出错不能顶掉超时这个真原因。
        }
        reject(new WorkflowError("timeout", `Workflow exceeded its ${Math.round(options.timeoutMs / 1000)}s budget`));
      },
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