/**
 * Workflow 的**脚本执行器**：把操作者写的脚本跑起来，并把它能用的一切限制在
 * `WorkflowHooks` 上。
 *
 * 用 `node:vm` 而不是裸 `eval`：裸 eval 连「上下文里有哪些自由变量」都不收窄。这里起一个
 * **只有钩子**的上下文：
 * - 不给 `require` / `process` / `Buffer` / 定时器；
 * - 不给 `import`（`vm.Script` 里没有模块加载器）；
 * - 只用 `runInContext` 跑一个 async 函数体，脚本拿到的自由变量只有拼进去的钩子。
 *
 * **边界（实测过，别再往好里写）**：`vm` 不是安全边界。
 * - 钩子是宿主函数，`agent.constructor.constructor("return process")()` 能拿到宿主
 *   `process` → `getBuiltinModule("node:fs")` 读文件、`process.env` 读凭据（56 个键）。
 *   下面的静态闸把**写出那条链的手段**挡在编译前，但拼串（`["constr","uctor"].join("")`）
 *   能绕过它。
 * - 纯微任务死循环（`while (true) { await null; }`）会饿死宿主事件循环，`vm` 的 `timeout`
 *   与外面的 `Promise.race` **同时失效**，进程不返回、不报错、不响应取消。
 *
 * 也测过「换 worker_threads」：worker 里照样有 `process` / `require`（等于没有隔离），
 * 它只解决第二个问题（`terminate()` 2ms 就能杀掉 spinning worker），却要把所有钩子改成
 * 异步消息协议——为一个「只用于可信脚本」的工具不值。
 *
 * 所以结论是**如实定位**：workflow 脚本是**可信输入**（和 Bash 工具同级），不是沙箱。
 * 真要跑不可信代码，得子进程 + 权限降级（`--experimental-permission` 之类），与本工具无关。
 */
import vm from "node:vm";
import * as acorn from "acorn";
import type { WorkflowHooks, WorkflowLimits } from "./types";
import { WorkflowError } from "./types";

/** 脚本最大长度：够写几百行的编排，又不至于把工具参数变成一份代码库。 */
export const MAX_WORKFLOW_SCRIPT_BYTES = 64 * 1024;

/**
 * 静态闸：把「写出『钩子 → 宿主』逃逸链所必须的语法形态」挡在编译之前。
 *
 * 为什么不查子串：bcd3ca2e 那版用 `script.includes(token)`——「`process`」就把
 * `processData` / `dataProcessing` 一起拒了，「`prototype`」把 `Object.prototype
 * .hasOwnProperty.call(...)` 这种**安全通行写法**也拒了。同时它**没**挡住
 * `["c","o","n","s","t","r","u","c","t","o","r"].join("")` —— 误伤与漏拦同时存在。
 *
 * 所以这里换 AST：acorn 解析后只盯**语法位置**，不再扫字符串。
 * - `MemberExpression` 的 property 名字命中危险名单（`constructor` / `__proto__` /
 *   `prototype`）→ 拒：这是逃逸链真正需要的形态；
 * - `Identifier` 命中（`globalThis` / `process`）→ 拒：是「拿到宿主」所需的入口名；
 * - `CallExpression` 的 callee 是 `Function` / `eval` / `require`、任何 `ImportExpression` → 拒；
 * - 字符串字面量、注释、模板串、对象字面量键、标识符**子串**（`processData`、
 *   `dataProcessing`、`myConstructor`）一律放过——它们不是逃逸面。
 *
 * 仍存在的**绕过面**（如实写，不再当「narrow but reliable」）：
 * - 计算属性 `obj["constr" + "uctor"]` / `obj[atob("...")]` 在静态下求不出最终属性名，
 *   这道闸对它们是盲的；
 * - 字符串拼接造标识符 `globalThis["pro" + "cess"]` 同理（不过 `globalThis` 本身已被拦）；
 * - `Reflect.get(obj, "constr" + "uctor")` 完全在 AST 黑名单视野之外；
 * - `Object.getPrototypeOf(fn).constructor` 等价于 `fn.constructor`，名字本身不在名单里。
 * 这些是这道闸的固有边界，与既有 docstring 的定位一致：**收窄**而非隔离，
 * 与 Bash 工具同级（可信输入），真要跑不可信代码必须换子进程 + 权限降级。
 *
 * 为什么 `prototype` 仍一刀切：`Object.prototype.hasOwnProperty.call(x, "k")` 是合法
 * 通行写法，但 `fn.prototype.constructor` 就是逃逸链——按 property 名字拒会一起拒前者。
 * 要更细，得做「这个 MemberExpression 的 object 静态上能否追到一个函数/类」的指向分析，
 * 不是几行 AST 巡检能承担的。当前选择是**宁可误伤 `Object.prototype.*` 也要把
 * `fn.prototype.constructor` 挡住**，并在工具描述里给出替代写法（`Object.hasOwn`，ES2022+）。
 */

