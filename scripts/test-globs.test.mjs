/**
 * `npm test` only runs the roots its command line names, so a test file written
 * outside them never runs and nobody notices — the suite stays green while the
 * assertion sits unused. This pins the contract from both sides: the script
 * still carries every root, and no `.test.mjs` lives outside them.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = process.cwd();
const TEST_ROOTS = ["app", "bin", "lib", "scripts", "components", "hooks", "relay", "relay-shell", "public"];
/** Directories that hold generated output or fixtures, never test sources. */
const SKIP = new Set(["node_modules", ".next", ".git", "demo", "src-tauri", "desktop", "assets", "Casks", "docs"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".test.mjs") || entry.name.endsWith(".test.ts")) out.push(relative(root, path));
  }
  return out;
}

test("the test script still names every root this guard expects", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const script = String(pkg.scripts?.test ?? "");
  for (const dir of TEST_ROOTS) {
    assert.ok(script.includes(`"${dir}/**/*.test.mjs"`), `npm test no longer runs ${dir}/**`);
  }
});

test("no test file lives outside the roots npm test runs", () => {
  const strays = walk(root).filter((path) => !TEST_ROOTS.includes(path.split(/[\\/]/)[0]));
  assert.deepEqual(strays, [], `move these under a test root or they never run: ${strays.join(", ")}`);
});

test("the roots are directories, so a rename cannot silently empty a glob", () => {
  for (const dir of TEST_ROOTS) {
    assert.ok(statSync(join(root, dir)).isDirectory(), `${dir} is not a directory`);
  }
});
