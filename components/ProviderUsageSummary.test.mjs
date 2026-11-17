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

test("reset times follow the app locale, not the OS locale", () => {
  // data-tests A-9：同一张卡片的「更新时间」用 formatUpdatedTime(…, locale)，
  // 复位时间却 toLocaleString(undefined, …) 跟随系统语言，同一卡片出现两种口径。
  assert.match(source, /function formatBucket\(bucket: UsageBucket, availableLabel: string, locale: string\): string/);
  assert.match(source, /formatReset\(bucket\.resetsAt, locale\)/);
  assert.match(source, /function formatReset\(seconds: number, locale: string\): string/);
  assert.doesNotMatch(source, /toLocaleString\(undefined/);
});
