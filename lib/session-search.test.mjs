import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchSessionContents } from "./session-search.ts";

function fixture(t, entries, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { id: "session", path, cwd: dir, created: "2026-01-01", modified: "2026-01-01", firstMessage: "first", messageCount: entries.length, ...overrides };
}

function message(role, content) {
  return { type: "message", message: { role, content } };
}

test("finds one literal, case-insensitive snippet per session, newest first", async (t) => {
  const older = fixture(t, [{ ...message("user", "before NEEDLE after"), id: "matched-entry" }, message("user", "needle again")], { id: "older" });
  const newer = fixture(t, [message("assistant", [{ type: "text", text: "another needle" }])], { id: "newer", modified: "2026-02-01" });
  const result = await searchSessionContents([older, newer], " needle ");
  assert.deepEqual(result.results.map(({ session }) => session.id), ["newer", "older"]);
  assert.deepEqual(result.results[1], { session: older, entryId: "matched-entry", blockIndex: 0, before: "before ", match: "NEEDLE", after: " after" });
  assert.equal(result.truncated, false);

  const literal = fixture(t, [message("user", "a".repeat(40) + "!"), message("user", "literal (a+)+$ and [test].*")]);
  assert.equal((await searchSessionContents([literal], "(a+)+$")).results[0].match, "(a+)+$");
  assert.equal((await searchSessionContents([literal], "[test].*")).results[0].match, "[test].*");
});

test("preserves the server's chat workspace classification on search hits", async (t) => {
  const session = fixture(t, [message("user", "needle")], { workspaceKind: "chat" });
  const result = await searchSessionContents([session], "needle");

  assert.equal(result.results[0].session.workspaceKind, "chat");
});

test("identifies the matching text block across thinking, tools and multiple text blocks", async (t) => {
  const session = fixture(t, [message("assistant", [
    { type: "thinking", thinking: "pi-cwd-spark" },
    { type: "text", text: "earlier text" },
    { type: "toolCall", name: "read", arguments: {} },
    { type: "text", text: "正文 pi-cwd-spark" },
    { type: "text", text: "later text" },
  ])]);
  assert.equal((await searchSessionContents([session], "pi-cwd-spark")).results[0].blockIndex, 3);
  assert.equal((await searchSessionContents([session], "earlier text")).results[0].blockIndex, 1);
  assert.equal((await searchSessionContents([session], "later")).results[0].blockIndex, 4);
  assert.equal((await searchSessionContents([session], "spark\nlater")).results[0].blockIndex, 3);
});

test("searches historical text, excluding tools, thinking, images, summaries and transient sessions", async (t) => {
  const hidden = fixture(t, [
    message("toolResult", "needle"),
    message("assistant", [{ type: "thinking", thinking: "needle" }, { type: "toolCall", arguments: { text: "needle" } }, { type: "image", data: "needle" }]),
    { type: "compaction", summary: "needle" },
    { type: "custom", data: "needle" },
    message("user", null),
    null,
  ]);
  assert.deepEqual((await searchSessionContents([hidden], "needle")).results, []);
  const history = fixture(t, [message("user", "needle before compaction"), { type: "compaction", summary: "summary" }, message("user", "current")]);
  assert.equal((await searchSessionContents([history], "needle")).results.length, 1);
  assert.deepEqual((await searchSessionContents([{ ...history, transient: true }], "needle")).results, []);
});

test("keeps Unicode offsets correct and bounds snippets around the actual match", async (t) => {
  const session = fixture(t, [message("user", `${"x".repeat(200)}\n\u0130 中文 NEEDLE \n${"y".repeat(200)}`)]);
  const result = await searchSessionContents([session], "needle");
  assert.equal(result.results[0].match, "NEEDLE");
  assert.ok(result.results[0].before.startsWith("..."));
  assert.ok(result.results[0].after.endsWith("..."));
  assert.ok(result.results[0].before.length <= 83);
  assert.doesNotMatch(result.results[0].before, /\n/);
  assert.equal((await searchSessionContents([session], "中文")).results[0].match, "中文");
});

