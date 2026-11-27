import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Workflow 沙箱：脚本只能碰钩子，碰不到宿主。
 *
 * 这条测试的立场是「脚本是模型写的」——它必须**无法**读到文件、起进程、发请求。
 * `vm` 不是安全边界（同进程同堆），但它把可达面从「整个 Node」收窄到「显式传进去的
 * 对象」，这条足以挡住「模型顺手读个 env / 发个请求」。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { runWorkflowScript } = await jiti.import("./sandbox.ts");
const { createWorkflowHooks } = await jiti.import("./hooks.ts");
const { normalizeWorkflowLimits, runWorkflow } = await jiti.import("./run.ts");

const LIMITS = normalizeWorkflowLimits({ maxConcurrent: 4, maxAgents: 8, timeoutMs: 5_000 });

function hooksFor(agentImpl, ctx = {}) {
  return createWorkflowHooks({
    parentContext: ctx,
    runtime: { start: agentImpl },
    limits: LIMITS,
  });
}

const fakeRun = (text) => ({
  run: { sessionId: "s1", status: "completed", profile: "general-purpose", description: "d", runInBackground: false, result: text },
  completion: Promise.resolve({ sessionId: "s1", status: "completed", profile: "general-purpose", description: "d", runInBackground: false, result: text }),
});

test("the sandbox exposes the hooks and nothing else", async () => {
  const handle = hooksFor(async () => fakeRun("ok"));
  // `process` / `globalThis` / `Function` / `eval` / `require` 现在是**静态闸**按 AST 读取
  // 位置拦的标识符（`vm` 挡不住原型链，只能不让脚本写出那条链），所以「宿主入口拿不到」
  // 不再能靠运行时 `typeof` 探针证明——脚本根本编译不进 vm。逐条静态断言钉住这件事。
  for (const host of ["process", "require", "Function", "eval", "globalThis"]) {
    await assert.rejects(
      runWorkflowScript({
        script: `return typeof ${host}`,
        hooks: handle.hooks,
        timeoutMs: LIMITS.timeoutMs,
        limits: LIMITS,
      }),
      (error) => error?.code === "unsafe-script",
      `\`${host}\` 必须被静态闸拒绝`,
    );
  }

  // 剩下的非标识符入口（Buffer / fetch / 定时器 / console）仍可运行时探测：
  // 它们不在静态闸名单里，但 vm 上下文里也没绑定，应返回 'undefined'。
  const probe = await runWorkflowScript({
    script: `
      return {
        hasBuffer: typeof Buffer,
        hasFetch: typeof fetch,
        hasSetTimeout: typeof setTimeout,
        hasConsole: typeof console,
        hasAgent: typeof agent,
        hasParallel: typeof parallel,
        hasPipeline: typeof pipeline,
      };
    `,
    hooks: handle.hooks,
    timeoutMs: LIMITS.timeoutMs,
    limits: LIMITS,
  });
  assert.equal(probe.hasAgent, "function");
  assert.equal(probe.hasParallel, "function");
  assert.equal(probe.hasPipeline, "function");
  for (const key of ["hasBuffer", "hasFetch", "hasSetTimeout", "hasConsole"]) {
    assert.equal(probe[key], "undefined", `${key}: the script must not reach the host`);
  }
});

test("an empty script is refused instead of running nothing", async () => {
  const handle = hooksFor(async () => fakeRun("ok"));
  await assert.rejects(
    () => runWorkflowScript({ script: "   ", hooks: handle.hooks, timeoutMs: 1_000, limits: LIMITS }),
    /empty/i,
  );
});

test("a syntax error comes back as a WorkflowError, not a host stack", async () => {
  const handle = hooksFor(async () => fakeRun("ok"));
  await assert.rejects(
    () => runWorkflowScript({ script: "return (((;", hooks: handle.hooks, timeoutMs: 1_000, limits: LIMITS }),
    (error) => error.name === "WorkflowError" && error.code === "syntax",
  );
});

test("agent() gets the prompt and hands back the subagent's text", async () => {
  const seen = [];
  const handle = hooksFor(async (request) => {
    seen.push(request);
    return fakeRun(`echo:${request.task}`);
  });
  const out = await runWorkflowScript({
    script: `return await agent("hello", { description: "greet" });`,
    hooks: handle.hooks,
    timeoutMs: LIMITS.timeoutMs,
    limits: LIMITS,
  });
  assert.equal(out, "echo:hello");
  assert.equal(seen[0].task, "hello");
  assert.equal(seen[0].description, "greet");
  assert.equal(seen[0].runInBackground, false, "workflow nodes are awaited, never backgrounded");
  assert.equal(seen[0].inheritContext, undefined, "no parent context by default");
});

test("parallel is a barrier and turns a throw into null", async () => {
  const handle = hooksFor(async (request) => fakeRun(request.task));
  const out = await runWorkflowScript({
    script: `
      const results = await parallel([
        () => agent("a"),
        () => { throw new Error("boom"); },
        () => agent("c"),
      ]);
      return results;
    `,
    hooks: handle.hooks,
    timeoutMs: LIMITS.timeoutMs,
    limits: LIMITS,
  });
  assert.deepEqual(out, ["a", null, "c"], "one failure must not eat the batch");
});

