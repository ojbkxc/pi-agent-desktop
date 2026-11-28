// Pure-logic coverage for the prompt optimization shared module.
// Tests isOptimizablePrompt, buildPromptOptimizeUserMessage, cleanOptimizedPrompt,
// and extractOptimizedPrompt.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  isOptimizablePrompt,
  buildPromptOptimizeUserMessage,
  cleanOptimizedPrompt,
  extractOptimizedPrompt,
  PROMPT_OPTIMIZE_MAX_CHARS,
} = await jiti.import("@/lib/prompt-optimize");

test("isOptimizablePrompt rejects empty and whitespace-only text", () => {
  assert.equal(isOptimizablePrompt(""), false);
  assert.equal(isOptimizablePrompt("   "), false);
  assert.equal(isOptimizablePrompt("\n\t"), false);
});

test("isOptimizablePrompt rejects slash commands", () => {
  assert.equal(isOptimizablePrompt("/help"), false);
  assert.equal(isOptimizablePrompt("/ session"), false);
  assert.equal(isOptimizablePrompt("  /compact"), false);
});

test("isOptimizablePrompt accepts normal text", () => {
  assert.equal(isOptimizablePrompt("fix the bug"), true);
  assert.equal(isOptimizablePrompt("  hello world  "), true);
  assert.equal(isOptimizablePrompt("#session"), true);
  assert.equal(isOptimizablePrompt("@file.ts"), true);
});

test("buildPromptOptimizeUserMessage wraps the draft in a system-reminder block", () => {
  const msg = buildPromptOptimizeUserMessage("fix the login bug");
  assert.match(msg, /PROMPT OPTIMIZATION MODE/);
  assert.match(msg, /fix the login bug/);
  assert.match(msg, /<user_draft>/);
  assert.match(msg, /<\/user_draft>/);
});

test("buildPromptOptimizeUserMessage picks a tag that does not appear in the draft", () => {
  const draft = "do not use <user_draft> tags";
  const msg = buildPromptOptimizeUserMessage(draft);
  // The draft contains <user_draft>, so the builder must pick a different tag.
  assert.match(msg, /<user_draft_1>/);
  assert.doesNotMatch(msg, /<user_draft>\n<user_draft>/);
});

test("cleanOptimizedPrompt strips an outer XML wrapper", () => {
  assert.equal(
    cleanOptimizedPrompt("<optimized_prompt>fix the bug</optimized_prompt>"),
    "fix the bug",
  );
  assert.equal(
    cleanOptimizedPrompt("<rewritten_prompt>do the thing</rewritten_prompt>"),
    "do the thing",
  );
});

test("cleanOptimizedPrompt preserves inner XML-like content", () => {
  const text = "<optimized_prompt>use <b>bold</b> tags</optimized_prompt>";
  assert.equal(cleanOptimizedPrompt(text), "use <b>bold</b> tags");
});

test("cleanOptimizedPrompt strips a leading label line", () => {
  assert.equal(cleanOptimizedPrompt("Optimized prompt: fix the bug"), "fix the bug");
  assert.equal(cleanOptimizedPrompt("优化后的提示词：修复登录问题"), "修复登录问题");
  assert.equal(cleanOptimizedPrompt("改进后的提示词: do it"), "do it");
});

test("cleanOptimizedPrompt strips a single outer markdown fence", () => {
  assert.equal(cleanOptimizedPrompt("```\nfix the bug\n```"), "fix the bug");
  assert.equal(cleanOptimizedPrompt("```text\nfix the bug\n```"), "fix the bug");
});

test("cleanOptimizedPrompt preserves inner markdown fences", () => {
  const text = "```\n```\nfix the bug\n```\n```";
  // The outer fence wraps content that itself contains a fence, so it is not stripped.
  assert.equal(cleanOptimizedPrompt(text), text.trim());
});

test("cleanOptimizedPrompt returns empty string for empty input", () => {
  assert.equal(cleanOptimizedPrompt(""), "");
  assert.equal(cleanOptimizedPrompt("   "), "");
});

test("extractOptimizedPrompt joins text blocks and cleans the result", () => {
  const content = [
    { type: "text", text: "fix the bug" },
    { type: "thinking", text: "reasoning" },
  ];
  assert.equal(extractOptimizedPrompt(content), "fix the bug");
});

test("extractOptimizedPrompt returns empty when no text blocks", () => {
  const content = [{ type: "thinking", text: "reasoning" }];
  assert.equal(extractOptimizedPrompt(content), "");
});

test("PROMPT_OPTIMIZE_MAX_CHARS matches the server-side limit", () => {
  assert.equal(PROMPT_OPTIMIZE_MAX_CHARS, 32_000);
});
