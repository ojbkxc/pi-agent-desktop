import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CONCRETE_TOOL_PRESET_VALUES,
  CONFIGURED_TOOL_PRESET,
  DEFAULT_NEW_SESSION_TOOL_PRESET,
  TOOL_PRESET_VALUES,
  PRESET_DEFAULT,
  PRESET_FULL,
  PRESET_FULL_MODIFIERS,
  PRESET_NONE,
  PRESET_READ_ONLY,
  getPresetFromToolNames,
  getPresetFromTools,
  getToolNamesForPreset,
  isConcreteToolPreset,
  isToolPreset,
} = await jiti.import("./tool-presets.ts");

const BUILTIN_NAMES = ["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"];

function toolEntries(activeNames, customNames = []) {
  const active = new Set(activeNames);
  return [...BUILTIN_NAMES, ...customNames].map((name) => ({
    name,
    description: name,
    active: active.has(name),
  }));
}

test("maps every tool preset to its built-in tools", () => {
  assert.deepEqual(getToolNamesForPreset("none"), PRESET_NONE);
  assert.deepEqual(getToolNamesForPreset("read-only"), PRESET_READ_ONLY);
  assert.deepEqual(getToolNamesForPreset("default"), PRESET_DEFAULT);
  // 需求3: "full" sends +name modifiers, not the bare allowlist — the whitelist
  // form switched MCP/extension tools off, the modifier form only adds.
  assert.deepEqual(getToolNamesForPreset("full"), PRESET_FULL_MODIFIERS);
  assert.deepEqual(PRESET_FULL_MODIFIERS, ["+bash", "+read", "+edit", "+write", "+grep", "+find", "+ls"]);
  assert.deepEqual(PRESET_READ_ONLY, ["read", "grep", "find", "ls"]);
});

test("the SDK accepts the full preset's modifier list (requirement evidence)", async () => {
  // Measured against the SDK's own validator — not inferred from source: a
  // pure modifier list is a valid `--tools`/tools shape, and mixing it with
  // bare names is not.
  const { getToolListError } = await import(
    "file:///C:/GitHub/pi-agent-desktop/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js"
  );
  assert.equal(getToolListError(PRESET_FULL_MODIFIERS), undefined);
  assert.match(
    getToolListError([...PRESET_FULL_MODIFIERS, "read"]),
    /cannot be mixed/,
  );
});

test("modifiers force the default four built-ins open to all seven (requirement evidence)", async () => {
  // applyToolModifiers is what agent-session applies to settings defaultTools:
  // even when defaultTools resolves to the SDK's own 4-tool default, "full"
  // must end up with all 7 built-ins active.
  const { applyToolModifiers, DEFAULT_TOOL_NAMES } = await import(
    "file:///C:/GitHub/pi-agent-desktop/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js"
  );
  assert.deepEqual(DEFAULT_TOOL_NAMES.sort(), [...PRESET_DEFAULT].sort());
  const merged = applyToolModifiers([...DEFAULT_TOOL_NAMES], [...PRESET_FULL_MODIFIERS]);
  assert.deepEqual([...merged].sort(), [...PRESET_FULL].sort());
});

test("recognizes presets while ignoring active custom tools", () => {
  const customNames = ["web_search", "delegate"];

  assert.equal(getPresetFromTools(toolEntries([], customNames)), "none");
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_READ_ONLY, ...customNames], customNames)),
    "read-only",
  );
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_DEFAULT, ...customNames], customNames)),
    "default",
  );
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_FULL, ...customNames], customNames)),
    "full",
  );
});

test("returns fresh tool arrays that callers can safely modify", () => {
  const names = getToolNamesForPreset("read-only");
  names.push("custom");
  assert.deepEqual(getToolNamesForPreset("read-only"), PRESET_READ_ONLY);
});

test("recognizes PowerShell as the shell in standard presets", () => {
  assert.equal(
    getPresetFromTools(toolEntries(["read", "powershell", "edit", "write"])),
    "default",
  );
  assert.equal(
    getPresetFromTools(toolEntries(["powershell", "read", "edit", "write", "grep", "find", "ls"])),
    "full",
  );
});

test("the configured preset stands for \"no explicit override\"", () => {
  // Undefined is what makes callers omit toolNames, so pi resolves defaultTools (#700).
  assert.equal(getToolNamesForPreset(CONFIGURED_TOOL_PRESET), undefined);
  assert.equal(CONFIGURED_TOOL_PRESET, "configured");

  assert.ok(isToolPreset(CONFIGURED_TOOL_PRESET));
  assert.ok(!isConcreteToolPreset(CONFIGURED_TOOL_PRESET));
  assert.deepEqual(
    TOOL_PRESET_VALUES.filter((preset) => !CONCRETE_TOOL_PRESET_VALUES.includes(preset)),
    [CONFIGURED_TOOL_PRESET],
  );

  // Every concrete preset still resolves to a real tool list.
  for (const preset of CONCRETE_TOOL_PRESET_VALUES) {
    assert.ok(Array.isArray(getToolNamesForPreset(preset)), preset);
  }
});

test("new chats default to the full preset (需求3)", () => {
  assert.equal(DEFAULT_NEW_SESSION_TOOL_PRESET, "full");
});

test("an active tool set never maps back to the configured preset", () => {
  for (const tools of [PRESET_NONE, PRESET_READ_ONLY, PRESET_DEFAULT, PRESET_FULL, ["read", "grep"]]) {
    assert.ok(isConcreteToolPreset(getPresetFromToolNames(tools)), tools.join(","));
  }
});
