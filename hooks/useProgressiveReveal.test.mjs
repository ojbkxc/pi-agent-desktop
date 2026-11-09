import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * useProgressiveReveal 的行为契约（静态源码断言，同本仓其它 hook 测试口径）。
 * 渐进挂载是打开通信流的性能底线：一页 40 行、换 resetKey 从第一页重来、翻页时
 * 重新 observe 哨兵、查找跳转按页挂载到目标行。
 */
const source = await readFile(new URL("./useProgressiveReveal.ts", import.meta.url), "utf8");

test("每页 40 行，且仅在列表含义变化（resetKey）时从第一页重来", () => {
  assert.match(source, /export const REVEAL_PAGE_SIZE = 40/);
  assert.match(source, /if \(revealed\.key !== resetKey\) setRevealed\(\{ key: resetKey, limit: REVEAL_PAGE_SIZE \}\)/);
});

test("滚动哨兵用 IntersectionObserver 预取，每页后重新 observe", () => {
  assert.match(source, /typeof IntersectionObserver === "function"/);
  assert.match(source, /new IntersectionObserver\(/);
  assert.match(source, /root: scrollRootRef\.current/);
  assert.match(source, /observer\.observe\(sentinel\)/);
  assert.match(source, /observer\.disconnect\(\)/);
});

test("查找跳转按页向上取整挂载到目标行", () => {
  assert.match(source, /const needed = \(Math\.floor\(index \/ REVEAL_PAGE_SIZE\) \+ 1\) \* REVEAL_PAGE_SIZE/);
  assert.match(source, /currentLimit >= needed \? current : \{ key: resetKey, limit: needed \}/);
});
