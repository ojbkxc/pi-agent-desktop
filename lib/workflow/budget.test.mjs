import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * workflow 的预算与取消必须是**真的**（不是「不再等」）。
 *
 * 两条实测缺陷：
 * 1. `maxAgents` 是 TOCTOU：检查在 `await semaphore.acquire()` 之前、自增在之后，排队者
 *    读到的 `started` 全是旧值 → `maxAgents=2, maxConcurrent=2, parallel(8)` 实测起了 8 个。
 * 2. 超时只让 `Promise.race` 拒绝：脚本还在跑，接着又起节点、又写日志（实测返回 700ms 后
 *    多出 1 个节点与 1 条日志）。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { runWorkflow } = await jiti.import("./run.ts");

/** 最小 runtime：记录真正起了几个 agent，并按 delay 决定何时结束。 */
function fakeRuntime(delayMs = 5) {
  const started = [];
  return {
    started,
    async start(request) {
      started.push(request.description);
      let cancelled = false;
      request.signal?.addEventListener("abort", () => { cancelled = true; });
      const completion = new Promise((resolve) => {
        setTimeout(() => resolve(cancelled
          ? { status: "aborted", result: "" }
          : { status: "completed", result: `ok:${request.description}` }), delayMs);
      });
      return { completion };
    },
  };
}

const opts = (runtime, script, limits = {}, signal) => ({
  script,
  runtime,
  limits: { timeoutMs: 5_000, maxConcurrent: 8, maxAgents: 64, ...limits },
  parentContext: {},
  ...(signal ? { signal } : {}),
});

test("`maxAgents` holds under concurrency (no TOCTOU window)", async () => {
  const runtime = fakeRuntime();
  const result = await runWorkflow(opts(
    runtime,
    `
    const out = await parallel(Array.from({ length: 8 }, (_, i) => () => agent("n" + i)));
    return out.length;
    `,
    { maxAgents: 2, maxConcurrent: 2 },
  ));
  // 预算撞墙时 parallel 把失败项变成 null，但**真正起的 agent 数**不能超过 2。
  assert.ok(runtime.started.length <= 2, `实起 ${runtime.started.length} 个，预算只有 2`);
  assert.equal(result.agents, runtime.started.length, "记账数必须等于实起数");
});

test("a timeout really stops the script: nothing new starts after we return", async () => {
  const runtime = fakeRuntime(400);
  const result = await runWorkflow(opts(
    runtime,
    `
    await agent("slow");
    // 预算会在上面那一轮里烧完；这一行若能执行，说明超时之后脚本还在跑。
    await agent("ghost");
    return "done";
    `,
    { timeoutMs: 120 },
  ));
  assert.equal(result.aborted, true, "超时要标成 aborted");
  const atReturn = runtime.started.length;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    runtime.started.length,
    atReturn,
    "返回之后不得再起任何 agent（旧的 race 会让 ghost 继续跑）",
  );
  assert.equal(runtime.started.includes("ghost"), false, "超时后不该走到下一行");
});

test("cancelling the caller's signal stops queued agents too", async () => {
  const controller = new AbortController();
  const runtime = fakeRuntime(200);
  const run = runWorkflow(opts(
    runtime,
    `
    const out = await parallel(Array.from({ length: 6 }, (_, i) => () => agent("n" + i)));
    return out.filter(Boolean).length;
    `,
    { maxAgents: 6, maxConcurrent: 2 },
    controller.signal,
  ));
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort(new Error("user stop"));
  await run;
  const atReturn = runtime.started.length;
  // 关键断言：取消之后**排队的节点不许再启动**。
  //
  // 不强制 `aborted === true`：`parallel` 把失败项吞成 null，脚本本身可能正常跑完并 return，
  // 这条路径不抛错、`aborted` 就是 false。用户关心的「点了停止还在起节点的」是这里。
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(runtime.started.length, atReturn, "取消后排队的不许再启动");
  assert.ok(runtime.started.length < 6, `实起 ${runtime.started.length} 个，取消应让其余不再启动`);
});
