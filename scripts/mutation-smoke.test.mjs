import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { MUTATIONS } from "./mutation-smoke.mjs";

test("every mutation still finds its anchor in the file it targets", () => {
  // The failure mode this catches: the product code moves on, the mutation stops
  // applying, and the harness quietly reports nothing (which reads like "green").
  for (const entry of MUTATIONS) {
    const source = readFileSync(entry.file, "utf8");
    assert.notEqual(entry.apply(source), source, `${entry.id}: anchor missing in ${entry.file}`);
  }
});

test("each mutation is self-describing and points at real tests", () => {
  const ids = MUTATIONS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const entry of MUTATIONS) {
    assert.ok(entry.why.length > 20, `${entry.id} must say which rule it guards`);
    assert.ok(entry.tests.length > 0, `${entry.id} must name tests`);
    for (const file of entry.tests) assert.ok(existsSync(file), `${entry.id}: missing ${file}`);
  }
});

test("the harness restores before it reports, and refuses a leftover backup", () => {
  const source = readFileSync(new URL("./mutation-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /finally \{\s*\n\s*writeFileSync\(entry\.file, original\)/, "restore runs in finally");
  assert.match(source, /leftover backup/, "a crashed run must be reported, not papered over");
  assert.match(source, /anchor missing: the mutation changed nothing/, "an inapplicable mutation is a harness error");
});