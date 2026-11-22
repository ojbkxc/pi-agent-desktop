/**
 * Check that node_modules matches package-lock.json for every direct
 * dependency. A stale install (a worktree created before an SDK bump, a branch
 * switch without `npm ci`) makes the suite fail for reasons that are not in the
 * code: after the pi SDK 1.3.0 bump, a node_modules still on 1.1.0 failed the
 * `enabled-models-runtime` tests, which pin 1.3 behaviour.
 *
 *   node scripts/check-installed-deps.mjs
 *
 * Runs before `npm test` (the `pretest` script). Exits 1 with the mismatches.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/**
 * @param {{ pkg: object, lock: object, readInstalledVersion: (name: string) => string | null }} input
 * @returns {{ name: string, expected: string, installed: string | null }[]}
 */
export function findInstallMismatches({ pkg, lock, readInstalledVersion }) {
  const names = new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));
  const mismatches = [];
  for (const name of [...names].sort()) {
    const entry = lock.packages?.[`node_modules/${name}`];
    // Not in the lock (e.g. an optional dependency for another platform).
    if (!entry?.version) continue;
    const installed = readInstalledVersion(name);
    if (installed === entry.version) continue;
    if (installed === null && entry.optional) continue;
    mismatches.push({ name, expected: entry.version, installed });
  }
  return mismatches;
}

/**
 * Split the mismatches into the two cases that need different actions: a package
 * that is not installed at all, and one installed at another version. The first
 * is what a partial install looks like (`npm ci --omit=dev`, an interrupted
 * install); the second is a real drift that can change behaviour.
 */
export function summarizeMismatches(mismatches) {
  const missing = mismatches.filter((entry) => entry.installed === null).length;
  return { missing, drift: mismatches.length - missing, total: mismatches.length };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const mismatches = findInstallMismatches({
    pkg: readJson(join(rootDir, "package.json")),
    lock: readJson(join(rootDir, "package-lock.json")),
    readInstalledVersion: (name) => {
      try {
        return readJson(join(rootDir, "node_modules", name, "package.json")).version ?? null;
      } catch {
        return null;
      }
    },
  });
  if (mismatches.length === 0) return;
  const { missing, drift } = summarizeMismatches(mismatches);
  console.error("node_modules does not match package-lock.json:");
  for (const { name, expected, installed } of mismatches) {
    console.error(`  ${name}: lock ${expected}, installed ${installed ?? "(missing)"}`);
  }
  // The two cases are not the same problem; saying so here is what turns a wall
  // into a next step, without weakening the exit code.
  console.error(`\n${missing} not installed, ${drift} at another version.`);
  console.error("Run `npm ci` to reinstall from the lockfile.");
  if (missing > 0) {
    console.error(
      "To run the suite before reinstalling: `npm test --ignore-scripts` (skips this check only; "
        + "tests that import a missing package will still fail).",
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
