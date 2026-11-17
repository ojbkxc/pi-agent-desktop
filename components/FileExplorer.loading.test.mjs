import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("retrying the root listing keeps the skeleton instead of flashing the empty state", () => {
  // interaction.md P2：Retry 先 setLoading(true)，但 effect 里 setLoading(cwdChanged)
  // 在 Retry 不改变 cwd 时会把 loading 立刻复位为 false；error 同时被清空，于是
  // 重试期间直接显示「No files」空态（骨架被提前关掉）。
  assert.match(source, /setLoading\(\(alreadyLoading\) => alreadyLoading \|\| cwdChanged\)/);
  // 重试入口仍然只 bump refreshKey，不伪造 cwd 变化。
  assert.match(source, /setLoading\(true\);\s*\n\s*setTreeRefreshKey\(\(value\) => value \+ 1\);/);
  // 骨架/错误/内容/空态四态的先后顺序：空态仍排除 loading 与 error。
  assert.match(source, /loading \? \(\s*\n\s*<div className="file-tree-loading"/);
  assert.match(source, /\{!loading && !error && roots\.length === 0 && \(/);
});
