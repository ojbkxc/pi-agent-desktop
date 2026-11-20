import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/attention/route.ts", import.meta.url), "utf8");
const attention = await readFile(new URL("./attention.ts", import.meta.url), "utf8");
const types = await readFile(new URL("./attention-types.ts", import.meta.url), "utf8");

test("the attention route is dynamic and no-store, like the other live snapshots", () => {
  assert.match(route, /export const dynamic = "force-dynamic";/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(route, /loadAttentionSnapshot\(\)/);
  // A failed assembly is a 500 with an error field, not an empty inbox.
  assert.match(route, /status: 500/);
});

test("the route serves the pinned snapshot shape untouched", () => {
  assert.match(route, /NextResponse\.json\(snapshot,/);
  assert.match(types, /export interface AttentionSnapshot \{/);
  assert.match(types, /awaiting: AttentionItem\[\];/);
  assert.match(types, /completed: AttentionItem\[\];/);
  assert.match(types, /generatedAt: number;/);
  // The shared types file must stay dependency-free: the phone shell bundles it.
  assert.doesNotMatch(types, /^import /m);
});

test("server assembly loads session metadata lazily so the pure logic stays testable", () => {
  assert.match(attention, /await Promise\.all\(\[\s*import\("\.\/session-reader"\),\s*import\("\.\/rpc-manager"\),/);
  assert.match(attention, /getAwaitingInputRpcSessionIds\(\)/);
  assert.match(attention, /listAllSessions\(\)/);
  // Browsing stays on the documented read path: no ad-hoc directory scanner.
  assert.doesNotMatch(attention, /readdir|createReadStream|readFileSync/);
});

test("completed is capped at 20 and unread filtering is left to the client", () => {
  assert.match(attention, /ATTENTION_COMPLETED_LIMIT = 20/);
  assert.match(attention, /ATTENTION_AUTOFIX_LIMIT = 10/);
  // Autofix rows come first and count against the same cap.
  assert.match(attention, /\.slice\(0, Math\.max\(0, completedLimit - autofixItems\.length\)\)/);
  assert.match(attention, /completed: \[\.\.\.autofixItems, \.\.\.completed\]/);
  // No unread judgement on the server: no unread field, no unread set.
  assert.doesNotMatch(attention, /unreadSessionIds|isUnread|"unread"/i);
  assert.doesNotMatch(types, /^\s*unread/mi, "no unread field on the wire type");
});
