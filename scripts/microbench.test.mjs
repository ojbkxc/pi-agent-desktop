import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { BENCHES, evaluate } from "./microbench.mjs";

/**
 * The microbenchmark is a claim about cost, so it needs its own guard: the limits
 * must stay finite where they matter, and `evaluate` must actually flag a breach
 * (a pass-through evaluator would make the whole script decorative).
 */
test("every bench declares an id, a label and a finite limit or an explicit null", () => {
  const ids = BENCHES.map((bench) => bench.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const bench of BENCHES) {
    assert.ok(bench.label.length > 0, `${bench.id} needs a label`);
    assert.ok(bench.limitUs === null || bench.limitUs > 0, `${bench.id} limit must be a positive number or null`);
    assert.ok(bench.iterations >= 100, `${bench.id} needs enough iterations to mean something`);
  }
  assert.ok(BENCHES.some((bench) => bench.limitUs === null), "at least one informational bench (cache miss)");
});

test("evaluate flags exactly the benches over their limit", () => {
  const results = [
    { id: "a", perCallUs: 1, limitUs: 5 },
    { id: "b", perCallUs: 9, limitUs: 5 },
    { id: "c", perCallUs: 9999, limitUs: null },
  ];
  assert.deepEqual(evaluate(results).map((result) => result.id), ["b"], "an informational bench never fails");
  assert.deepEqual(evaluate([]), []);
});

test("the script runs clean and reports every bench as json", () => {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/microbench.mjs", "--json"],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.over.length, 0, "a regression would name the bench");
  assert.equal(parsed.results.length, BENCHES.length);
  for (const result of parsed.results) {
    assert.ok(Number.isFinite(result.perCallUs) && result.perCallUs >= 0, `${result.id} must report a number`);
  }
});