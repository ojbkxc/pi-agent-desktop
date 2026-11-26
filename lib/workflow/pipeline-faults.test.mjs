import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `pipeline` 必须**逐项容错**，与 `parallel` 一致。
 *
 * 旧实现直接 `Promise.all`：某个 item 的某个 stage 抛错，整个 pipeline reject，已经跑完的
 * 其它项成果一起丢掉（审计实测「item a failed」时 b 明明已经跑完了）。编排工具的价值就是
 * 「一项坏不挡别的」，丢掉成果比报错更坑。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { createWorkflowHooks } = await jiti.import("./hooks.ts");

function harness() {
  return createWorkflowHooks({
    parentContext: {},
    runtime: { async start() { throw new Error("not used"); } },
    limits: { maxConcurrent: 4, maxAgents: 8, timeoutMs: 5_000 },
  });
}

test("one failing item becomes null; the others keep their results", async () => {
  const handle = harness();
  const result = await handle.hooks.pipeline(
    ["good-1", "bad", "good-2"],
    async (item) => {
      if (item === "bad") throw new Error("stage blew up");
      return `${item}-done`;
    },
    async (previous) => `${previous}!`,
  );
  assert.deepEqual(result, ["good-1-done!", null, "good-2-done!"]);
});

test("the failure is recorded in the logs with its index (so the operator can see which one)", async () => {
  const handle = harness();
  await handle.hooks.pipeline(["a", "b"], async (item) => {
    if (item === "b") throw new Error("boom");
    return item;
  });
  const logs = handle.logs ?? [];
  assert.equal(logs.length, 1, "一条失败日志");
  assert.match(logs[0], /pipeline item 1 failed: boom/, "带下标与原因");
});

test("all items failing still resolves (no throw) — the script decides what to do", async () => {
  const handle = harness();
  const result = await handle.hooks.pipeline([1, 2], async () => {
    throw new Error("nope");
  });
  assert.deepEqual(result, [null, null]);
});

test("a whole batch of successes is unchanged (no behaviour drift)", async () => {
  const handle = harness();
  const result = await handle.hooks.pipeline(["x", "y"], async (item) => item.toUpperCase());
  assert.deepEqual(result, ["X", "Y"]);
  assert.equal((handle.logs ?? []).length, 0, "没有失败就不该有日志");
});
