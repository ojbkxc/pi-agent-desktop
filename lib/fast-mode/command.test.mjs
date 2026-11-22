import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { describeFastMode, fastModeCompletions, parseFastModeArgs } = await jiti.import("./command.ts");
const { resolveFastModeConfig } = await jiti.import("./guidance.ts");

test("no argument asks for status", () => {
  for (const args of ["", "   ", undefined, null, 42]) {
    assert.equal(parseFastModeArgs(args).kind, "status");
  }
});

test("a preset id sets it, case and spacing included", () => {
  assert.deepEqual(parseFastModeArgs("standard"), { kind: "set", preset: "standard" });
  assert.deepEqual(parseFastModeArgs("  CONSERVATIVE "), { kind: "set", preset: "conservative" });
  assert.deepEqual(parseFastModeArgs("off now"), { kind: "set", preset: "off" });
});

test("anything else is an error that names the choices", () => {
  const parsed = parseFastModeArgs("turbo");
  assert.equal(parsed.kind, "error");
  assert.match(parsed.message, /off, conservative, standard/);
});

test("status names the preset and the switches that are on", () => {
  assert.equal(
    describeFastMode(resolveFastModeConfig("off")),
    "Fast mode: off (none). Prompt-side only; the model, reasoning level and tools are untouched.",
  );
  assert.match(describeFastMode(resolveFastModeConfig("conservative")), /conservative \(brevity\)/);
  assert.match(
    describeFastMode(resolveFastModeConfig("standard")),
    /standard \(brevity, verifyFirst, actFirst, changeApproach\)/,
  );
});

test("completions list presets and go quiet on no match", () => {
  assert.deepEqual(
    fastModeCompletions("").map((item) => item.value),
    ["off", "conservative", "standard"],
  );
  assert.deepEqual(fastModeCompletions("con").map((item) => item.value), ["conservative"]);
  assert.equal(fastModeCompletions("zzz"), null);
});

test("the command writes the preset the settings row reads back", async () => {
  const { createFastModeExtension } = await jiti.import("./extension.ts");
  const { readFastModeConfig, writeFastModeConfig } = await jiti.import("./settings.ts");
  const dir = mkdtempSync(join(tmpdir(), "pi-web-fast-command-"));
  const settingsPath = join(dir, "settings.json");
  try {
    const commands = new Map();
    const handlers = [];
    const extension = createFastModeExtension(
      () => readFastModeConfig(settingsPath),
      (next) => writeFastModeConfig(next, settingsPath),
    );
    await extension.factory({
      on: (name, handler) => handlers.push([name, handler]),
      registerCommand: (name, options) => commands.set(name, options),
    });
    assert.ok(commands.has("fast"));
    const command = commands.get("fast");
    const notes = [];
    const ctx = { ui: { notify: (message, level) => notes.push([message, level]) } };

    await command.handler("standard", ctx);
    assert.equal(readFastModeConfig(settingsPath).preset, "standard");
    assert.match(notes.at(-1)[0], /Fast mode: standard/);
    assert.equal(notes.at(-1)[1], "info");

    await command.handler("", ctx);
    assert.match(notes.at(-1)[0], /Fast mode: standard/);

    await command.handler("nope", ctx);
    assert.equal(notes.at(-1)[1], "warning");

    writeFastModeConfig({ preset: "off" }, settingsPath);
    assert.equal(readFastModeConfig(settingsPath).preset, "off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
