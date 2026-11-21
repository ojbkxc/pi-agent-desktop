/**
 * Built-in purge presets: search, detail and the two "apply" landing points.
 *
 * The catalog itself is generated (`preset-catalog.ts`, from
 * `scripts/sync-purge-presets.mjs`); this module is the read/apply layer on top
 * of it. Pure functions only — `applyPreset` is the single place that may touch
 * the filesystem, and only for the `skill_file` target.
 *
 * The preset text is third-party public research material: it is served
 * verbatim. Nothing here filters, rewrites or judges it, and applying one is a
 * deliberate operator action — the only automatic path is the explicit
 * `auto_preset` switch, and it lives in `auto-apply.ts`, never here.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "./governance";
import { BUILTIN_PRESETS, type BuiltinPreset } from "./preset-catalog";
import { presetMatchForModel, type PresetMatch } from "./preset-match";
import type { PurgeSettings } from "./types";

/** Default page size for `listPresets`. */
export const DEFAULT_PRESET_LIMIT = 50;
/** Hard cap, so a client cannot ask for the whole catalog body by accident. */
export const MAX_PRESET_LIMIT = 500;
/** Preview length in code points (never bytes — this must not split a surrogate pair). */
export const PREVIEW_CHARS = 200;

export interface PresetSummary {
  id: string;
  vendor: string;
  model: string;
  title: string;
  tags: string[];
  bytes: number;
  preview: string;
  /**
   * 当前模型与该预设目标模型的匹配强度。
   *
   * 仅当调用方传了 `model` 时出现：不传就没有这个字段，默认响应逐字节不变。
   * 它只用于让面板把「写给这个模型的」标出来，不参与排序（目录原序是面板顺序的唯一真源）。
   */
  modelMatch?: PresetMatch;
}

export interface PresetDetail extends PresetSummary {
  body: string;
}

export interface PresetVendorCount {
  vendor: string;
  count: number;
}

/** Query for one page of the catalog. `undefined` / blank means "no filter". */
export interface PresetListOptions {
  q?: string;
  vendor?: string;
  limit?: number;
  /**
   * 当前模型标识。给了就在每一项上附 `modelMatch`；不给就什么也不变。
   * 它不筛选、不重排、不做任何动作 —— 只是把匹配结果告诉调用方。
   */
  model?: string;
}

/** One page plus the facets the panel renders around it. */
export interface PresetListPage {
  items: PresetSummary[];
  vendors: PresetVendorCount[];
  /** Matches before `limit` truncates `items`, so the panel can say "50 of 53". */
  total: number;
}

/** Where an applied preset lands. */
export type PresetApplyTarget = "structured_template" | "skill_file";

export interface PresetApplyResult {
  target: PresetApplyTarget;
  changed: boolean;
  /** Template name, for `structured_template`. */
  template?: string;
  /** Written file path, for `skill_file`. */
  path?: string;
}

