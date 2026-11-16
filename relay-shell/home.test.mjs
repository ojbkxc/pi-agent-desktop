import assert from "node:assert/strict";
import test from "node:test";

const {
  parseAttentionResponse,
  parseAttentionItem,
  attentionItemTitle,
  attentionPreview,
  attentionItemMeta,
  attentionHref,
  relativeAge,
} = await import("./home.ts");

const ITEM = {
  sessionId: "s1",
  title: "  Refactor   the auth middleware ",
  workspaceKind: "project",
  projectName: "pi-agent-desktop",
  kind: "awaiting-input",
  awaitingSince: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  lastMessagePreview: "May I delete the legacy tokens?\n\nThey are only used…",
};

test("a well-formed payload parses both lists", () => {
  const snapshot = parseAttentionResponse({
    awaiting: [ITEM],
    completed: [{ ...ITEM, sessionId: "s2", kind: "completed" }],
    generatedAt: 1_700_000_200_000,
  });
  assert.equal(snapshot.awaiting.length, 1);
  assert.equal(snapshot.completed.length, 1);
  assert.equal(snapshot.generatedAt, 1_700_000_200_000);
  assert.equal(snapshot.awaiting[0].title, ITEM.title, "raw title is kept; display trims");
  assert.equal(snapshot.awaiting[0].kind, "awaiting-input");
  assert.equal(snapshot.completed[0].kind, "completed");
});

test("the list decides the kind even when the row disagrees", () => {
  const snapshot = parseAttentionResponse({
    awaiting: [{ ...ITEM, kind: "completed" }],
    completed: [],
  });
  assert.equal(snapshot.awaiting[0].kind, "awaiting-input");
});

test("a payload that is not the contract shape is null, not a half dashboard", () => {
  for (const bad of [null, undefined, 5, "x", [], {}, { awaiting: [] }, { completed: [] }, { awaiting: {}, completed: [] }]) {
    assert.equal(parseAttentionResponse(bad), null, JSON.stringify(bad));
  }
});

test("one broken row is skipped, not the list", () => {
  const snapshot = parseAttentionResponse({
    awaiting: [ITEM, { sessionId: "" }, { sessionId: "x" }, null, { ...ITEM, sessionId: "s3", title: "ok" }],
    completed: [],
  });
  assert.deepEqual(snapshot.awaiting.map((item) => item.sessionId), ["s1", "s3"]);
  assert.equal(snapshot.generatedAt, 0, "a missing stamp becomes 0, not NaN");
});

test("a session still awaiting is not duplicated under completed", () => {
  const snapshot = parseAttentionResponse({
    awaiting: [{ ...ITEM, sessionId: "s1" }],
    completed: [{ ...ITEM, sessionId: "s1", kind: "completed" }, { ...ITEM, sessionId: "s2", kind: "completed" }],
  });
  assert.deepEqual(snapshot.completed.map((item) => item.sessionId), ["s2"]);
});

test("optional fields are only carried when they hold text or a real stamp", () => {
  const minimal = parseAttentionItem({ sessionId: "s", title: "t", updatedAt: 10, projectName: "  ", awaitingSince: 0 }, "awaiting-input");
  assert.deepEqual(minimal, { sessionId: "s", title: "t", workspaceKind: "project", kind: "awaiting-input", updatedAt: 10 });
  assert.equal(parseAttentionItem({ sessionId: "s", title: "t" }, "completed"), null, "no updatedAt, no row");
});

test("row text: collapsed title, capped preview", () => {
  assert.equal(attentionItemTitle({ ...ITEM, title: " a  \n b " }), "a b");
  assert.equal(attentionItemTitle({ ...ITEM, title: "   " }), "(untitled session)");
  const preview = attentionPreview({ ...ITEM, lastMessagePreview: "x".repeat(400) });
  assert.ok(preview.length <= 140, String(preview.length));
  assert.ok(preview.endsWith("…"));
  assert.equal(attentionPreview({ ...ITEM, lastMessagePreview: " ok\n now " }), "ok now");
  assert.equal(attentionPreview({ ...ITEM, lastMessagePreview: undefined }), "");
});

test("relative ages read like a phone list", () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeAge(now, now - 5_000), "now");
  assert.equal(relativeAge(now, now - 4 * 60_000), "4 min");
  assert.equal(relativeAge(now, now - 3 * 3_600_000), "3 h");
  assert.equal(relativeAge(now, now - 2 * 86_400_000), "2 d");
  assert.match(relativeAge(now, now - 30 * 86_400_000), /\d/, "a month out falls back to a date");
  assert.equal(relativeAge(now, 0), "");
});

test("meta line says where the session lives and how long it waited", () => {
  const now = 1_700_000_180_000; // 3 minutes after awaitingSince
  assert.equal(attentionItemMeta({ ...ITEM, awaitingSince: now - 4 * 60_000, updatedAt: now }, now), "pi-agent-desktop · waiting 4 min");
  assert.equal(attentionItemMeta({ ...ITEM, workspaceKind: "chat", projectName: undefined, kind: "completed", updatedAt: now - 3_600_000 }, now), "Chat · 1 h ago");
  assert.equal(attentionItemMeta({ ...ITEM, projectName: undefined, awaitingSince: undefined, updatedAt: now }, now), "waiting now");
});

test("rows link to the app's own session deep link", () => {
  assert.equal(attentionHref("a b&c"), "/?session=a%20b%26c");
  // Both of those shapes are framed by the shell (relay-shell/paths.ts).
});