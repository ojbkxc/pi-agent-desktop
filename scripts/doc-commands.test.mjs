import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The docs tell the reader to run these flags. A flag that throws, or one that
 * exits non-zero on an empty machine, is a documented instruction that does not
 * work — worse than no docs. Each is spawned exactly as written, against an empty
 * sessions root, so the assertion is "it answers", not "the numbers look right".
 */
const FLAGS = [
  ["--tools"],
  ["--steps"],
  ["--by-preset"],
  ["--ab"],
  ["--ab-plan"],
  ["--all"],
  ["--last"],
  ["--compare", "2026-11-22T00:00:00Z"],
  ["--tools", "--json"],
];

test("every documented measure flag runs and exits 0 on an empty root", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-doc-commands-"));
  try {
    for (const args of FLAGS) {
      const run = spawnSync(
        process.execPath,
        ["scripts/measure-turns.mjs", ...args, "--root", root],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, `${args.join(" ")} exited ${run.status}: ${run.stderr}`);
      assert.ok((run.stdout ?? "").trim().length > 0, `${args.join(" ")} printed nothing`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The acceptance command spawns its own `node --test`. Inside a test process that
 * inherits the runner's environment, the nested run refuses to start ("run() is being
 * called recursively"), so the child gets a clean environment — the same one a person
 * in a terminal would have.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST") || key === "NODE_OPTIONS") delete env[key];
  }
  return env;
}

test("the documented fast-mode flags exist in the scripts they name", () => {
  const check = spawnSync(process.execPath, ["scripts/check-fast-mode.mjs", "--json"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(check.status, 0, check.stderr);
  const parsed = JSON.parse(check.stdout);
  assert.equal(parsed.ok, true, "the acceptance command reports ok as json");

  const live = spawnSync(process.execPath, ["scripts/check-fast-mode.mjs", "--live", "--json"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(live.status, 0, live.stderr);
  const report = JSON.parse(live.stdout);
  for (const key of ["agentDir", "preset", "entries", "verdict", "steps"]) {
    assert.ok(key in report, `--live json must carry ${key}`);
  }
});