/** 成员表达式上不许出现的 property 名字。 */
const FORBIDDEN_MEMBER_PROPERTIES: ReadonlyArray<{ name: string; why: string }> = [
  { name: "constructor", why: "原型链逃逸：hook.constructor.constructor 能拿到宿主 Function" },
  { name: "__proto__", why: "原型链逃逸" },
  { name: "prototype", why: "原型链逃逸（fn.prototype.constructor 即 Function）" },
];

/** 不许作为「自由变量标识符」或「调用 callee」出现的名字（读取就拒，无论是否调用）。 */
const FORBIDDEN_IDENTIFIER_NAMES: ReadonlyArray<{ name: string; why: string }> = [
  { name: "globalThis", why: "绕开「只给钩子」的上下文约定" },
  { name: "process", why: "宿主进程（env / getBuiltinModule）" },
  { name: "Function", why: "动态造函数 = 拿回完整的 JS" },
  { name: "eval", why: "动态执行任意字符串" },
  { name: "require", why: "模块加载" },
];

/**
 * 不许作为「直接调用的 callee」出现的名字（`fn(...)`，不含 `obj.fn(...)`）。
 * 保留这个独立名单是为让错误消息更准：`Function()` 比「不许读 `Function`」更直白。
 * 实际上由于上面把 `Function` / `eval` / `require` 加入了读取黑名单，
 * 这里的 callee 分支是**冗余兜底**：直接调用会先被 Identifier 分支拦下。
 */
const FORBIDDEN_CALL_CALLEES: ReadonlyArray<{ name: string; why: string }> = [];

interface AcornNode {
  type: string;
  computed?: boolean;
  property?: AcornNode;
  callee?: AcornNode;
  name?: string;
  value?: unknown;
  [key: string]: unknown;
}

/** 取 MemberExpression 的 property 静态名字；求不出（拼接/变量）就 null。 */
function memberPropertyName(node: AcornNode): string | null {
  if (!node.property) return null;
  if (node.computed) {
    // 计算属性只在 property 是字符串字面量时能静态看到名字。
    return node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : null;
  }
  return node.property.type === "Identifier" ? (node.property.name ?? null) : null;
}

/**
 * 浅递归 walk：acorn 不带 walker，自己写。只看语法位置，不求值。
 * 返回 [node, parent, parentKey]，让调用方能区分「读取位置」与「非读取位置」。
 */
function* walk(
  node: AcornNode | null | undefined,
  parent: AcornNode | null = null,
  parentKey: string | null = null,
): Generator<[AcornNode, AcornNode | null, string | null], void, unknown> {
  if (!node || typeof node !== "object") return;
  yield [node, parent, parentKey];
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof (child as AcornNode).type === "string") {
          yield* walk(child as AcornNode, node, key);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as AcornNode).type === "string") {
      yield* walk(value as AcornNode, node, key);
    }
  }
}

