import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const view = await readFile(new URL("./TasksView.tsx", import.meta.url), "utf8");
const theme = await readFile(new URL("../../app/native-theme.css", import.meta.url), "utf8");

test("the Waiting group is titled, counted and marked as the attention group", () => {
  // The group header carries a count badge and an amber dot, matching the
  // sidebar's Needs you fold, without adding a second row component.
  assert.match(view, /tasks-section--attention/);
  assert.match(view, /tasks-section-dot/);
  assert.match(view, /<span className="tasks-section-count">\{rows\.length\}<\/span>/);
  // The existing group titles stay untouched (no duplicate section headings).
  assert.match(view, /t\(`tasks\.section\.\$\{key\}`\)/);
});

test("the attention styling lives in the fork theme file, not globals", () => {
  assert.match(theme, /\.tasks-section--attention \.tasks-section-title \{/);
  assert.match(theme, /\.tasks-section--attention \.tasks-section-count \{/);
  assert.match(theme, /\.tasks-section-dot \{/);
});

test("the page still polls only while visible", () => {
  assert.match(view, /isVisible: \(\) => document\.visibilityState === "visible"/);
  assert.match(view, /document\.addEventListener\("visibilitychange", onVisible\)/);
});
