/**
 * `/api/fast-mode` contract, at two levels: the pure patch validator (so every
 * 400 is pinned without HTTP) and the real handlers behind the real security
 * gate (403 / 415 / 200), with `PI_CODING_AGENT_DIR` pointed at a temp agent dir
 * so no user settings are touched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Before any route import: getAgentDir() reads this on every request.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-fast-mode-route-agent-"));

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { normalizeFastModePatch, readFastModeConfig, writeFastModeConfig } = await jiti.import(
  "@/lib/fast-mode/settings.ts",
);
const { resolveFastModeConfig } = await jiti.import("@/lib/fast-mode/guidance.ts");
const route = await jiti.import("@/app/api/fast-mode/route.ts");

const ENDPOINT = "http://127.0.0.1:30141/api/fast-mode";

function request({ method = "PUT", origin = "http://127.0.0.1:30141", contentType = "application/json", body = {} } = {}) {
  return new Request(ENDPOINT, {
    method,
    headers: { "content-type": contentType, origin, host: "127.0.0.1:30141" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

test.after(() => rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true }));


function tempSettings() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-fast-mode-api-"));
  const path = join(dir, "settings.json");
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a preset patch replaces the preset", () => {
  const next = normalizeFastModePatch({ preset: "standard" }, resolveFastModeConfig("off"));
  assert.equal(next.preset, "standard");
});

test("a switches-only patch keeps the stored preset and merges overrides", () => {
  const next = normalizeFastModePatch(
    { switches: { changeApproach: false } },
    resolveFastModeConfig("standard"),
  );
  assert.equal(next.preset, "standard");
  assert.equal(next.switches.changeApproach, false);
  assert.equal(next.switches.brevity, true);
});

test("unknown presets and non-boolean switches are rejected with a 400-grade message", () => {
  for (const body of [
    { preset: "turbo" },
    { switches: { brevity: "yes" } },
    { switches: [] },
    [],
    null,
    "standard",
  ]) {
    assert.throws(
      () => normalizeFastModePatch(body, resolveFastModeConfig("off")),
      /must be|body must/,
      JSON.stringify(body),
    );
  }
});

test("GET reads the default preset from the agent dir", async () => {
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { preset: "off", switches: resolveFastModeConfig("off").switches });
});

test("PUT behind the real gate stores the preset and GET reads it back", async () => {
  const put = await route.PUT(request({ body: { preset: "standard" } }));
  assert.equal(put.status, 200);
  assert.equal((await put.json()).preset, "standard");
  assert.equal((await (await route.GET()).json()).preset, "standard");
  assert.equal(readFastModeConfig().preset, "standard", "the file agrees with the response");
});

test("the gate answers 403 for a foreign origin and 415 for a non-JSON body", async () => {
  const foreign = await route.PUT(request({ origin: "http://evil.example", body: { preset: "off" } }));
  assert.equal(foreign.status, 403);
  const wrongType = await route.PUT(request({ contentType: "text/plain", body: {} }));
  assert.equal(wrongType.status, 415);
  assert.equal(readFastModeConfig().preset, "standard", "a refused write changes nothing");
});

test("a bad preset through the handler is a 400, not a 500", async () => {
  const bad = await route.PUT(request({ body: { preset: "turbo" } }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /off", "conservative" or "standard/);
});

test("the route writes what the panel reads back, without dropping other settings keys", () => {
  const { path, cleanup } = tempSettings();
  try {
    writeFileSync(path, JSON.stringify({ artifactsPrompt: false, shellPath: "/bin/bash" }));
    writeFastModeConfig(normalizeFastModePatch({ preset: "standard" }, readFastModeConfig(path)), path);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(stored.fastMode.preset, "standard");
    assert.equal(stored.artifactsPrompt, false, "unrelated keys survive the write");
    assert.equal(stored.shellPath, "/bin/bash");
    assert.equal(readFastModeConfig(path).switches.changeApproach, true);
  } finally {
    cleanup();
  }
});
