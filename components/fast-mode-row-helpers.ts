/**
 * The pure half of `FastModeSettingRow`: what a server payload means and which
 * i18n key labels a preset. Kept out of the component so it can be tested
 * without a renderer, the way `settings-ui-helpers.ts` is.
 */
import { FAST_MODE_PRESET_IDS } from "@/lib/fast-mode/presets";

export type FastModePresetId = (typeof FAST_MODE_PRESET_IDS)[number];

/**
 * A GET/PUT payload's `preset`. Anything unrecognised reads as `off`: an
 * unreadable answer must not light up a mode the user did not choose, and the
 * server's own default is `off` too.
 */
export function readFastModePresetPayload(data: unknown): FastModePresetId {
  if (typeof data !== "object" || data === null) return "off";
  const preset = (data as { preset?: unknown }).preset;
  return typeof preset === "string" && (FAST_MODE_PRESET_IDS as readonly string[]).includes(preset)
    ? (preset as FastModePresetId)
    : "off";
}

/** The settings-row label for each preset, in the order the buttons render. */
export function fastModePresetLabelKey(preset: FastModePresetId): string {
  switch (preset) {
    case "off":
      return "settings.fastModeOff";
    case "conservative":
      return "settings.fastModeConservative";
    default:
      return "settings.fastModeStandard";
  }
}