/**
 * 这个 Identifier 出现在「读这个名字」的位置上吗？
 * 不是读取位置的形态（这些 Identifier 与作用域解析无关，命中无意义）：
 * - `MemberExpression.property`（非 computed）——`obj.process` 读的是 obj 的属性
 * - `Property.key`（非 computed）——`{ process: 1 }` 声明的是键名
 * - `VariableDeclarator.id` / `FunctionDeclaration.id` / `FunctionExpression.id` /
 *   `ArrowFunctionExpression` / 函数 `params` / `ClassDeclaration.id` / `CatchClause.param` ——
 *   都是**绑定**而不是读取；在 vm 里 shadow `process` 没有任何逃逸收益
 * - `LabeledStatement.label` / `BreakStatement.label` / `ContinueStatement.label`
 * - `ImportSpecifier.imported` / `ExportSpecifier.exported` 等模块语法（脚本里也进不来）
 * - `MethodDefinition.key` / `PropertyDefinition.key`（非 computed）
 */
function isReadPosition(parent: AcornNode | null, parentKey: string | null): boolean {
  if (!parent || !parentKey) return true;
  if (parent.type === "MemberExpression" && parentKey === "property" && !parent.computed) return false;
  if ((parent.type === "Property" || parent.type === "PropertyDefinition" || parent.type === "MethodDefinition")
      && parentKey === "key" && !parent.computed) return false;
  if (parent.type === "VariableDeclarator" && parentKey === "id") return false;
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ClassDeclaration")
      && (parentKey === "id" || parentKey === "params")) return false;
  if (parent.type === "ArrowFunctionExpression" && parentKey === "params") return false;
  if (parent.type === "CatchClause" && parentKey === "param") return false;
  if ((parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")
      && parentKey === "label") return false;
  return true;
}

function unsafeMessage(name: string, why: string): string {
  return `Workflow script may not use \`${name}\` (${why}). Use the provided hooks: agent / parallel / pipeline / phase / log.`;
}

/**
 * 命中就抛 `unsafe-script`，并指出是哪个名字、为什么。
 * 只盯语法位置：字符串、注释、模板串、标识符子串（`processData`）都不会命中。
 */
function assertScriptIsSafe(script: string): void {
  // 与运行时一致地包成 async IIFE 再 parse；脚本是函数体，顶层 return 才合法。
  const wrapped = `(async () => {\n${script}\n})()`;
  let program: AcornNode;
  try {
    program = acorn.parse(wrapped, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AcornNode;
  } catch (error) {
    // 语法错沿用原来的 `syntax` code（vm 那条老路不再先到）。
    throw new WorkflowError("syntax", error instanceof Error ? error.message : String(error));
  }

  for (const [node, parent, parentKey] of walk(program)) {
    if (node.type === "MemberExpression") {
      const prop = memberPropertyName(node);
      if (prop) {
        const hit = FORBIDDEN_MEMBER_PROPERTIES.find((entry) => entry.name === prop);
        if (hit) throw new WorkflowError("unsafe-script", unsafeMessage(hit.name, hit.why));
      }
      continue;
    }
    if (node.type === "CallExpression") {
      // 只拦「直接调用」：`Function(...)` / `eval(...)` / `require(...)`。
      // `obj.eval(...)` 不是宿主入口，放行。
      if (node.callee?.type === "Identifier") {
        const callee = node.callee.name;
        const hit = FORBIDDEN_CALL_CALLEES.find((entry) => entry.name === callee);
        if (hit) throw new WorkflowError("unsafe-script", unsafeMessage(hit.name, hit.why));
      }
      continue;
    }
    if (node.type === "ImportExpression") {
      // 动态 import 一律拒（vm 里没模块加载器也仍是逃逸面）。
      throw new WorkflowError(
        "unsafe-script",
        unsafeMessage("import()", "动态导入没有模块加载器也仍是逃逸面"),
      );
    }
    if (node.type === "Identifier") {
      // 只拦「读取位置」的危险标识符。绑定位置（`const process = ...`）、成员名
      // （`obj.process`）、键名（`{ process: 1 }`）都放行——它们不读宿主入口。
      if (!isReadPosition(parent, parentKey)) continue;
      const name = node.name;
      if (!name) continue;
      const hit = FORBIDDEN_IDENTIFIER_NAMES.find((entry) => entry.name === name);
      if (hit) throw new WorkflowError("unsafe-script", unsafeMessage(hit.name, hit.why));
    }
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