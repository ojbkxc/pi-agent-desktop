import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * workflow 沙箱的**静态闸**（`vm` 挡不住原型链）。
 *
 * 实测（探针，已删）：裸 `process` / `require` / `fetch` 在 vm 上下文里都是 `undefined`，
 * 但 `agent.constructor.constructor("return process")()` 能拿到宿主 `process`，进而
 * `process.getBuiltinModule("node:fs")` 读到了 `package.json`、`process.env` 读到 56 个
 * 环境变量。根因是设计性的：钩子是**宿主函数**，它的 `constructor.constructor` 就是宿主
 * realm 的 `Function` —— `vm` 只隔离全局对象，不隔离原型链。
 *
 * 所以把「写出那条链的手段」挡在编译之前：没有 `constructor` / `__proto__` /
 * `globalThis` / `Function(` / `eval(` / 动态 `import(` / `require(` / `process`，
 * 就没有从钩子爬到宿主的桥。
 *
 * 边界：这是**收窄**不是隔离。真要跑不可信代码得换子进程 + 权限降级。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { runWorkflowScript } = await jiti.import("./sandbox.ts");

const hooks = {
  agent: async (prompt) => ({ prompt }),
  parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
  // 与真实现同语义的最小版：每个 item 独立穿过所有 stage（无栅栏）。
  pipeline: async (items, ...stages) => Promise.all(items.map(async (item) => {
    let acc = item;
    for (const stage of stages) acc = await stage(acc);
    return acc;
  })),
  phase: () => {},
  log: () => {},
};
const limits = { maxConcurrent: 8, maxAgents: 64 };

const run = (script) => runWorkflowScript({ script, hooks, timeoutMs: 5_000, limits });

test("the classic vm escape is refused before it can run", async () => {
  // 逐字是探针里真的读到 package.json 的那一条。
  await assert.rejects(
    run('const p = agent.constructor.constructor("return process")(); return p.version'),
    (error) => error?.code === "unsafe-script" && /constructor/.test(error.message),
  );
});

test("every token that could bridge back to the host is refused", async () => {
  const bridges = [
    ["constructor", "a.constructor"],
    ["__proto__", "const x = {}.__proto__"],
    ["prototype", "Object.prototype"],
    ["globalThis", "globalThis"],
    ["Function(", 'Function("return 1")'],
    ["eval(", 'eval("1")'],
    ["import(", 'import("node:fs")'],
    ["require(", 'require("node:fs")'],
    ["process", "process.env"],
  ];
  for (const [token, snippet] of bridges) {
    await assert.rejects(
      run(`return ${snippet}`),
      (error) => error?.code === "unsafe-script",
      `\`${token}\` 必须被拒绝`,
    );
  }
});

test("a legitimate orchestration script still runs", async () => {
  // 静态闸不能把正常写法一起挡掉：钩子、await、模板串、数组方法都要能用。
  const value = await run(`
    phase("collect");
    const results = await parallel([
      () => agent("a"),
      () => agent("b"),
    ]);
    // pipeline(items, ...stages)：stage 从第二个参数起，每个 item 独立穿过。
    const mapped = await pipeline(results, async (prev) => prev, async (prev) => prev);
    log(\`got \${mapped.length}\`);
    return { count: mapped.length };
  `);
  assert.equal(value.count, 2);
});

test("the error names the token and tells the author what to use instead", async () => {
  await assert.rejects(
    run("return process.pid"),
    (error) => {
      assert.match(error.message, /`process`/);
      assert.match(error.message, /agent \/ parallel \/ pipeline \/ phase \/ log/);
      return true;
    },
  );
});
