import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 两条「界面的谎话」的回归（团队计数审计 P3-1 / P3-2）。
 *
 * P3-1：成员行整行挂着 `cursor: pointer`，但点击处理在内部 `<button>` 上，左右各 8px 的
 * 内边距是纯死区——看着可点、点着没反应。指针语义只该在按钮上。
 *
 * P3-2：思考强度是 runtime 的一部分，没有模型就发不出去，所以禁用是对的；但界面只把下拉
 * 变灰、不说原因，用户不知道要先选模型。补一行解释（三语）。
 */
const editor = readFileSync(new URL("./PlanEditor.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const messages = readFileSync(new URL("../../lib/i18n/locale-plugins.ts", import.meta.url), "utf8");

test("P3-1: the member row does not claim to be clickable", () => {
  const rowStyle = editor.slice(editor.indexOf("row: (active: boolean) => ({"), editor.indexOf("rowMeta:"));
  assert.doesNotMatch(rowStyle, /cursor:\s*"pointer"/, "the row is layout only; the button owns the pointer");
  // 按钮自己仍然有指针语义。
  assert.match(editor, /padding: 0, textAlign: "left", cursor: "pointer"/, "the name button stays clickable");
});

test("P3-2: a disabled thinking-level select explains why", () => {
  assert.match(editor, /disabled=\{!editable \|\| !activeModelUsable\}/, "it is still disabled without a model");
  assert.match(editor, /title=\{!activeModelUsable && editable \? t\("teams\.plan\.effortNeedsModel"\) : undefined\}/);
  assert.match(editor, /data-testid="team-plan-effort-needs-model"/, "and the reason is visible, not tooltip-only");
});

test("P3-2: the explanation exists in all three locales", () => {
  const hits = messages.match(/"teams\.plan\.effortNeedsModel": "\S/g) ?? [];
  assert.equal(hits.length, 3, `en / zh-CN / zh-TW must all carry it, found ${hits.length}`);
});