// M2 回归：parallel 的逐项 catch 曾把 `WorkflowError("aborted")` 一并吞成 null，runWorkflow
// 因此 `aborted=false`、UI 拿到一堆 null 分辨不出「被停了」与「都失败了」。
// 现在：终局错误必须向上抛，由 runWorkflow 标成 aborted=true（与 DSH isFatalWorkflowError 对齐）。

test("parallel re-throws an abort WorkflowError instead of nulling it (M2)", async () => {
  const controller = new AbortController();
  const handle = createWorkflowHooks({
    parentContext: {},
    runtime: { start: async () => fakeRun("ok") },
    limits: LIMITS,
    signal: controller.signal,
  });
  controller.abort(new Error("user stop"));
  await assert.rejects(
    handle.hooks.parallel([
      () => handle.hooks.agent("n0"),
      () => handle.hooks.agent("n1"),
    ]),
    (error) => error?.name === "WorkflowError" && error?.code === "aborted",
    "取消信号触发的 WorkflowError 必须上抛，不能吞成 null",
  );
});

test("runWorkflow surfaces abort as aborted=true when parallel propagates it (M2)", async () => {
  const controller = new AbortController();
  const run = runWorkflow({
    script: `return await parallel([() => agent("a"), () => agent("b")]);`,
    parentContext: {},
    runtime: { start: async () => fakeRun("ok") },
    limits: { timeoutMs: 5_000, maxConcurrent: 8, maxAgents: 64 },
    signal: controller.signal,
  });
  // 在 agent() 起跑前就把信号打掉：hooks 的 cancelled() 会抛 WorkflowError("aborted")，
  // parallel 必须让它穿过逐项 catch 到达 runWorkflow。
  controller.abort(new Error("stop before start"));
  const result = await run;
  assert.equal(result.aborted, true, "parallel 传播的 aborted 必须让 runWorkflow 标 aborted=true");
  assert.equal(result.value, null, "aborted 时 value 为 null");
});

test("parallel still nulls an ordinary failure even when another item aborts (mixed batch)", async () => {
  const handle = createWorkflowHooks({
    parentContext: {},
    runtime: { start: async () => fakeRun("ok") },
    limits: LIMITS,
  });
  const abortError = new Error("cancelled");
  abortError.name = "WorkflowError";
  abortError.code = "aborted";
  // 普通失败那一项会先结算成 null；abort 那一项必须让 Promise.all reject。
  await assert.rejects(
    handle.hooks.parallel([
      async () => null,
      async () => {
        throw new Error("plain failure");
      },
      async () => {
        throw abortError;
      },
    ]),
    (error) => error === abortError,
    "同批中普通失败仍转 null 的承诺，不影响终局错误上抛",
  );
});

test("pipeline has no barrier: every item walks all stages", async () => {
  const order = [];
  const handle = hooksFor(async (request) => {
    order.push(request.task);
    return fakeRun(request.task);
  });
  const out = await runWorkflowScript({
    script: `
      return await pipeline([1, 2], async (prev) => await agent("s1:" + prev), async (prev, item) => await agent("s2:" + item));
    `,
    hooks: handle.hooks,
    timeoutMs: LIMITS.timeoutMs,
    limits: LIMITS,
  });
  assert.deepEqual(out, ["s2:1", "s2:2"]);
  assert.ok(order.includes("s1:1") && order.includes("s2:2"), "each item runs through both stages");
});

test("the agent budget stops a runaway script", async () => {
  const handle = hooksFor(async (request) => fakeRun(request.task));
  await assert.rejects(
    () => runWorkflowScript({
      script: `
        const out = [];
        for (let i = 0; i < 20; i += 1) out.push(await agent("n" + i));
        return out.length;
      `,
      hooks: handle.hooks,
      timeoutMs: LIMITS.timeoutMs,
      limits: LIMITS,
    }),
    (error) => error.name === "WorkflowError" && error.code === "limit",
  );
});

test("a hung workflow hits its wall clock budget", async () => {
  const handle = hooksFor(() => new Promise(() => {}));
  await assert.rejects(
    () => runWorkflowScript({
      script: `return await agent("never finishes");`,
      hooks: handle.hooks,
      timeoutMs: 150,
      limits: LIMITS,
    }),
    (error) => error.name === "WorkflowError" && error.code === "timeout",
  );
});

test("a failed subagent yields an empty string but is recorded", async () => {
  const handle = hooksFor(async () => ({
    run: { sessionId: "s9", status: "failed", profile: "general-purpose", description: "d", runInBackground: false, error: "boom" },
    completion: Promise.resolve({ sessionId: "s9", status: "failed", profile: "general-purpose", description: "d", runInBackground: false, error: "boom" }),
  }));
  const result = await runWorkflow({
    script: `return await agent("x", { description: "will fail" });`,
    parentContext: {},
    runtime: { start: async () => ({
      run: { sessionId: "s9", status: "failed", profile: "general-purpose", description: "d", runInBackground: false, error: "boom" },
      completion: Promise.resolve({ sessionId: "s9", status: "failed", profile: "general-purpose", description: "d", runInBackground: false, error: "boom" }),
    }) },
    limits: { timeoutMs: 2_000 },
  });
  assert.equal(result.value, "");
  assert.equal(result.agents, 1);
  assert.equal(result.results[0].text, null);
  assert.match(result.results[0].error ?? "", /failed/i);
});