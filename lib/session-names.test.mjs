import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_NAME_MAX_LENGTH, normalizeSessionName } from "./session-names.ts";

test("会话名上限为 200（服务端与侧栏输入框共用）", () => {
  assert.equal(SESSION_NAME_MAX_LENGTH, 200);
});

test("去首尾空白，空串保留（清除标题）", () => {
  assert.equal(normalizeSessionName("  hello  "), "hello");
  assert.equal(normalizeSessionName(""), "");
  assert.equal(normalizeSessionName("   "), "");
});

test("超长名字按上限截断", () => {
  const long = "a".repeat(SESSION_NAME_MAX_LENGTH + 50);
  assert.equal(normalizeSessionName(long).length, SESSION_NAME_MAX_LENGTH);
  // 恰好等于上限不截断。
  const exact = "b".repeat(SESSION_NAME_MAX_LENGTH);
  assert.equal(normalizeSessionName(exact), exact);
});

test("按码点截断，不把 emoji 从中间切开", () => {
  // 每个 emoji 是 2 个 UTF-16 code unit；用 1 个上限验证按码点而非 code unit 切。
  const name = "😀".repeat(SESSION_NAME_MAX_LENGTH + 5);
  const result = normalizeSessionName(name);
  assert.equal(Array.from(result).length, SESSION_NAME_MAX_LENGTH);
  // 结果仍是合法码点序列（没有孤立代理项）。
  assert.equal(result, "😀".repeat(SESSION_NAME_MAX_LENGTH));
});
