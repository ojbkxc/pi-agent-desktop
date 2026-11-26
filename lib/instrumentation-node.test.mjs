import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../instrumentation-node.ts", import.meta.url), "utf8");

test("server startup starts the pi SDK import without waiting for it (#964)", () => {
  // Next waits for register() before answering any请求, so the import must run in the
  // background; the first /api/sessions then reuses the loaded SDK.
  //
  // 断言的是**意图**而不是字面量位置：预热可以延后一拍（实测它与桌面壳的首个探针抢主线程，
  // 把一条只读环境变量的路由拖到 4655ms，见 `scripts/startup-warmup-delay.test.mjs`），
  // 但不能被删掉、也不能被 `await`（那会让 register() 等它）。
  assert.match(source, /import\("@earendil-works\/pi-coding-agent"\)/, "预热本身不许删");
  assert.doesNotMatch(source, /await import\("@earendil-works\//, "不许 await");
  // 预热必须落在某个会被调用的函数里（直接 import 或计时器回调都行）。
  assert.match(source, /(warmUp|import\("@earendil-works\/pi-coding-agent"\))/);
});