/** Thrown when an id is not in the catalog; the API turns it into a 404. */
export class PresetNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown preset: ${id}`);
    this.name = "PresetNotFoundError";
  }
}

const VALID_TARGETS: readonly PresetApplyTarget[] = ["structured_template", "skill_file"];

export function isPresetApplyTarget(value: unknown): value is PresetApplyTarget {
  return typeof value === "string" && (VALID_TARGETS as readonly string[]).includes(value);
}

/** A slug is used as a directory name, so it has a hard whitelist. */
function isSafeSegment(segment: string): boolean {
  if (!segment) return false;
  if (Buffer.byteLength(segment, "utf8") > 128) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(segment);
}

/**
 * Code-point safe prefix of the prompt body.
 *
 * Two details are deliberate: `Array.from` rather than `slice`, so a surrogate pair
 * is never cut in half; and no ellipsis, so the preview is a true prefix of the body
 * the detail endpoint returns (`body.startsWith(preview)` holds, and the panel can
 * highlight or align against it without special-casing a tail).
 */
export function previewOf(body: string): string {
  // UTF-16 length is never below the code-point count, so short bodies return before
  // the array allocation — the common case for this catalog is still one pass.
  if (body.length <= PREVIEW_CHARS) return body;
  return Array.from(body).slice(0, PREVIEW_CHARS).join("");
}

function toSummary(preset: BuiltinPreset, model?: string): PresetSummary {
  const summary: PresetSummary = {
    id: preset.id,
    vendor: preset.vendor,
    model: preset.model,
    title: preset.title,
    // Copied, not borrowed: the catalog's arrays are module constants, and a caller
    // that sorts or clears the tags it was handed must not corrupt the catalog.
    tags: [...preset.tags],
    bytes: preset.bytes,
    preview: previewOf(preset.body),
  };
  // 只在调用方问了「当前模型」时才加这个字段：默认响应逐字节不变。
  if (typeof model === "string" && model.trim()) {
    summary.modelMatch = presetMatchForModel(preset, model);
  }
  return summary;
}

function normalizeLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_PRESET_LIMIT;
  const floored = Math.floor(limit);
  if (floored <= 0) return DEFAULT_PRESET_LIMIT;
  return Math.min(floored, MAX_PRESET_LIMIT);
}

function matchesQuery(preset: BuiltinPreset, needle: string): boolean {
  if (needle.length === 0) return true;
  if (preset.id.toLowerCase().includes(needle)) return true;
  if (preset.vendor.toLowerCase().includes(needle)) return true;
  if (preset.model.toLowerCase().includes(needle)) return true;
  if (preset.title.toLowerCase().includes(needle)) return true;
  return preset.tags.some((tag) => tag.toLowerCase().includes(needle));
}

/**
 * Search one catalog.
 *
 * `total` is the number of matches *before* `limit` truncates `items`, so the
 * panel can render "showing 50 of 53". `vendors` is counted over the query
 * matches only: it is the vendor filter's own facet, so narrowing by vendor
 * must not collapse the other chips to zero.
 *
 * Items keep the catalog's own order: the generator sorts by (vendor, model, id)
 * case-insensitively, and re-sorting here would make the panel's order depend on
 * two different collations. Paging is therefore a stable prefix of that order.
 * A `model` option adds `modelMatch` to each item and changes nothing else — not
 * the order, not the page, not the facets.
 */
export function listPresetPage(
  catalog: readonly BuiltinPreset[],
  options: PresetListOptions = {},
): PresetListPage {
  const needle = typeof options.q === "string" ? options.q.trim().toLowerCase() : "";
  const vendorFilter = typeof options.vendor === "string" ? options.vendor.trim().toLowerCase() : "";

  const searched = catalog.filter((preset) => matchesQuery(preset, needle));

  // Facets merge case-insensitively (first spelling wins), matching how `vendor`
  // filters: two catalog rows spelled "xAI" / "xai" are one chip, not two.
  const counts = new Map<string, PresetVendorCount>();
  for (const preset of searched) {
    const key = preset.vendor.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { vendor: preset.vendor, count: 1 });
  }
  const vendors = [...counts.values()].sort((a, b) =>
    a.vendor.toLowerCase().localeCompare(b.vendor.toLowerCase()),
  );

  const filtered = vendorFilter
    ? searched.filter((preset) => preset.vendor.toLowerCase() === vendorFilter)
    : searched;

  const limit = normalizeLimit(options.limit);
  return {
    items: filtered.slice(0, limit).map((preset) => toSummary(preset, options.model)),
    vendors,
    total: filtered.length,
  };
}

/** One page of the built-in catalog (the API route's entry point). */
export function listPresets(options: PresetListOptions = {}): PresetListPage {
  return listPresetPage(BUILTIN_PRESETS, options);
}

/** One preset with its full body, or `undefined` when the id is unknown. */
export function getPresetDetail(
  catalog: readonly BuiltinPreset[],
  id: string,
): PresetDetail | undefined {
  const preset = catalog.find((entry) => entry.id === id);
  if (!preset) return undefined;
  return { ...toSummary(preset), body: preset.body };
}

/**
 * One preset from the built-in catalog (the detail route's entry point).
 *
 * `sha256` deliberately stays server-side: the catalog test is what proves the
 * body was not re-encoded, and shipping a fingerprint to the panel would only
 * invite the UI to re-verify what the server already verified.
 */
export function getPreset(id: string): PresetDetail | undefined {
  return getPresetDetail(BUILTIN_PRESETS, id);
}

/** The SKILL.md a `skill_file` apply writes. */
function renderSkillFile(preset: BuiltinPreset): string {
  const description = (preset.tags.length > 0 ? `预设标签：${preset.tags.join("、")}` : "破甲预设")
    .replace(/\r?\n/g, " ");
  return [
    "---",
    `name: ${preset.title}`,
    `description: ${description}`,
    `keywords: ${preset.tags.join(", ")}`,
    "---",
    "",
    preset.body,
  ].join("\n");
}

/**
 * Apply a preset to one of the two landing points.
 *
 * - `structured_template` upserts into `settings.structured_templates` by
 *   template name (the preset title), so re-applying is idempotent. It only
 *   mutates the object it was handed: persisting stays the caller's decision.
 * - `skill_file` writes `<skill_dir>/<id>/SKILL.md` and leaves the settings
 *   untouched; the next skill scan picks it up.
 */
export function applyPreset(
  settings: PurgeSettings,
  id: string,
  target: PresetApplyTarget,
  activate = false,
): PresetApplyResult {
  return applyPresetTo(BUILTIN_PRESETS, settings, id, target, activate);
}

/** `changed` is "this call actually modified something", not "it succeeded". */
export function applyPresetTo(
  catalog: readonly BuiltinPreset[],
  settings: PurgeSettings,
  id: string,
  target: PresetApplyTarget,
  activate = false,
): PresetApplyResult {
  const preset = catalog.find((entry) => entry.id === id);
  if (!preset) throw new PresetNotFoundError(id);

  if (target === "structured_template") {
    const templates = Array.isArray(settings.structured_templates)
      ? settings.structured_templates
      : [];
    const name = preset.title;
    const existing = templates.findIndex((template) => template.name === name);
    const next = { name, text: preset.body };
    let contentChanged = true;
    if (existing >= 0) {
      contentChanged = templates[existing].text !== next.text;
      templates[existing] = next;
    } else {
      templates.push(next);
    }
    settings.structured_templates = templates;
    const activateChanged = activate && settings.active_template !== name;
    if (activate) settings.active_template = name;
    return { target, changed: contentChanged || activateChanged, template: name };
  }

  if (!isSafeSegment(preset.id)) {
    throw new Error(`preset id is not a safe path segment: ${preset.id}`);
  }
  const root = typeof settings.skill_dir === "string" ? expandHome(settings.skill_dir) : "";
  if (root.length === 0) throw new Error("skill_dir is empty");
  const dir = join(root, preset.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const content = renderSkillFile(preset);
  const previous = readTextOrUndefined(path);
  writeFileSync(path, content, "utf8");
  return { target, changed: previous !== content, path };
}

/** An unreadable or missing file is "no previous content", never an error. */
function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
