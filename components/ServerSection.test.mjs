import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ServerSection.tsx", import.meta.url), "utf8");

test("tunnel status polling resumes when the tab becomes visible again", () => {
  // The setTimeout chain skips its tick (and with it the only continuation)
  // while hidden; the visibilitychange listener is the resume path.
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibility\)/);
  assert.match(source, /document\.removeEventListener\("visibilitychange", onVisibility\)/);
  assert.match(source, /lastLive && !timer\) void load\(\);/);
});
