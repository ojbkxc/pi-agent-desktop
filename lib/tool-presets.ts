export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  /** Active, but left out of requests: the model calls it only from codemode scripts. */
  declarationHidden?: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
  sourceInfo?: unknown;
}

/** Presets that pin an explicit tool list onto the session. */
export const CONCRETE_TOOL_PRESET_VALUES = ["none", "read-only", "default", "full"] as const;
export type ConcreteToolPreset = typeof CONCRETE_TOOL_PRESET_VALUES[number];

/**
 * "configured" is not a tool list: it means "send no override", so pi resolves the
 * loadout from settings.json defaultTools exactly like the `pi` CLI does. Sessions
 * left on it stay unpinned and keep following the setting as it changes.
 */
export const CONFIGURED_TOOL_PRESET = "configured";
export const TOOL_PRESET_VALUES = ["configured", "none", "read-only", "default", "full"] as const;
export type ToolPreset = typeof TOOL_PRESET_VALUES[number];

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ["read", "grep", "find", "ls"];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
/** The built-in tool names "full" covers. Parsing/normalization only — see PRESET_FULL_MODIFIERS. */
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

/**
 * "full" sent to the SDK as `+name` modifiers (需求3): force every built-in tool
 * open *on top of* settings.json defaultTools instead of pinning the session to
 * this allowlist. The old whitelist form switched every tool outside the list
 * off, so newly installed MCP/extension tools came up dead until re-pinned;
 * modifier entries leave them to the SDK's registration rule
 * (`_isActivatedOnRegistration`, defaultActive !== false), which keeps them
 * active by default. #700's "never snapshot a tool list" core survives; what it
 * chose as the default (configured = follow defaultTools) is superseded by the
 * user's call that a new chat starts with everything on.
 */
export const PRESET_FULL_MODIFIERS: readonly string[] = PRESET_FULL.map((name) => `+${name}`);

/** New chats start with everything on (需求3); chats follow settings via "configured". */
export const DEFAULT_NEW_SESSION_TOOL_PRESET: ToolPreset = "full";

const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function isConcreteToolPreset(value: unknown): value is ConcreteToolPreset {
  return typeof value === "string" && (CONCRETE_TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function getPresetFromTools(tools: ToolEntry[]): ConcreteToolPreset {
  const activeTools = tools.filter((t) => t.active);
  return getPresetFromToolNames(activeTools.map((tool) => tool.name));
}

export function getPresetFromToolNames(toolNames: readonly string[]): ConcreteToolPreset {
  if (toolNames.length === 0) return "none";

  const active = toolNames
    .map((name) => name === "powershell" ? "bash" : name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (active === [...PRESET_READ_ONLY].sort().join(",")) return "read-only";
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

/** Undefined means "no explicit selection": let pi resolve settings.json defaultTools. */
export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {
  if (preset === CONFIGURED_TOOL_PRESET) return undefined;
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "read-only") return [...PRESET_READ_ONLY];
  if (preset === "full") return [...PRESET_FULL_MODIFIERS];
  return [...PRESET_DEFAULT];
}
