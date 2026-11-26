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
  // `process` 现在是**静态闸**的禁用词（`vm` 挡不住原型链，只能不让脚本写出那条链），
  // 所以这条用例的探针要先证明「静态闸会拒绝」，再用不含禁用词的形态确认其余宿主能力
  // 拿不到。两者合起来才是「只有钩子」。
  await assert.rejects(
    runWorkflowScript({
      script: "return typeof process",
      hooks: handle.hooks,
      timeoutMs: LIMITS.timeoutMs,
      limits: LIMITS,
    }),
    (error) => error?.code === "unsafe-script",
    "`process` 必须被静态闸拒绝",
  );

  const probe = await runWorkflowScript({
    script: `
      return {
        hasRequire: typeof require,
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
  // `typeof import` 在 vm 里是语法错误（`import` 是保留字），所以「模块加载」这条用
  // 「没有 require / Buffer / fetch / 定时器」来钉。
  for (const key of ["hasRequire", "hasBuffer", "hasFetch", "hasSetTimeout", "hasConsole"]) {
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