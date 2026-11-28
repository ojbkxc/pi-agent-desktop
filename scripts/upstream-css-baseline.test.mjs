import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  UPSTREAM_CSS_FILES,
  hashCss,
  hashWorkingCss,
  readUpstreamCssBaseline,
} from "./upstream-css-baseline.mjs";

const baseline = await readUpstreamCssBaseline();

test("the baseline records every upstream stylesheet and nothing else", () => {
  assert.ok(baseline.upstreamRef, "upstreamRef must name the pi-web commit the hashes came from");
  assert.deepEqual(Object.keys(baseline.files).sort(), [...UPSTREAM_CSS_FILES].sort());
});

for (const path of UPSTREAM_CSS_FILES) {
  test(`${path} stays byte-identical to pi-web ${baseline.upstreamRef}`, async () => {
    assert.equal(
      await hashWorkingCss(path),
      baseline.files[path],
      `${path} differs from upstream pi-web ${baseline.upstreamRef}. Fork styling belongs in ` +
        "app/native-theme.css (see docs/native-theme.md): move the rule there and restore " +
        `the file with \`git checkout ${baseline.upstreamRef} -- ${path}\` (fetch pi-web-upstream first). ` +
        "If you just merged upstream, run `node scripts/upstream-css-baseline.mjs update <upstream-ref>`.",
    );
  });
}

test("hashing ignores CRLF checkouts", () => {
  assert.equal(hashCss("a {\r\n  color: red;\r\n}\r\n"), hashCss("a {\n  color: red;\n}\n"));
});

// Regression for the Windows entry guard. `import.meta.url` is `file:///C:/…`
// (three slashes, forward slashes, percent-encoded), so the old
// `file://${process.argv[1]}` comparison silently never matched on Windows and
// the `update` command became a no-op with no error (styles-absorber had to call
// the exported function directly). The guard now compares against
// pathToFileURL(resolve(argv[1])).href, the form Node actually reports.
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "upstream-css-baseline.mjs");

test("the self-referential file URL uses the absolute file:/// form the guard expects", () => {
  const selfUrl = pathToFileURL(resolve(scriptPath)).href;
  assert.equal(selfUrl, pathToFileURL(scriptPath).href);
  assert.match(selfUrl, /^file:\/\/\//, "must be file:///…, never the broken file://<path> form");
  if (process.platform === "win32") {
    // The drive-letter backslash path cannot equal the URL Node reports.
    assert.notEqual(`file://${scriptPath}`, pathToFileURL(scriptPath).href);
  }
});

test("the CLI entry actually runs (no args prints usage and exits 2, not a silent exit 0)", () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.equal(
    result.status,
    2,
    `expected the CLI guard to fire and exit 2 with a usage error; got status ${result.status} ` +
      `(a silent 0 on Windows means the entry guard failed to match). stderr=${result.stderr}`,
  );
  assert.match(result.stderr, /Usage: node scripts\/upstream-css-baseline\.mjs update/);
});

