import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./AutofixView.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("a failed task list shows the error with retry, never alongside the empty state", () => {
  // interaction.md P2：useAutofix 失败时 loaded=true、tasks=[]，旧条件让「加载失败」
  // 与「暂无任务」同屏出现，且错误条没有重试入口。
  assert.match(source, /\{loaded && !error && tasks\.length === 0 && \(/);
  assert.match(source, /\{error && \([\s\S]*?t\("autofix\.loadFailed", \{ error \}\)[\s\S]*?onClick=\{\(\) => void reload\(\)\}/);
  // 重试必须真的重拉共享 store（不是只清本地错误）。
  assert.match(source, /async function reload\(\) \{[\s\S]*?await refreshAutofixTasks\(\);[\s\S]*?\}/);
});
