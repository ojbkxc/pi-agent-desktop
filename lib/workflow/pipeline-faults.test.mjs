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

// M2 回归：pipeline 的逐项 catch 曾把 `WorkflowError("aborted"|"timeout"|"limit")` 一并吞成 null，
// runWorkflow 因此 `aborted=false`、UI 看到一堆 null 不知道是被停了还是全失败。
// 现在：终局错误必须向上抛（与 DSH `isFatalWorkflowError` 对齐，CANCELLED 是 fatal），
// 普通业务失败依旧转 null。

test("an abort signal thrown by a stage is re-thrown, not nulled (M2)", async () => {
  const handle = harness();
  // 直接构造一个跨模块实例的伪 WorkflowError：name 匹配、code 是终局码。
  // 这正是 jiti 双加载场景下的形状，instanceof 在这里会静默失配，所以按 name 识别。
  const abortError = new Error("cancelled by user");
  abortError.name = "WorkflowError";
  abortError.code = "aborted";
  await assert.rejects(
    handle.hooks.pipeline(["a", "b"], async (item) => {
      if (item === "a") throw abortError;
      return item;
    }),
    (error) => error === abortError,
    "aborted 必须原样上抛，不能吞成 null",
  );
});

test("a limit (maxAgents) error is re-thrown, not nulled (M2)", async () => {
  const handle = harness();
  const limitError = new Error("budget reached");
  limitError.name = "WorkflowError";
  limitError.code = "limit";
  await assert.rejects(
    handle.hooks.pipeline([1, 2, 3], async (item) => {
      if (item === 2) throw limitError;
      return item;
    }),
    (error) => error === limitError,
    "limit 必须原样上抛",
  );
});

test("a timeout error is re-thrown, not nulled (M2)", async () => {
  const handle = harness();
  const timeoutError = new Error("budget exceeded");
  timeoutError.name = "WorkflowError";
  timeoutError.code = "timeout";
  await assert.rejects(
    handle.hooks.pipeline([1], async () => {
      throw timeoutError;
    }),
    (error) => error === timeoutError,
    "timeout 必须原样上抛",
  );
});

test("an ordinary Error from a stage still becomes null (regression guard)", async () => {
  const handle = harness();
  const result = await handle.hooks.pipeline(["x", "y"], async (item) => {
    if (item === "y") throw new Error("plain stage bug");
    return item;
  });
  assert.deepEqual(result, ["x", null], "普通业务错依旧转 null，不被 M2 误伤");
  assert.match(handle.logs[0] ?? "", /pipeline item 1 failed: plain stage bug/);
});

test("a whole batch of successes is unchanged (no behaviour drift)", async () => {
  const handle = harness();
  const result = await handle.hooks.pipeline(["x", "y"], async (item) => item.toUpperCase());
  assert.deepEqual(result, ["X", "Y"]);
  assert.equal((handle.logs ?? []).length, 0, "没有失败就不该有日志");
});
