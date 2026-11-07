// Guard: every browser spec in the `test:e2e` chain must pin the UI language
// through e2e/helpers/locale.mjs.
//
// Why this exists: hooks/useI18n.tsx#readInitialLocale reads only the stored
// `pi-locale` preference and ignores the browser language, so a spec that relies
// on `browser.newContext({ locale })` alone silently pins nothing. When the
// default locale last changed (en -> zh-CN), the specs that assert English
// strings broke — and a file-level "does this file import the helper" glance
// missed both a *partially* pinned spec (title-feedback.mjs pinned only one of
// its two contexts) and a *helper* module (missing-workspace.mjs created its own
// context). Reading package.json + the files themselves closes both holes at the
// point a new spec is added, instead of waiting for CI e2e to go red.
//
// It runs under `npm test` (scripts/**/*.test.mjs). It never launches a browser.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eDir = join(root, "e2e");
const helpersDir = join(e2eDir, "helpers");
const localeHelper = join(helpersDir, "locale.mjs");

const read = (file) => readFileSync(file, "utf8");
const inE2e = (file) => file === e2eDir || file.startsWith(e2eDir + sep);
const isE2eModule = (file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs");

/** Spec paths listed in the `test:e2e` script (a single "&&" chain). */
function testE2eSpecs() {
  const script = JSON.parse(read(join(root, "package.json"))).scripts?.["test:e2e"];
  assert.ok(script, "package.json must define a test:e2e script");
  const specs = script.split("&&")
    .map((command) => command.trim().split(/\s+/).find((token) => token.endsWith(".mjs")))
    .filter(Boolean);
  assert.ok(specs.length > 0, "test:e2e must list at least one browser spec");
  return specs;
}

/** The spec plus every local e2e module it imports, transitively. */
function localClosure(spec) {
  const seen = new Set();
  const queue = [resolve(root, spec)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!inE2e(file) || !isE2eModule(file) || seen.has(file)) continue;
    seen.add(file);
    for (const match of read(file).matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      queue.push(resolve(dirname(file), match[1]));
    }
  }
  return seen;
}

const count = (source, pattern) => (source.match(pattern) ?? []).length;
// A browser-level page or context needs its own pin; pages derived from a pinned
// context are already covered.
const rootCount = (source) => count(source, /\bbrowser\s*\.\s*new(?:Page|Context)\s*\(/g);
const pinCount = (source) => count(source, /\bpinLocale\s*\(/g);

test("every test:e2e spec exists and pins the UI language", () => {
  for (const spec of testE2eSpecs()) {
    const file = resolve(root, spec);
    assert.ok(existsSync(file), `test:e2e lists a missing spec: ${spec}`);
    const source = read(file);
    assert.match(source, /\bpinLocale\b/, `${spec} must pin the UI language via e2e/helpers/locale.mjs`);
  }
});

test("every page/context opened by a test:e2e spec (or its helper) is pinned", () => {
  for (const spec of testE2eSpecs()) {
    for (const file of localClosure(spec)) {
      const source = read(file);
      const roots = rootCount(source);
      const pins = pinCount(source);
      assert.ok(
        pins >= roots,
        `${file.split(sep).join("/").replace(`${root.split(sep).join("/")}/`, "")} opens ${roots} page/context(es) but pins ${pins}; `
        + `call pinLocale(pageOrContext, locale) from e2e/helpers/locale.mjs for each one`
      );
    }
  }
});

test("no e2e file writes the pi-locale preference by hand", () => {
  const offenders = [...readdirSync(e2eDir).filter((name) => name.endsWith(".mjs")).map((name) => join(e2eDir, name))]
    .concat(readdirSync(helpersDir).filter((name) => name.endsWith(".mjs")).map((name) => join(helpersDir, name)))
    .filter((file) => file !== localeHelper)
    .filter((file) => /["'`]pi-locale["'`]/.test(read(file)));
  assert.deepEqual(offenders, [], `pin the language through e2e/helpers/locale.mjs instead of writing pi-locale directly: ${offenders.join(", ")}`);
});
