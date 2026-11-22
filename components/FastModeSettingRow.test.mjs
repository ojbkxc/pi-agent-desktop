import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

// jiti mirrors the app's resolution (`@/…`, extensionless imports), which plain
// node ESM does not: the helper imports the preset list through the alias.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { fastModePresetLabelKey, readFastModePresetPayload } = await jiti.import("./fast-mode-row-helpers.ts");

test("a known preset is read as-is", () => {
  for (const preset of ["off", "conservative", "standard"]) {
    assert.equal(readFastModePresetPayload({ preset }), preset);
  }
});

test("an unknown or missing preset reads as off, never as a mode the user did not pick", () => {
  for (const payload of [
    {},
    { preset: "turbo" },
    { preset: 1 },
    { preset: null },
    null,
    undefined,
    "standard",
    [],
  ]) {
    assert.equal(readFastModePresetPayload(payload), "off", JSON.stringify(payload));
  }
});

test("every preset has its own label key", () => {
  const keys = ["off", "conservative", "standard"].map((preset) => fastModePresetLabelKey(preset));
  assert.deepEqual(keys, [
    "settings.fastModeOff",
    "settings.fastModeConservative",
    "settings.fastModeStandard",
  ]);
  assert.equal(new Set(keys).size, 3, "no two presets share a label");
});

test("the row renders all three presets and uses the shared helpers", () => {
  const source = readFileSync(new URL("./FastModeSettingRow.tsx", import.meta.url), "utf8");
  assert.match(source, /FAST_MODE_PRESET_IDS\.map\(/, "the buttons come from the id list, not a copy");
  assert.match(source, /readFastModePresetPayload/, "payload handling is the tested helper");
  assert.match(source, /fastModePresetLabelKey/, "labels go through the helper, so a new preset cannot ship unlabelled");
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /useServerSetting/, "the server round trip is shared with the boolean rows");
  // The rollback is the reducer's job now; it must exist there, once, for every row.
  const machine = readFileSync(new URL("./server-setting-machine.ts", import.meta.url), "utf8");
  assert.match(machine, /value: state\.previous/, "a failed save rolls back to the confirmed value");
});
