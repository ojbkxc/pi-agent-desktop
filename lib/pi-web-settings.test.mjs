import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { readConfiguredServerPort, piWebSettingsPath } = require("../bin/pi-web-settings.js");

function tempEnv(settings) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-settings-"));
  mkdirSync(join(dir, "pi-web"), { recursive: true });
  if (settings !== undefined) writeFileSync(join(dir, "pi-web", "settings.json"), settings);
  return { dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir } };
}

test("launcher reads the Settings-UI port and never throws", (t) => {
  const cases = [
    [JSON.stringify({ version: 1, serverPort: 41234 }), 41234],
    [JSON.stringify({ version: 1, serverPort: 80 }), null],
    [JSON.stringify({ version: 1 }), null],
    ["{not json", null],
    [undefined, null],
  ];
  for (const [contents, expected] of cases) {
    const { dir, env } = tempEnv(contents);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(readConfiguredServerPort(env), expected, String(contents));
  }
});

test("settings path honours PI_CODING_AGENT_DIR", () => {
  const { dir, env } = tempEnv();
  try {
    assert.equal(piWebSettingsPath(env), join(dir, "pi-web", "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
