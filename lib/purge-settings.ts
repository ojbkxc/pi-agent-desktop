import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";
import {
  PURGE_AUTO_PRESET_MATCHES,
  PURGE_AUTO_PRESET_MODES,
  PURGE_LIMITS,
  PURGE_THINKING_FLOORS,
  defaultPurgeSettings,
  type PurgeAutoPresetMatch,
  type PurgeAutoPresetMode,
  type PurgeRewriteRule,
  type PurgeSettings,
  type PurgeTemplate,
  type PurgeThinkingFloor,
} from "./purge/types";

/**
 * Read/write the Purge Console settings, stored under the `purge` key of Pi Web's
 * own settings file (see `lib/artifact-settings.ts`). The key keeps the feature
 * out of pi's `settings.json`, which the CLI and other hosts also read.
 *
 * Every read is tolerant: a missing file, damaged JSON, or a wrong field type
 * falls back to the default for that field instead of throwing, because the
 * console must still render when the file was hand-edited into a bad state.
 */

const SETTINGS_KEY = "purge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function floorOr(value: unknown, fallback: PurgeThinkingFloor): PurgeThinkingFloor {
  return (PURGE_THINKING_FLOORS as readonly unknown[]).includes(value)
    ? value as PurgeThinkingFloor
    : fallback;
}

/**
 * Rewrite rules: only items that are objects with a non-empty trimmed `from`
 * survive. `to` is optional — an editor that saves a half-typed rule keeps the
 * row with an empty `to` instead of losing what the operator already typed.
 */
function rulesOr(value: unknown, fallback: PurgeRewriteRule[]): PurgeRewriteRule[] {
  if (!Array.isArray(value)) return fallback;
  const rules: PurgeRewriteRule[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.from !== "string") continue;
    const from = item.from.trim();
    if (!from) continue;
    rules.push({ from, to: typeof item.to === "string" ? item.to.trim() : "" });
  }
  return rules;
}

/** Line prefixes: trimmed, empty strings dropped. */
function prefixesOr(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const prefixes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const prefix = item.trim();
    if (!prefix) continue;
    prefixes.push(prefix);
  }
  return prefixes;
}

function skillDirOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const dir = value.trim();
  return dir || fallback;
}

/** An unlimited suffix: any string, including the empty one that disables the append. */
function suffixOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/**
 * Named structured templates. A template needs a non-empty trimmed name; its
 * text is kept verbatim (a preset body starts with a newline or a `#` often
 * enough that trimming it here would silently change the prompt). A duplicate
 * name is folded onto the first one — the name is the identity, so the later
 * row wins, matching the upsert the preset action performs.
 */
function templatesOr(value: unknown, fallback: PurgeTemplate[]): PurgeTemplate[] {
  if (!Array.isArray(value)) return fallback;
  const templates: PurgeTemplate[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const name = item.name.trim();
    if (!name) continue;
    const text = typeof item.text === "string" ? item.text : "";
    const existing = templates.findIndex((template) => template.name === name);
    if (existing >= 0) templates[existing] = { name, text };
    else templates.push({ name, text });
  }
  return templates;
}

/** The active template name; anything but a string reads as "no active template". */
function activeTemplateOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** 自动套用的拼接方式；不认识的值一律退回默认的「前插」。 */
function autoPresetModeOr(value: unknown, fallback: PurgeAutoPresetMode): PurgeAutoPresetMode {
  return (PURGE_AUTO_PRESET_MODES as readonly unknown[]).includes(value)
    ? value as PurgeAutoPresetMode
    : fallback;
}

/** 自动套用的匹配强度；只有显式写了 `vendor` 才会退到厂商兜底。 */
function autoPresetMatchOr(value: unknown, fallback: PurgeAutoPresetMatch): PurgeAutoPresetMatch {
  return (PURGE_AUTO_PRESET_MATCHES as readonly unknown[]).includes(value)
    ? value as PurgeAutoPresetMatch
    : fallback;
}

/** 固定预设 id：去空白，其余原样（id 由目录校验，不在这里猜）。 */
function autoPresetIdOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function skillInjectLimitOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const { min, max } = PURGE_LIMITS.skill_inject_limit;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Tolerant normalization: only the known fields are kept (a typo never lands in
 * the settings file), each field falls back to its default when malformed, and
 * numbers are clamped into range.
 */
export function normalizePurgeSettings(input: unknown): PurgeSettings {
  const defaults = defaultPurgeSettings();
  if (!isRecord(input)) return defaults;
  return {
    enabled: boolOr(input.enabled, defaults.enabled),
    system_normalize: boolOr(input.system_normalize, defaults.system_normalize),
    dead_zone_rewrite: boolOr(input.dead_zone_rewrite, defaults.dead_zone_rewrite),
    synonym_enabled: boolOr(input.synonym_enabled, defaults.synonym_enabled),
    reduce_reasoning: boolOr(input.reduce_reasoning, defaults.reduce_reasoning),
    skill_inject: boolOr(input.skill_inject, defaults.skill_inject),
    structured_prompt: boolOr(input.structured_prompt, defaults.structured_prompt),
    reasoning_floor: floorOr(input.reasoning_floor, defaults.reasoning_floor),
    rewrite_rules: rulesOr(input.rewrite_rules, defaults.rewrite_rules),
    synonym_pairs: rulesOr(input.synonym_pairs, defaults.synonym_pairs),
    normalize_strip_prefixes: prefixesOr(input.normalize_strip_prefixes, defaults.normalize_strip_prefixes),
    skill_dir: skillDirOr(input.skill_dir, defaults.skill_dir),
    skill_inject_limit: skillInjectLimitOr(input.skill_inject_limit, defaults.skill_inject_limit),
    structured_suffix: suffixOr(input.structured_suffix, defaults.structured_suffix),
    structured_templates: templatesOr(input.structured_templates, defaults.structured_templates),
    active_template: activeTemplateOr(input.active_template, defaults.active_template),
    auto_preset: boolOr(input.auto_preset, defaults.auto_preset),
    auto_preset_mode: autoPresetModeOr(input.auto_preset_mode, defaults.auto_preset_mode),
    auto_preset_match: autoPresetMatchOr(input.auto_preset_match, defaults.auto_preset_match),
    auto_preset_id: autoPresetIdOr(input.auto_preset_id, defaults.auto_preset_id),
  };
}

/** The effective settings. An unreadable file (or a damaged `purge` block) reads as the defaults. */
export function readPurgeSettings(settingsPath = getPiWebSettingsPath()): PurgeSettings {
  try {
    return normalizePurgeSettings(readStored(settingsPath)[SETTINGS_KEY]);
  } catch {
    return defaultPurgeSettings();
  }
}

/**
 * Replace the stored settings with the normalized input and return what the next
 * read will see. Every other key in the file is left untouched.
 */
export function writePurgeSettings(
  input: unknown,
  settingsPath = getPiWebSettingsPath(),
): PurgeSettings {
  const settings = normalizePurgeSettings(input);
  updatePiWebSettings({ [SETTINGS_KEY]: settings }, settingsPath);
  return readPurgeSettings(settingsPath);
}
