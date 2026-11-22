import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The checkout may use CRLF (Windows); normalize so the multiline
// assertions below match regardless of line endings.
const source = (await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const inputSource = (await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("keeps the message scrollbar track so the column cannot move with content", () => {
  assert.match(
    source,
    /className="chat-scroll-container scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-scroll pt-4"/,
    "the message scrollport must always show its track, whether or not the session overflows yet",
  );
  // WebKit (the macOS desktop shell) does not reliably honour scrollbar-gutter,
  // so relying on it let the column jump sideways as a session loaded.
  assert.doesNotMatch(source, /\[scrollbar-gutter:stable\]/, "do not depend on scrollbar-gutter");
  assert.match(
    source,
    /paddingLeft: scrollbarGutter > 0 \? scrollbarGutter : undefined,/,
    "the scrollport mirrors its track on the left so the column centres on the full width",
  );
});

test("puts the composer column on the message column's axis", () => {
  const probe = source.slice(source.indexOf("ref={scrollbarGutterProbeRef}"));
  const probeTag = probe.slice(0, probe.indexOf("/>"));

  assert.match(probeTag, /aria-hidden="true"/, "the probe is decoration, not content");
  assert.match(probeTag, /pointer-events-none/);
  assert.match(probeTag, /opacity-0/, "the probe must never be visible");
  assert.match(probeTag, /overflow-y-scroll/, "the probe must force a track like the message list");

  assert.match(source, /const next = Math\.max\(0, probe\.offsetWidth - probe\.clientWidth\);/);
  assert.match(source, /setScrollbarGutter\(\(previous\) => \(previous === next \? previous : next\)\);/);
  assert.match(source, /new ResizeObserver\(measure\)/);
  assert.match(source, /window\.addEventListener\("resize", measure\)/);

  assert.match(
    source,
    /\.\.\.\(scrollbarGutter > 0 \? \{ paddingInline: scrollbarGutter \} : \{\}\)/,
    "the composer must be inset on both sides exactly like the message column",
  );
  assert.match(
    source,
    /right: isMobile \? 0 : CHAT_MINIMAP_WIDTH,\n              display: "flex",\n              justifyContent: "center",/,
    "the scroll-to-latest control must stay centred on the same column",
  );
});

test("the new-session screen has no header row above the composer", () => {
  // The fork dropped the icon + PRODUCT_NAME branding row and then the update
  // chip too, so nothing sits between the empty state and the composer.
  assert.doesNotMatch(source, /NewSessionUpdateLink/, "the update chip above the composer was removed");
  assert.doesNotMatch(source, /apple-touch-icon|PRODUCT_NAME/, "the product branding must not come back above the composer");
  assert.doesNotMatch(source, /\/api\/app-update/, "ChatWindow no longer checks for updates");
});

test("composer and message columns share one padding and one max width", () => {
  const columnPadding = Number(/const CHAT_COLUMN_PADDING = (\d+);/.exec(source)?.[1]);
  assert.ok(Number.isFinite(columnPadding), "CHAT_COLUMN_PADDING must be a number");

  const composerPadding = Number(/padding: compact \? 0 : "0 (\d+)px 8px"/.exec(inputSource)?.[1]);
  const widgetPadding = Number(/className="mb-2 w-full" style=\{\{ padding: "0 (\d+)px" \}\}/.exec(source)?.[1]);

  assert.equal(composerPadding, columnPadding, "the composer fieldset must inset the column like the message list");
  assert.equal(widgetPadding, columnPadding, "extension widgets must sit on the column axis");

  const maxWidth = "var(--chat-content-max-width, 820px)";
  assert.equal(
    source.split(maxWidth).length - 1,
    4,
    "message list, goal strip, extension widgets and the team-plan dock share the appearance width",
  );
  assert.equal(inputSource.split(maxWidth).length - 1, 1, "the composer shares the appearance width");
});

test("the team-plan dock sits on the same axis and width as the composer", () => {
  // Regression: the dock used to be a bare wrapper in the composer column, so the
  // card bar spanned the whole column (wider than the composer by 2 脳 16px, and
  // on a wide window wider than the 820px appearance width). The user reported it
  // as "太宽". The card must be wrapped exactly like ChatInput itself: outer
  // padding, inner max-width + centring.
  const dockStart = source.indexOf("(isPlanCardVisible(teamPlan.plan)");
  assert.ok(dockStart > 0, "the plan dock must be rendered from the same visibility predicate");
  const dock = source.slice(dockStart, dockStart + 900);

  assert.match(
    dock,
    /padding: `0 \$\{CHAT_COLUMN_PADDING\}px`/,
    "the dock insets the column like the composer fieldset",
  );
  assert.match(
    dock,
    /maxWidth: "var\(--chat-content-max-width, 820px\)"/,
    "the dock caps at the appearance width instead of the column width",
  );
  assert.match(dock, /margin: "0 auto"/, "the dock centres on the column axis");
  assert.match(dock, /minWidth: 0/, "the dock must be able to shrink inside the composer column");

  // A failed poll must stay visible: the gate used to be `plan && visible`, which
  // made the card's load-failed branch dead code and hid a broken plan entirely.
  assert.match(
    dock,
    /!teamPlan\.plan && Boolean\(teamPlan\.error\)/,
    "a failed plan fetch renders the load-failed bar instead of vanishing",
  );
});

test("publishes the chat column's inner width for portal dialogs", () => {
  // Dialogs portal to document.body, outside the chat column. The plan dialog
  // sizes itself to this variable so it stays exactly as wide as the composer.
  assert.match(
    source,
    /const inner = Math\.max\(0, Math\.round\(width - scrollbarGutter \* 2 - CHAT_COLUMN_PADDING \* 2\)\);/,
    "the published width is the column minus the composer's two insets",
  );
  assert.match(
    source,
    /document\.documentElement\.style\.setProperty\("--chat-content-region-width", `\$\{inner\}px`\);/,
    "written as a px value on the document root so the body portal inherits it",
  );
  assert.match(source, /new ResizeObserver\(\(entries\) => \{/, "tracks column resizes");
  assert.match(
    source,
    /document\.documentElement\.style\.removeProperty\("--chat-content-region-width"\);/,
    "cleaned up on unmount",
  );
  // The composer mirrors the message scrollbar with paddingInline:scrollbarGutter,
  // so the variable must subtract it too, and the effect must recompute when the
  // gutter appears/disappears (a message list that starts scrolling).
  assert.match(source, /const inner = Math\.max\(0, Math\.round\(width - scrollbarGutter \* 2/, "gutter subtracted on both sides");
  assert.match(source, /\}, \[scrollbarGutter\]\);/, "re-runs when the gutter changes");
});
