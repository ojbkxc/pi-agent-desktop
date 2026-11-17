import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

// The topbar's dropdown panels (agents / system prompt / tools / session info)
// are fixed layers that used to sit inline under .app-topbar — a z-index 90
// stacking context. That capped them at 90, so the page notice shelf (z 650)
// painted over their top-right corner and its cards (pointer-events: auto)
// swallowed the clicks. They are portaled to <body> at 700, like the More menu.
//
// There is no render-based assertion here: AppShell starts with
// activeTopPanel = null, so a static render never reaches the portal, and this
// repo has no DOM test renderer for interaction. The assertions pin the
// portal, its layer, and the outside-click containment a portal makes necessary.
test("the top panel dropdown is portaled to the body above the notice shelf", () => {
  assert.match(source, /\{activeTopPanel && topPanelPos && createPortal\(/);
  const start = source.indexOf("{activeTopPanel && topPanelPos && createPortal(");
  const end = source.indexOf("Windows/Linux controls stay in the chat topbar", start);
  const block = source.slice(start, end);
  assert.match(block, /ref=\{topPanelRef\}/);
  // 700 matches the More menu and clears the notice shelf (650) and the open
  // file panel (100); the old inline layer was capped at the topbar's 90.
  assert.match(block, /zIndex: 700/);
  assert.doesNotMatch(block, /zIndex: 500/);
  assert.match(block, /document\.body/);
});

test("outside-click containment covers the portaled top panel", () => {
  assert.match(source, /topPanelRef\.current\?\.contains\(event\.target as Node\)/);
  // The top bar still counts as inside so its toggle buttons keep working.
  assert.match(source, /topBarRef\.current\?\.contains\(event\.target as Node\)/);
});
