import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isLeanMode, writeLeanMode, LEAN_TOOL_NAMES, LEAN_RESOURCE_LOADER_OPTIONS } =
  await jiti.import("./lean-mode.ts");
const { PRESET_FULL } = await jiti.import("./tool-presets.ts");

/** Pi Web's own settings file, in a throwaway agent dir. */
async function withSettings(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-lean-mode-"));
  const path = join(dir, "pi-web", "settings.json");
  await mkdir(dirname(path), { recursive: true });
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

test("lean mode is off until it is switched on", async () => {
  await withSettings(async (path) => {
    assert.equal(isLeanMode(path), false, "a missing settings file reads as off");
    assert.equal(writeLeanMode(true, path), true);
    assert.equal(isLeanMode(path), true);
    assert.equal(writeLeanMode(false, path), false);
    assert.equal(isLeanMode(path), false);
  });
});

test("switching lean mode leaves Pi Web's other preferences alone", async () => {
  await withSettings(async (path) => {
    await writeFile(path, JSON.stringify({ version: 1, artifactsPrompt: false }));
    writeLeanMode(true, path);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      artifactsPrompt: false,
      leanMode: true,
    });
  });
});

test("a damaged settings file reads as off, not as on", async () => {
  await withSettings(async (path) => {
    await writeFile(path, "{not json");
    // Lean removes real capability, so a file we cannot read must not silently enable it
    // (the opposite of the artifacts prompt, where a wrong "on" costs one paragraph).
    assert.equal(isLeanMode(path), false);
  });
});

test("lean keeps the built-in coding tools and drops every other resource", () => {
  assert.deepEqual([...LEAN_TOOL_NAMES], [...PRESET_FULL]);
  assert.deepEqual(LEAN_RESOURCE_LOADER_OPTIONS, {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    // The one place lean differs from chat-only, which keeps context files.
    noContextFiles: true,
  });
});
