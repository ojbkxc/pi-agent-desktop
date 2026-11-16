import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const theme = await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8");

/** The JSX block that renders the inbox, between its two unique anchors. */
function needsYouBlock() {
  const start = sidebar.indexOf("const needsYouSessions = useMemo(");
  const end = sidebar.indexOf("const renderChatFamily =", start);
  assert.notEqual(start, -1, "needsYouSessions projection not found");
  assert.notEqual(end, -1, "renderChatFamily anchor not found");
  return sidebar.slice(start, end);
}

test("the inbox projects only awaiting sessions, excluding rows the tree excludes", () => {
  const block = needsYouBlock();
  assert.match(block, /awaitingInputSessionIds\.has\(session\.id\)/);
  assert.match(block, /session\.relation\?\.kind === "subagent"/);
  assert.match(block, /session\.relation\?\.kind === "scheduled"/);
  assert.match(block, /session\.transient/);
});

test("the inbox is pinned above Chats and reuses the ordinary session row", () => {
  const inbox = sidebar.indexOf('className="sidebar-needs-you"');
  const chats = sidebar.indexOf('sidebar-project-tree-header sidebar-chats-header${chatsMenuOpen');
  assert.notEqual(inbox, -1, "inbox block missing");
  assert.notEqual(chats, -1, "chats header missing");
  assert.ok(inbox < chats, "the inbox must render before Chats (pinned above the existing order)");

  const block = sidebar.slice(inbox, chats);
  // Row component reused, not re-implemented: same click path, same rename/delete.
  assert.match(block, /<SessionItem\b/);
  assert.match(block, /onClick=\{\(\) => handleSelectSessionFromList\(session\)\}/);
  assert.match(block, /isAwaiting\b/);
  // No bespoke row markup.
  assert.doesNotMatch(block, /className="session-item/);
});

test("the inbox hides when empty, keeps its count when folded, and folds through a pref", () => {
  const header = sidebar.slice(
    sidebar.indexOf('className="sidebar-needs-you"'),
    sidebar.indexOf("sidebar-needs-you-list"),
  );
  assert.match(sidebar, /\{needsYouCount > 0 && !needsYouHidden && \(/, "renders nothing on a quiet day or during a search");
  assert.match(header, /\{needsYouCount\}/, "the count is on the header, so folding never hides it");
  assert.match(sidebar, /aria-expanded=\{!needsYouFolded\}/);
  assert.match(sidebar, /writeNeedsYouCollapsed\(folded\)/);
  assert.match(sidebar, /APP_PREF_KEYS\.collapsedNeedsYou/);
});

test("the inbox block cannot be squeezed in the column-flex tree (flex: none)", () => {
  // The regression this guards: a card-like block in a column flex container
  // with the default flex-shrink collapses to ~2px when the tree overflows.
  const rule = theme.match(/\.sidebar-needs-you \{([^}]*)\}/);
  assert.ok(rule, ".sidebar-needs-you rule missing from native-theme.css");
  assert.match(rule[1], /flex:\s*none/);
  const listRule = theme.match(/\.sidebar-needs-you-list \{([^}]*)\}/);
  assert.ok(listRule, ".sidebar-needs-you-list rule missing");
  assert.match(listRule[1], /flex:\s*none/);
  // Fork CSS belongs in native-theme.css, never globals/settings.
  assert.match(theme, /--warning/);
});
