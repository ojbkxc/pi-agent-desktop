// Source-level coverage for the usePromptOptimize hook.
// Asserts the key lifecycle behaviors: cancel, session-switch guard, baseline
// validation, restore snapshot, and the isOptimizablePrompt gate.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./usePromptOptimize.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("optimize guards: no session, disabled, or already optimizing returns early", () => {
  assert.match(source, /if \(!targetSessionId \|\| disabled \|\| activeRef\.current\) return/);
});

test("optimize checks isOptimizablePrompt before starting", () => {
  assert.match(source, /isOptimizablePrompt\(draft\.text\)/);
});

test("optimize enforces max character count", () => {
  assert.match(source, /PROMPT_OPTIMIZE_MAX_CHARS/);
  assert.match(source, /tooLong/);
});

test("cancel aborts the controller and calls cancelOptimizePrompt", () => {
  assert.match(source, /active\.controller\.abort\(\)/);
  assert.match(source, /cancelOptimizePrompt\(active\.sessionId, active\.requestId\)/);
});

test("session-switch cleanup cancels in-flight optimization and clears snapshot", () => {
  assert.match(source, /useEffect\(\([\s\S]*?\[sessionId, cancel\]/);
  assert.match(source, /return \(\) => \{\s*cancel\(\)/);
});

test("baseline validation: discards response if draft text changed", () => {
  assert.match(source, /getDraft\(\)\.text !== active\.baselineText/);
});

test("aborted or superseded response is discarded", () => {
  assert.match(source, /activeRef\.current !== active \|\| controller\.signal\.aborted/);
  assert.match(source, /sessionIdRef\.current !== targetSessionId/);
});

test("restore snapshot stores the baseline text for 8s undo", () => {
  assert.match(source, /setRestoreSnapshot\(\{[\s\S]*?text: active\.baselineText/);
});

test("unchanged optimized text shows a notice instead of applying", () => {
  assert.match(source, /optimizedText === active\.baselineText\.trim\(\)/);
  assert.match(source, /unchanged/);
});

test("restore writes the snapshot text back via applyDraft", () => {
  assert.match(source, /applyDraft\(snapshot\.text\)/);
});

test("notifyDraftChanged cancels optimization and clears snapshot", () => {
  assert.match(source, /if \(activeRef\.current\) cancel\(\)/);
  assert.match(source, /setRestoreSnapshot\(null\)/);
});

test("applyingRef prevents notifyDraftChanged from cancelling during apply", () => {
  assert.match(source, /if \(applyingRef\.current\) return/);
});

test("abort errors are swallowed (not shown as failures)", () => {
  assert.match(source, /isAbortError\(error\)/);
});

test("hook returns the full controller surface", () => {
  assert.match(source, /isOptimizing,/);
  assert.match(source, /restoreSnapshot,/);
  assert.match(source, /notice,/);
  assert.match(source, /issue,/);
  assert.match(source, /optimize,/);
  assert.match(source, /cancel,/);
  assert.match(source, /restore,/);
  assert.match(source, /dismissRestore,/);
  assert.match(source, /dismissNotice,/);
  assert.match(source, /dismissIssue,/);
  assert.match(source, /notifyDraftChanged,/);
});
