import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ProviderUsageSummary.tsx", import.meta.url), "utf8");

test("switching providers resets the query spinner, not only the sequence", () => {
  // A stale response's finally skips setQuerying(false) (requestId !== seq),
  // so the providerId effect must clear querying itself — otherwise the new
  // panel's refresh button stays disabled and the spinner spins forever.
  assert.match(source, /querySeqRef\.current \+= 1;\s*\n\s*setQuerying\(false\);/);
});

test("a stale query response can neither paint nor end the pending state", () => {
  assert.match(source, /if \(requestId !== querySeqRef\.current\) return;/);
  assert.match(source, /if \(requestId === querySeqRef\.current\) setQuerying\(false\);/);
});