test("skips malformed lines and reports unreadable or oversized content as incomplete", async (t) => {
  const session = fixture(t, [message("user", "x".repeat(1024 * 1024 + 1)), message("user", "needle")]);
  const missing = { ...session, id: "missing", path: join(session.cwd, "missing.jsonl") };
  const result = await searchSessionContents([missing, session], "needle");
  assert.equal(result.results.length, 1);
  assert.equal(result.truncated, true);
  writeFileSync(session.path, `invalid\n${JSON.stringify(message("user", "needle"))}\n{"type":`);
  assert.equal((await searchSessionContents([session], "needle")).results.length, 1);
});

test("handles empty, oversized and cancelled queries without reading a session", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  assert.deepEqual(await searchSessionContents([session], "  "), { results: [], truncated: false });
  await assert.rejects(searchSessionContents([session], "x".repeat(201)), RangeError);
  assert.deepEqual(await searchSessionContents([session], "needle", AbortSignal.abort()), { results: [], truncated: true });
});

test("bounds bytes read from a single file and reports the unsearched remainder", async (t) => {
  const session = fixture(t, []);
  writeFileSync(session.path, " ".repeat(16 * 1024 * 1024) + "\n" + JSON.stringify(message("user", "needle")));
  assert.deepEqual(await searchSessionContents([session], "needle"), { results: [], truncated: true });
});

test("checks the deadline inside the final file, before the matching line", async (t) => {
  const session = fixture(t, [message("user", "no match"), message("user", "needle")]);
  let ticks = 0;
  t.mock.method(Date, "now", () => ++ticks <= 3 ? 0 : 4000);
  assert.deepEqual(await searchSessionContents([session], "needle"), { results: [], truncated: true });
});

test("reports file and result caps even when no conversations match", async (t) => {
  const session = fixture(t, [message("user", "needle")]);
  const sessions = Array.from({ length: 501 }, (_, index) => ({ ...session, id: String(index) }));
  const noMatches = await searchSessionContents(sessions, "absent");
  assert.deepEqual(noMatches, { results: [], truncated: true });
  const capped = await searchSessionContents(sessions, "needle");
  assert.equal(capped.results.length, 30);
  assert.equal(capped.truncated, true);
  assert.equal((await searchSessionContents(sessions.slice(0, 30), "needle")).truncated, false);
});

test("ANDs whitespace-separated words: every word must appear in the same entry", async (t) => {
  const onlyOne = fixture(t, [message("user", "auth flow only")]);
  assert.deepEqual((await searchSessionContents([onlyOne], "auth token")).results, []);

  const both = fixture(t, [message("user", "the Token refresh broke auth again")]);
  const result = await searchSessionContents([both], "auth token");
  assert.equal(result.results.length, 1);
  // Snippet is anchored on the earliest hit ("Token"), not the query order.
  assert.equal(result.results[0].match, "Token");
});

test("keeps a double-quoted run together as one phrase", async (t) => {
  const adjacent = fixture(t, [message("user", "an auth token bug here")]);
  assert.equal((await searchSessionContents([adjacent], '"auth token"')).results.length, 1);

  const separated = fixture(t, [message("user", "auth and token are not adjacent")]);
  assert.deepEqual((await searchSessionContents([separated], '"auth token"')).results, []);
  // The same words unquoted are an AND, so they do match when merely present.
  assert.equal((await searchSessionContents([separated], "auth token")).results.length, 1);
});

test("matches case-insensitively per token", async (t) => {
  const session = fixture(t, [message("user", "AUTH Token BUG")]);
  assert.equal((await searchSessionContents([session], "auth token bug")).results.length, 1);
  assert.equal((await searchSessionContents([session], '"token bug"')).results.length, 1);
});

test("escapes regex operators in every token", async (t) => {
  const session = fixture(t, [message("user", "literal (a+)+$ [test].* end")]);
  const phrase = await searchSessionContents([session], '"(a+)+$ [test].*"');
  assert.equal(phrase.results[0].match, "(a+)+$ [test].*");
  assert.deepEqual((await searchSessionContents([session], '"a+ b+ c+"')).results, []);
});

test("attaches the short project name when the session knows its project root", async (t) => {
  const session = fixture(t, [message("user", "needle")], { projectRoot: "/work/pi-agent-desktop" });
  assert.equal((await searchSessionContents([session], "needle")).results[0].projectName, "pi-agent-desktop");

  // Fixtures without a projectRoot keep the legacy result shape (no projectName).
  const bare = fixture(t, [message("user", "needle")]);
  assert.equal("projectName" in (await searchSessionContents([bare], "needle")).results[0], false);
});

