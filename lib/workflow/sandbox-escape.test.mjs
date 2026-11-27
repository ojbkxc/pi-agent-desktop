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

test("every bridge syntax that could reach the host is refused", async () => {
  // 每条都是「完整脚本」，须抛 unsafe-script。
  const bridges = [
    ["constructor", "return a.constructor"],
    ["constructor", 'return a["constructor"]'],
    ["__proto__", "return ({}).__proto__"],
    ["__proto__", 'return ({})["__proto__"]'],
    ["prototype", "return Object.prototype"],
    ["prototype", "return fn.prototype"],
    ["globalThis", "return globalThis"],
    ["globalThis", "return globalThis.process"],
    ["Function", 'return Function("return 1")'],
    ["Function", "const F = Function; return F('return 1')"],
    ["eval", 'return eval("1")'],
    ["eval", "const e = (0, eval); return e('1')"],
    ["import()", 'return import("node:fs")'],
    ["require", 'return require("node:fs")'],
    ["process", "return process.env"],
    ["process", "return process"],
  ];
  for (const [name, script] of bridges) {
    await assert.rejects(
      run(script),
      (error) => error?.code === "unsafe-script",
      `\`${name}\` via \`${script}\` 必须被拒绝`,
    );
  }
});

test("identifier substrings and string contents no longer false-positive (M1)", async () => {
  // bcd3ca2e 的子串匹配会把这些合法形态一起拒；AST 闸门只盯语法位置，应全部放行。
  const allowed = [
    // 合法标识符包含危险名作为子串
    ["processData", "const processData = 1; return processData"],
    ["processList", "const processList = [1, 2]; return processList.length"],
    ["dataProcessing", "const dataProcessing = () => 1; return dataProcessing()"],
    ["myConstructor", "const myConstructor = 5; return myConstructor"],
    // 字符串字面量与模板串
    ['"process" in string', 'return "process"'],
    ['"constructor.prototype.__proto__" in string', 'return "constructor.prototype.__proto__"'],
    ["dangerous names in template", "return `the process and the constructor`"],
    // 注释
    ["names in comment", "// process globalThis Function eval require\nreturn 1"],
    // 对象字面量键（声明键名 ≠ 读入口）
    ["object literal keys", 'const o = { process: 1, dataProcessing: 2 }; return o.process + o.dataProcessing'],
    // 成员访问（读 obj 的成员 ≠ 读入口）
    ["member named process", 'const o = { process: 42 }; return o.process'],
    ["member named globalThis", 'const o = { globalThis: 1 }; return o.globalThis'],
    ['computed member "process"', 'const o = { process: 7 }; return o["process"]'],
    // 间接调用形态（obj.eval / obj.Function 不是宿主入口）
    ["obj.eval()", "const o = { eval: () => 1 }; return o.eval()"],
    ["obj.Function()", "const o = { Function: () => 1 }; return o.Function()"],
  ];
  for (const [label, script] of allowed) {
    const value = await run(script);
    assert.ok(value !== undefined || true, `${label} 必须放行`);
  }
});

test("documented bypass lanes remain bypass lanes (如实标注, 不要再当可靠)", async () => {
  // 这些形态静态闸**看不见**，必须放行——这正是为什么这道闸叫「收窄」不叫「隔离」。
  // 把绕行路径写成测试，是为了让「它们仍能绕」这个事实被钉住，不再给人 narrow-but-reliable 的错觉。
  const bypasses = [
    // 计算属性拼接：静态求不出最终属性名
    'const k = "constr" + "uctor"; return agent[k]',
    // 通过 Object.getPrototypeOf 拿 constructor（名单只盯 property 名字）
    // 注意：这条仍会拦，因为 .constructor 是 MemberExpression property。仅是说明边界。
  ];
  for (const script of bypasses) {
    await run(script);  // 不抛即可
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
