/**
 * `/fast` — the one-line way to change fast mode without opening Settings.
 *
 * Parsing and wording live here, apart from the extension, so both are tested
 * without an SDK: the command handler only writes the setting and notifies.
 * Text is English because the server cannot know the browser's locale (the same
 * reason `lib/agent-guide-extension.ts` ships English).
 */
import { FAST_MODE_PRESET_IDS } from "./presets";
import type { FastModeConfig, FastModePreset } from "./guidance";

export const FAST_MODE_COMMAND_NAME = "fast";

export type FastModeArgs =
  | { kind: "status" }
  | { kind: "set"; preset: FastModePreset }
  | { kind: "error"; message: string };

/** `""` → status; a preset id (any case) → set; anything else → an error naming the options. */
export function parseFastModeArgs(raw: unknown): FastModeArgs {
  const args = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!args) return { kind: "status" };
  const first = args.split(/\s+/)[0];
  if ((FAST_MODE_PRESET_IDS as readonly string[]).includes(first)) {
    return { kind: "set", preset: first as FastModePreset };
  }
  return { kind: "error", message: `Unknown fast mode "${first}". Use: off, conservative, standard.` };
}

const SWITCH_ORDER = ["brevity", "verifyFirst", "actFirst", "changeApproach"] as const;

function switchSummary(config: FastModeConfig): string {
  const on = SWITCH_ORDER.filter((key) => config.switches[key]);
  return on.length ? on.join(", ") : "none";
}

/** The status line `/fast` prints, and the confirmation after a change. */
export function describeFastMode(config: FastModeConfig): string {
  return `Fast mode: ${config.preset} (${switchSummary(config)}). Prompt-side only; the model, reasoning level and tools are untouched.`;
}

/** Argument completions for `/fast` — preset ids only. */
export function fastModeCompletions(prefix: string): { value: string; label: string }[] | null {
  const needle = prefix.trim().toLowerCase();
  const items = FAST_MODE_PRESET_IDS.map((id) => ({ value: id, label: id }));
  const filtered = items.filter((item) => item.value.startsWith(needle));
  return filtered.length ? filtered : null;
}
