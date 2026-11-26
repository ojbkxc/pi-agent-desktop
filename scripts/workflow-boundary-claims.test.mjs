import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * workflow 脚本的执行边界必须**如实写**，不许再往好里说。
 *
 * 实测两件事（探针跑过）：
 * 1. `vm` 不是安全边界——钩子是宿主函数，`agent.constructor.constructor("return process")()`
 *    能拿到宿主 `process`（56 个 env 键）、能 `getBuiltinModule("node:fs")` 读文件。静态闸
 *    只拦字面量，拼串能绕。
 * 2. 纯微任务死循环（`while (true) { await null; }`）饿死宿主事件循环，`vm` 的 `timeout`
 *    与外面的 `Promise.race` **同时失效**。
 *
 * 也验过「换 worker_threads」：worker 里照样有 `process` / `require`（等于没隔离），只解决
 * 第 2 条，还要把所有钩子改成异步消息协议——为一个「只用于可信脚本」的工具不值。
 *
 * 所以 docstring 与工具描述都得写清「可信输入」，而不是「沙箱」。这条测试钉住措辞：
 * 谁把「足以挡住模型顺手读个文件」那句话写回去，这里就红。
 */
const sandbox = readFileSync(new URL("../lib/workflow/sandbox.ts", import.meta.url), "utf8");
const extension = readFileSync(new URL("../lib/subagent-extension.ts", import.meta.url), "utf8");

test("the sandbox docstring states it is NOT a security boundary", () => {
  assert.match(sandbox, /`vm` 不是安全边界/, "要点明 vm 不是安全边界");
  assert.match(sandbox, /可信输入/, "要给出正确定位：可信输入");
  assert.match(sandbox, /getBuiltinModule/, "要点名实测到的逃逸链");
  assert.match(sandbox, /while \(true\) \{ await null; \}|饿死宿主事件循环/, "要点名微任务饥饿");
});

test("the old over-promise is gone", () => {
  // 这句话曾经写着「足以挡住模型顺手读个文件/发个请求」——实测不成立。
  assert.doesNotMatch(
    sandbox,
    /这条足以挡住「模型顺手读个文件\/发个请求」/,
    "over-promise 必须删掉，它已被实测推翻",
  );
});

test("the workflow tool description warns the model, not just the source comments", () => {
  // 模型读的是工具描述与 guidelines，不是源码注释——警告必须出现在它读得到的地方。
  const block = extension.slice(extension.indexOf('name: "workflow"'), extension.indexOf("async execute", extension.indexOf('name: "workflow"')));
  assert.match(block, /NOT a security boundary|NOT a security boundary/);
  assert.match(block, /refused before it runs/, "静态闸的行为要说清");
  assert.match(block, /stall the host/, "微任务饥饿要在描述里点明");
  assert.match(block, /while \(true\)/, "guidelines 要明确禁止无界 await 循环");
});
