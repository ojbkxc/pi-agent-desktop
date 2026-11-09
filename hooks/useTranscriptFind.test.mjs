import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * useTranscriptFind：本仓没有 cc-haha 的 conversationFindBridge / findHighlights，
 * 这是自包含的同款契约（模块级注册表 + data-find-row 定位滚动）。这里既做纯函数
 * collectRowMatches 的行为断言，也做源码接线断言（导出、属性名、滚动口径）。
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { collectRowMatches, MAX_FIND_MATCHES } = await jiti.import("./useTranscriptFind.ts");

const rows = ["hello world", "HELLO there", "no match here", "a a a"];

test("collectRowMatches：大小写不敏感，跨行逐处统计出现次数", () => {
  assert.deepEqual(collectRowMatches(rows, (row) => row, "hello"), [
    { rowIndex: 0, occurrence: 0 },
    { rowIndex: 1, occurrence: 0 },
  ]);
  // 同一行内多处出现：按出现次序编号。
  assert.deepEqual(collectRowMatches(["a a a"], (row) => row, "a"), [
    { rowIndex: 0, occurrence: 0 },
    { rowIndex: 0, occurrence: 1 },
    { rowIndex: 0, occurrence: 2 },
  ]);
  assert.deepEqual(collectRowMatches(rows, (row) => row, "zzz"), []);
  assert.deepEqual(collectRowMatches(rows, (row) => row, ""), [], "空查询不返回命中");
});

test("collectRowMatches：命中达到 MAX_FIND_MATCHES 即截断", () => {
  const many = Array.from({ length: MAX_FIND_MATCHES + 50 }, () => "hit");
  const matches = collectRowMatches(many, (row) => row, "hit");
  assert.equal(matches.length, MAX_FIND_MATCHES);
});

const source = await readFile(new URL("./useTranscriptFind.ts", import.meta.url), "utf8");

test("接线：导出注册表与内容变化通知，行定位走 data-find-row + scrollIntoView", () => {
  assert.match(source, /export function registerTranscriptFindController\(/);
  assert.match(source, /export function notifyTranscriptFindContentChanged\(/);
  assert.match(source, /export const FIND_ROW_ATTRIBUTE = "data-find-row"/);
  assert.match(source, /export const FIND_TRANSCRIPT_ATTRIBUTE = "data-find-transcript"/);
  assert.match(source, /revealThrough\(match\.rowIndex\)/, "跳转命中先挂载到该行");
  assert.match(source, /scrollIntoView\?\.\(\{ block: "center" \}\)/);
});
