import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";
import { findInstallMismatches, summarizeMismatches } from "./check-installed-deps.mjs";

const lock = {
  packages: {
    "node_modules/sdk": { version: "1.3.0" },
    "node_modules/tool": { version: "2.0.0", dev: true },
    "node_modules/native-mac": { version: "1.0.0", optional: true },
  },
};
const pkg = {
  dependencies: { sdk: "^1.3.0" },
  devDependencies: { tool: "^2.0.0" },
  optionalDependencies: { "native-mac": "1.0.0", "not-in-lock": "1.0.0" },
};

test("a matching install reports nothing", () => {
  const installed = { sdk: "1.3.0", tool: "2.0.0", "native-mac": "1.0.0" };
  assert.deepEqual(findInstallMismatches({ pkg, lock, readInstalledVersion: (n) => installed[n] ?? null }), []);
});

test("a stale or missing dependency is reported with both versions", () => {
  const installed = { sdk: "1.1.0" };
  assert.deepEqual(findInstallMismatches({ pkg, lock, readInstalledVersion: (n) => installed[n] ?? null }), [
    { name: "sdk", expected: "1.3.0", installed: "1.1.0" },
    { name: "tool", expected: "2.0.0", installed: null },
  ]);
});

test("a missing optional dependency is not a mismatch, a wrong version still is", () => {
  const installed = { sdk: "1.3.0", tool: "2.0.0", "native-mac": "0.9.0" };
  assert.deepEqual(findInstallMismatches({ pkg, lock, readInstalledVersion: (n) => installed[n] ?? null }), [
    { name: "native-mac", expected: "1.0.0", installed: "0.9.0" },
  ]);
});

test("this checkout's node_modules matches its lockfile", () => {
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  execFileSync(process.execPath, ["scripts/check-installed-deps.mjs"], { cwd: rootDir, stdio: "pipe" });
});

test("mismatches are split into missing and drifted, because they need different actions", () => {
  assert.deepEqual(
    summarizeMismatches([
      { name: "a", expected: "1.0.0", installed: null },
      { name: "b", expected: "2.0.0", installed: "2.1.0" },
      { name: "c", expected: "3.0.0", installed: null },
    ]),
    { missing: 2, drift: 1, total: 3 },
  );
  assert.deepEqual(summarizeMismatches([]), { missing: 0, drift: 0, total: 0 });
});

test("the failure names the escape hatch without weakening the exit code", () => {
  const source = readFileSync(new URL("./check-installed-deps.mjs", import.meta.url), "utf8");
  assert.match(source, /npm test --ignore-scripts/, "a partial install says how to run the suite now");
  assert.match(source, /process\.exitCode = 1/, "the check still fails");
});
