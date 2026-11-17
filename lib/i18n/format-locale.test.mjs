import assert from "node:assert/strict";
import test from "node:test";
import { formatClockTime, formatDateTime } from "./format.ts";

// A-9：日期格式化必须跟随**应用语言**，不能传 undefined 跟随操作系统。
test("formatDateTime 跟随传入的 locale，而不是系统 locale", () => {
  const iso = "2026-01-02T03:04:05Z";
  // 同一时刻在两种应用语言下应产生不同文本（英文/中文的日期分隔与顺序不同）。
  const zh = formatDateTime(iso, "zh-CN");
  const en = formatDateTime(iso, "en");
  assert.ok(zh.length > 0 && en.length > 0);
  assert.notEqual(zh, en);
  // 年份按各自 locale 的 short 格式出现（zh 为 2026，en 的 short 为两位年）。
  assert.match(zh, /2026/);
  assert.match(en, /\/26|\/2026|26$/);
});

test("formatClockTime 返回 HH:MM，无效时间返回空串", () => {
  assert.match(formatClockTime("2026-01-02T03:04:05Z", "en"), /^\d{1,2}:\d{2}(\s?[AP]M)?$/i);
  assert.equal(formatDateTime("not a date", "zh-CN"), "");
  assert.equal(formatClockTime("not a date", "en"), "");
});
