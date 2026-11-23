"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { PurgePresetLibrary, upsertPresetTemplate } from "./PurgePresetLibrary";
import { PurgeGateLogSection } from "./PurgeGateLogSection";
import { PurgePreviewPanel } from "./PurgePreviewPanel";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

export type PurgeReasoningFloor = "off" | "low" | "medium" | "high" | "xhigh";

/** 自动套用时预设文本落在宿主提示词的哪一侧。 */
export type PurgeAutoPresetMode = "prepend" | "append";

/** 自动套用允许的匹配强度：只认同名模型，或退到同厂商。 */
export type PurgeAutoPresetMatch = "exact" | "vendor";

/** One rewrite row: the text an incoming request contains, and what it is replaced with. */
export interface PurgeRule {
  from: string;
  to: string;
}

/** One named structured template; a preset lands here as `{ name: title, text: body }`. */
export interface PurgeTemplate {
  name: string;
  text: string;
}

/**
 * The wire shape of the purge console settings (`GET`/`PUT /api/purge`).
 *
 * Declared here on purpose instead of imported from `lib/purge/types.ts`: this
 * section must render (and be testable) before that module lands. The field
 * names are the contract — they are sent to the server verbatim — so any change
 * here has to change there in the same commit.
 */
export interface PurgeSettings {
  /** Master switch: off means plain passthrough, nothing is judged or rewritten. */
  enabled: boolean;
  system_normalize: boolean;
  dead_zone_rewrite: boolean;
  synonym_enabled: boolean;
  reduce_reasoning: boolean;
  skill_inject: boolean;
  structured_prompt: boolean;
  reasoning_floor: PurgeReasoningFloor;
  rewrite_rules: PurgeRule[];
  synonym_pairs: PurgeRule[];
  normalize_strip_prefixes: string[];
  skill_dir: string;
  skill_inject_limit: number;
  structured_suffix: string;
  /** Named templates the preset library can drop into; the name is the identity. */
  structured_templates: PurgeTemplate[];
  /** Template `structured_prompt` appends; empty means `structured_suffix`. */
  active_template: string;
  /** 按当前模型自动套用破甲预设：开则每次请求现查预设库。 */
  auto_preset: boolean;
  /** 预设正文前插还是后附在宿主提示词上。 */
  auto_preset_mode: PurgeAutoPresetMode;
  /** `exact` 只认同名模型，`vendor` 允许退到同厂商。 */
  auto_preset_match: PurgeAutoPresetMatch;
  /** 固定套用的预设 id；空串表示按模型自动匹配。 */
  auto_preset_id: string;
}

/** Counter snapshot: cumulative since the process started, never reset per request. */
export interface PurgeStats {
  requests: number;
  rewrite_hits: number;
  synonym_hits: number;
  skill_hits: number;
  reasoning_clamps: number;
  structured_appends: number;
  auto_preset_hits: number;
  started_at: string;
}

/** The process the counters belong to; `uptime_secs` is how long it has been up. */
export interface PurgeRuntime {
  pid: number;
  uptime_secs: number;
}

/**
 * `GET /api/purge/auto-preset` 的回答：本机默认模型下，自动套用会挑中哪一条。
 *
 * 面板只拿它做一行提示，不参与任何判定 —— 真正的套用在服务端的每个请求里发生。
 */
export interface PurgeAutoPresetPreview {
  model: string | null;
  active: boolean;
  preset: { id: string; title: string; vendor: string; model: string; match: string } | null;
}

/**
 * The seven governance switches, master first, in the order the console shows
 * them. They are exactly the boolean fields of `PurgeSettings`, so the render
 * can index the settings object with a key from this list.
 */
export const PURGE_TOGGLE_KEYS = [
  "enabled",
  "system_normalize",
  "dead_zone_rewrite",
  "synonym_enabled",
  "reduce_reasoning",
  "skill_inject",
  "structured_prompt",
] as const;

export type PurgeToggleKey = (typeof PURGE_TOGGLE_KEYS)[number];

/** Label and one-line explanation per switch; one i18n key each, no inline prose. */
export const PURGE_TOGGLE_LABEL_KEYS: Record<PurgeToggleKey, string> = {
  enabled: "purge.toggleEnabled",
  system_normalize: "purge.toggleSystemNormalize",
  dead_zone_rewrite: "purge.toggleDeadZoneRewrite",
  synonym_enabled: "purge.toggleSynonymEnabled",
  reduce_reasoning: "purge.toggleReduceReasoning",
  skill_inject: "purge.toggleSkillInject",
  structured_prompt: "purge.toggleStructuredPrompt",
};

export const PURGE_TOGGLE_HINT_KEYS: Record<PurgeToggleKey, string> = {
  enabled: "purge.toggleEnabledHint",
  system_normalize: "purge.toggleSystemNormalizeHint",
  dead_zone_rewrite: "purge.toggleDeadZoneRewriteHint",
  synonym_enabled: "purge.toggleSynonymEnabledHint",
  reduce_reasoning: "purge.toggleReduceReasoningHint",
  skill_inject: "purge.toggleSkillInjectHint",
  structured_prompt: "purge.toggleStructuredPromptHint",
};

export const PURGE_REASONING_FLOORS: readonly PurgeReasoningFloor[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const PURGE_REASONING_FLOOR_LABEL_KEYS: Record<PurgeReasoningFloor, string> = {
  off: "purge.floorOff",
  low: "purge.floorLow",
  medium: "purge.floorMedium",
  high: "purge.floorHigh",
  xhigh: "purge.floorXHigh",
};

/** 自动套用的两种拼接方式，顺序即面板按钮顺序。 */
export const PURGE_AUTO_PRESET_MODES: readonly PurgeAutoPresetMode[] = ["prepend", "append"];

export const PURGE_AUTO_PRESET_MODE_LABEL_KEYS: Record<PurgeAutoPresetMode, string> = {
  prepend: "purge.autoModePrepend",
  append: "purge.autoModeAppend",
};

/** 自动套用的两种匹配强度，顺序即面板按钮顺序（默认第一个）。 */
export const PURGE_AUTO_PRESET_MATCHES: readonly PurgeAutoPresetMatch[] = ["exact", "vendor"];

export const PURGE_AUTO_PRESET_MATCH_LABEL_KEYS: Record<PurgeAutoPresetMatch, string> = {
  exact: "purge.autoMatchExact",
  vendor: "purge.autoMatchVendor",
};

/** The range `PUT /api/purge` clamps `skill_inject_limit` to. */
export const PURGE_SKILL_INJECT_LIMIT_MIN = 16;
export const PURGE_SKILL_INJECT_LIMIT_MAX = 20_000;

/**
 * What the form shows before the first `GET` answers — and what it falls back to
 * for any field a response leaves out. Every control stays disabled until a load
 * succeeds, so these values never reach the server.
 */
export const DEFAULT_PURGE_SETTINGS: PurgeSettings = {
  // 与 lib/purge/types.ts 的默认值一致：总闸打开、自动套用打开。
  enabled: true,
  system_normalize: false,
  dead_zone_rewrite: false,
  synonym_enabled: false,
  reduce_reasoning: false,
  skill_inject: false,
  structured_prompt: false,
  reasoning_floor: "low",
  rewrite_rules: [],
  synonym_pairs: [],
  normalize_strip_prefixes: [],
  skill_dir: "",
  // Mirrors `defaultPurgeSettings()` in lib/purge/types.ts, so a malformed or
  // blank draft falls back to the value the server would store.
  skill_inject_limit: 2000,
  structured_suffix: "",
  structured_templates: [],
  active_template: "",
  // 与 lib/purge/types.ts 的默认值一致：自动套用默认打开（仍受总闸约束），
  // 拼接默认前插，匹配默认精确。
  auto_preset: true,
  auto_preset_mode: "prepend",
  auto_preset_match: "exact",
  auto_preset_id: "",
};

/** Counter rows of the read-only block, in render order. */
const PURGE_STAT_ROWS: readonly { labelKey: string; pick: (stats: PurgeStats) => number }[] = [
  { labelKey: "purge.statRequests", pick: (stats) => stats.requests },
  { labelKey: "purge.statRewriteHits", pick: (stats) => stats.rewrite_hits },
  { labelKey: "purge.statSynonymHits", pick: (stats) => stats.synonym_hits },
  { labelKey: "purge.statSkillHits", pick: (stats) => stats.skill_hits },
  { labelKey: "purge.statReasoningClamps", pick: (stats) => stats.reasoning_clamps },
  { labelKey: "purge.statStructuredAppends", pick: (stats) => stats.structured_appends },
  { labelKey: "purge.statAutoPresetHits", pick: (stats) => stats.auto_preset_hits },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBoolean(raw: unknown): boolean {
  return raw === true;
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function asCount(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

/** Anything but one of the five tiers reads as the default tier. */
export function asReasoningFloor(raw: unknown): PurgeReasoningFloor {
  return typeof raw === "string" && (PURGE_REASONING_FLOORS as readonly string[]).includes(raw)
    ? (raw as PurgeReasoningFloor)
    : DEFAULT_PURGE_SETTINGS.reasoning_floor;
}

/** 不认识的拼接方式读作默认的「前插」，与服务器归一化同一规则。 */
export function asAutoPresetMode(raw: unknown): PurgeAutoPresetMode {
  return typeof raw === "string" && (PURGE_AUTO_PRESET_MODES as readonly string[]).includes(raw)
    ? (raw as PurgeAutoPresetMode)
    : DEFAULT_PURGE_SETTINGS.auto_preset_mode;
}

/** 不认识的匹配强度读作默认的「精确」，绝不把 `vendor` 当成默认兜底。 */
export function asAutoPresetMatch(raw: unknown): PurgeAutoPresetMatch {
  return typeof raw === "string" && (PURGE_AUTO_PRESET_MATCHES as readonly string[]).includes(raw)
    ? (raw as PurgeAutoPresetMatch)
    : DEFAULT_PURGE_SETTINGS.auto_preset_match;
}

/**
 * An integer inside the supported range, otherwise the default — the same rule
 * the server applies (`clamp(16, 20_000)`), plus the string branch the number
 * input's draft needs (`""`, `"12abc"` and `"1e9"` all have to land somewhere).
 */
export function clampSkillInjectLimit(raw: unknown): number {
  // A blank draft is "no value yet", not zero: it falls back to the default
  // instead of clamping up to the minimum.
  if (typeof raw === "string" && raw.trim() === "") return DEFAULT_PURGE_SETTINGS.skill_inject_limit;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PURGE_SETTINGS.skill_inject_limit;
  return Math.min(PURGE_SKILL_INJECT_LIMIT_MAX, Math.max(PURGE_SKILL_INJECT_LIMIT_MIN, Math.round(value)));
}

/**
 * Trimmed rows with an empty-`from` row dropped — the normalization the API
 * applies before it writes (`rulesOr` in lib/purge-settings.ts). A row the user
 * added but never filled in therefore never reaches the server. The list is not
 * capped: the API keeps every row, so truncating here would lose data.
 */
export function normalizePurgeRules(raw: unknown): PurgeRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: PurgeRule[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const from = asString(item.from).trim();
    if (from === "") continue;
    rules.push({ from, to: asString(item.to).trim() });
  }
  return rules;
}

/** Trimmed non-empty prefixes, like the server's `prefixesOr` (uncapped). */
export function normalizePrefixList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const prefixes: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const prefix = item.trim();
    if (prefix === "") continue;
    prefixes.push(prefix);
  }
  return prefixes;
}

/**
 * Named structured templates, trimmed names and duplicate-folded (the same rule
 * as `templatesOr` in lib/purge-settings.ts). The body is kept verbatim: a preset
 * starting with a blank line or a `#` would otherwise be silently reworded.
 */
export function normalizePurgeTemplates(raw: unknown): PurgeTemplate[] {
  if (!Array.isArray(raw)) return [];
  const templates: PurgeTemplate[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = asString(item.name).trim();
    if (name === "") continue;
    const text = asString(item.text);
    const existing = templates.findIndex((template) => template.name === name);
    if (existing >= 0) templates[existing] = { name, text };
    else templates.push({ name, text });
  }
  return templates;
}

/** The comma/whitespace separated input mirror of `normalize_strip_prefixes`. */
export function splitPurgePrefixes(value: string): string[] {
  return normalizePrefixList(value.split(/[,，\s]+/));
}

/** The input mirror's initial value from the stored list. */
export function joinPurgePrefixes(list: readonly string[]): string {
  return list.join(", ");
}

/** One toggle flipped, everything else untouched. */
export function setPurgeToggle(
  settings: PurgeSettings,
  key: PurgeToggleKey,
  value: boolean,
): PurgeSettings {
  // The seven keys are exactly the boolean fields, so the computed key is sound.
  return { ...settings, [key]: value } as PurgeSettings;
}

export function addPurgeRule(rules: readonly PurgeRule[]): PurgeRule[] {
  return [...rules, { from: "", to: "" }];
}

export function patchPurgeRule(
  rules: readonly PurgeRule[],
  index: number,
  part: Partial<PurgeRule>,
): PurgeRule[] {
  return rules.map((rule, position) => (position === index ? { ...rule, ...part } : rule));
}

export function removePurgeRule(rules: readonly PurgeRule[], index: number): PurgeRule[] {
  return rules.filter((_, position) => position !== index);
}

/** The counter block's rows with their numbers resolved (kept pure for the test). */
export function purgeStatValues(stats: PurgeStats): { labelKey: string; value: number }[] {
  return PURGE_STAT_ROWS.map((row) => ({ labelKey: row.labelKey, value: row.pick(stats) }));
}

/** Uptime in the coarsest useful unit pair, with the caller's unit words. */
export function formatPurgeUptime(
  totalSeconds: number,
  units: { seconds: string; minutes: string; hours: string; days: string },
): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  if (seconds < 60) return `${seconds} ${units.seconds}`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} ${units.minutes}`;
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3_600)} ${units.hours} ${Math.floor((seconds % 3_600) / 60)} ${units.minutes}`;
  }
  return `${Math.floor(seconds / 86_400)} ${units.days}`;
}

/** A `settings` object from any JSON body, every field filled; null when there is none. */
export function asPurgeSettings(raw: unknown): PurgeSettings | null {
  if (!isRecord(raw)) return null;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_PURGE_SETTINGS.enabled,
    system_normalize: asBoolean(raw.system_normalize),
    dead_zone_rewrite: asBoolean(raw.dead_zone_rewrite),
    synonym_enabled: asBoolean(raw.synonym_enabled),
    reduce_reasoning: asBoolean(raw.reduce_reasoning),
    skill_inject: asBoolean(raw.skill_inject),
    structured_prompt: asBoolean(raw.structured_prompt),
    reasoning_floor: asReasoningFloor(raw.reasoning_floor),
    rewrite_rules: normalizePurgeRules(raw.rewrite_rules),
    synonym_pairs: normalizePurgeRules(raw.synonym_pairs),
    normalize_strip_prefixes: normalizePrefixList(raw.normalize_strip_prefixes),
    skill_dir: asString(raw.skill_dir).trim(),
    skill_inject_limit: clampSkillInjectLimit(raw.skill_inject_limit),
    structured_suffix: asString(raw.structured_suffix),
    structured_templates: normalizePurgeTemplates(raw.structured_templates),
    active_template: asString(raw.active_template).trim(),
    auto_preset: typeof raw.auto_preset === "boolean" ? raw.auto_preset : DEFAULT_PURGE_SETTINGS.auto_preset,
    auto_preset_mode: asAutoPresetMode(raw.auto_preset_mode),
    auto_preset_match: asAutoPresetMatch(raw.auto_preset_match),
    auto_preset_id: asString(raw.auto_preset_id).trim(),
  };
}

export function asPurgeStats(raw: unknown): PurgeStats | null {
  if (!isRecord(raw)) return null;
  return {
    requests: asCount(raw.requests),
    rewrite_hits: asCount(raw.rewrite_hits),
    synonym_hits: asCount(raw.synonym_hits),
    skill_hits: asCount(raw.skill_hits),
    reasoning_clamps: asCount(raw.reasoning_clamps),
    structured_appends: asCount(raw.structured_appends),
    auto_preset_hits: asCount(raw.auto_preset_hits),
    started_at: asString(raw.started_at),
  };
}

export function asPurgeRuntime(raw: unknown): PurgeRuntime | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.pid !== "number" || !Number.isFinite(raw.pid)) return null;
  return { pid: Math.trunc(raw.pid), uptime_secs: asCount(raw.uptime_secs) };
}

/** 自动套用预览：拿不到就返回 null，面板显示「预览不可用」而不是编一条。 */
export function asAutoPresetPreview(raw: unknown): PurgeAutoPresetPreview | null {
  if (!isRecord(raw)) return null;
  const preset = isRecord(raw.preset) && typeof raw.preset.id === "string" && typeof raw.preset.title === "string"
    ? {
      id: raw.preset.id,
      title: raw.preset.title,
      vendor: asString(raw.preset.vendor),
      model: asString(raw.preset.model),
      match: asString(raw.preset.match),
    }
    : null;
  return {
    model: typeof raw.model === "string" && raw.model !== "" ? raw.model : null,
    active: raw.active === true,
    preset,
  };
}

/**
 * The `PUT /api/purge` body: the whole settings object, normalized the way the
 * server would — trimmed strings, empty-`from` rows dropped, the limit clamped,
 * the unknown tier replaced. Key order follows the contract, so the request body
 * stays readable in a network log.
 */
export function purgeSavePayload(draft: PurgeSettings): PurgeSettings {
  return {
    enabled: draft.enabled === true,
    system_normalize: draft.system_normalize === true,
    dead_zone_rewrite: draft.dead_zone_rewrite === true,
    synonym_enabled: draft.synonym_enabled === true,
    reduce_reasoning: draft.reduce_reasoning === true,
    skill_inject: draft.skill_inject === true,
    structured_prompt: draft.structured_prompt === true,
    reasoning_floor: asReasoningFloor(draft.reasoning_floor),
    rewrite_rules: normalizePurgeRules(draft.rewrite_rules),
    synonym_pairs: normalizePurgeRules(draft.synonym_pairs),
    normalize_strip_prefixes: normalizePrefixList(draft.normalize_strip_prefixes),
    skill_dir: asString(draft.skill_dir).trim(),
    skill_inject_limit: clampSkillInjectLimit(draft.skill_inject_limit),
    structured_suffix: asString(draft.structured_suffix),
    structured_templates: normalizePurgeTemplates(draft.structured_templates),
    active_template: asString(draft.active_template).trim(),
    auto_preset: draft.auto_preset === true,
    auto_preset_mode: asAutoPresetMode(draft.auto_preset_mode),
    auto_preset_match: asAutoPresetMatch(draft.auto_preset_match),
    auto_preset_id: asString(draft.auto_preset_id).trim(),
  };
}

/** One editable rule table (rewrite rules, synonym pairs). */
function PurgeRulesTable({
  heading,
  hint,
  addLabel,
  emptyLabel,
  columnFrom,
  columnTo,
  columnAction,
  removeLabel,
  rows,
  disabled,
  onAdd,
  onPatch,
  onRemove,
}: {
  heading: string;
  hint: string;
  addLabel: string;
  emptyLabel: string;
  columnFrom: string;
  columnTo: string;
  columnAction: string;
  removeLabel: string;
  rows: readonly PurgeRule[];
  disabled: boolean;
  onAdd: () => void;
  onPatch: (index: number, part: Partial<PurgeRule>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <section className="settings-general-section">
      <div className="settings-purge-section-head">
        <h3 className="settings-general-heading">{heading}</h3>
        <ConfigButton variant="secondary" size="small" disabled={disabled} onClick={onAdd}>
          {addLabel}
        </ConfigButton>
      </div>
      <p className="settings-general-description">{hint}</p>
      {rows.length === 0 ? (
        <p className="settings-purge-empty">{emptyLabel}</p>
      ) : (
        <table className="settings-purge-table">
          <thead>
            <tr>
              <th scope="col">{columnFrom}</th>
              <th scope="col">{columnTo}</th>
              <th scope="col">{columnAction}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((rule, index) => (
              <tr key={index}>
                <td>
                  <input
                    className="settings-chats-control"
                    type="text"
                    aria-label={`${columnFrom} ${index + 1}`}
                    placeholder={columnFrom}
                    value={rule.from}
                    disabled={disabled}
                    onChange={(event) => onPatch(index, { from: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="settings-chats-control"
                    type="text"
                    aria-label={`${columnTo} ${index + 1}`}
                    placeholder={columnTo}
                    value={rule.to}
                    disabled={disabled}
                    onChange={(event) => onPatch(index, { to: event.target.value })}
                  />
                </td>
                <td className="settings-purge-table-action">
                  <ConfigButton
                    variant="ghost"
                    size="small"
                    disabled={disabled}
                    aria-label={`${removeLabel} ${index + 1}`}
                    onClick={() => onRemove(index)}
                  >
                    {removeLabel}
                  </ConfigButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

type PurgeStatus = "idle" | "saved" | "saveFailed" | "loadFailed";

/**
 * Settings › Purge: the armor-piercing gateway in front of every model request.
 *
 * Every control edits local state; one button `PUT`s the whole settings object
 * and the response is the new truth. Nothing here is optimistic and nothing is
 * saved per control — a half-typed rule table must never reach the gateway.
 */
export function PurgeConsoleSection() {
  const { t, locale } = useI18n();
  const limitHintId = useId();
  const [draft, setDraft] = useState<PurgeSettings>(DEFAULT_PURGE_SETTINGS);

  // 默认模型只从 auto-preset 预览里取：一次请求同时给「当前模型」和「将套用哪条」，
  // 两处不会再各读一次文件、也不会出现徽标与预览互相矛盾的时刻。
  const [autoPreview, setAutoPreview] = useState<PurgeAutoPresetPreview | null>(null);
  // 保存后让预览按新设置重算一次（表单本身已经是响应里的值，不必整页重读）。
  const [previewKey, setPreviewKey] = useState(0);
  const [stats, setStats] = useState<PurgeStats | null>(null);
  const [runtime, setRuntime] = useState<PurgeRuntime | null>(null);
  const [limitDraft, setLimitDraft] = useState(String(DEFAULT_PURGE_SETTINGS.skill_inject_limit));
  const [prefixDraft, setPrefixDraft] = useState(joinPurgePrefixes(DEFAULT_PURGE_SETTINGS.normalize_strip_prefixes));
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<PurgeStatus>("idle");
  const [reloadKey, setReloadKey] = useState(0);

  const applySettings = useCallback((next: PurgeSettings) => {
    setDraft(next);
    setLimitDraft(String(next.skill_inject_limit));
    setPrefixDraft(joinPurgePrefixes(next.normalize_strip_prefixes));
  }, []);

  // One read per mount: the stored settings plus the counters since start-up.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/purge", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: unknown) => {
        if (cancelled) return;
        const body = isRecord(data) ? data : {};
        const settings = asPurgeSettings(body.settings);
        if (!settings) {
          setStatus("loadFailed");
          return;
        }
        applySettings(settings);
        setStats(asPurgeStats(body.stats));
        setRuntime(asPurgeRuntime(body.runtime));
        setLoaded(true);
        setDirty(false);
        setStatus("idle");
      })
      .catch(() => { if (!cancelled) setStatus("loadFailed"); });
    return () => { cancelled = true; };
  }, [applySettings, reloadKey]);

  // 预览单独读一次：读失败只是一行「预览不可用」，不影响表单。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/purge/auto-preset", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => { if (!cancelled) setAutoPreview(asAutoPresetPreview(data)); })
      .catch(() => { if (!cancelled) setAutoPreview(null); });
    return () => { cancelled = true; };
  }, [reloadKey, previewKey]);

  const edit = useCallback((next: Partial<PurgeSettings>) => {
    setDraft((current) => ({ ...current, ...next }));
    setDirty(true);
    // A saved note about the previous write must not survive the next edit.
    setStatus((current) => (current === "saved" ? "idle" : current));
  }, []);

  const save = useCallback(() => {
    const payload = purgeSavePayload({
      ...draft,
      skill_inject_limit: clampSkillInjectLimit(limitDraft),
      normalize_strip_prefixes: splitPurgePrefixes(prefixDraft),
    });
    setSaving(true);
    setStatus("idle");
    fetch("/api/purge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: unknown) => {
        // The response is the new truth; a body without settings still means the
        // write landed, so the normalized payload stays on screen instead of the
        // form emptying itself.
        applySettings(asPurgeSettings(isRecord(data) ? data.settings : undefined) ?? payload);
        setDirty(false);
        setStatus("saved");
        // 预览按新设置重算：否则面板会拿着保存前的那一行继续说「将套用 X」。
        setPreviewKey((key) => key + 1);
      })
      .catch(() => setStatus("saveFailed"))
      .finally(() => setSaving(false));
  }, [applySettings, draft, limitDraft, prefixDraft]);

  /**
   * Drop a preset body onto the structured-template draft. No PUT: the operator
   * reviews the draft and hits Save, so a preset can never half-save behind them.
   */
  const applyPresetTemplate = useCallback((name: string, text: string) => {
    edit({ structured_templates: upsertPresetTemplate(draft.structured_templates, name, text) });
  }, [draft.structured_templates, edit]);

  const removeTemplate = useCallback((name: string) => {
    edit({
      structured_templates: draft.structured_templates.filter((template) => template.name !== name),
      // Removing the active one falls back to the default suffix rather than
      // leaving a dangling name that would silently disable the append.
      active_template: draft.active_template === name ? "" : draft.active_template,
    });
  }, [draft.active_template, draft.structured_templates, edit]);

  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const parsedLimit = limitDraft.trim() === "" ? Number.NaN : Number(limitDraft);
  const limitInvalid = !Number.isFinite(parsedLimit);
  const disabled = saving || !loaded;
  const canSave = loaded && !saving && !limitInvalid && dirty;
  const uptime = runtime ? formatPurgeUptime(runtime.uptime_secs, {
    seconds: t("purge.uptimeSeconds"),
    minutes: t("purge.uptimeMinutes"),
    hours: t("purge.uptimeHours"),
    days: t("purge.uptimeDays"),
  }) : "";
  const autoPreviewText = autoPreview === null
    ? t("purge.autoPresetUnavailable")
    : autoPreview.active !== true
      // 开关没开（或总闸关着）时说清楚：这一行不是「即将套用」。
      ? t("purge.autoPresetIdle")
      : autoPreview.preset !== null
        ? t("purge.autoPresetResolved", { model: autoPreview.model ?? "—", title: autoPreview.preset.title })
        : t("purge.autoPresetNone", { model: autoPreview.model ?? "—" });

  return (
    <div className="settings-general settings-purge">
      <h2 className="settings-general-title">{t("purge.title")}</h2>
      <p className="settings-general-description">{t("purge.description")}</p>
      {/* 默认关闭是安全选择，但不说一声会让人以为功能坏了。只提示，不自动打开。 */}
      {!draft.enabled && (
        <p className="settings-general-description settings-purge-off" role="status">
          {t("purge.disabledHint")}
        </p>
      )}

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("purge.togglesHeading")}</h3>
        <div className="settings-option-list">
          {PURGE_TOGGLE_KEYS.map((key) => (
            <div
              key={key}
              className={`settings-option settings-purge-toggle${key === "enabled" ? " is-master" : ""}`}
            >
              <span className="settings-option-text">
                <span className="settings-option-title">{t(PURGE_TOGGLE_LABEL_KEYS[key])}</span>
                <span className="settings-option-hint">{t(PURGE_TOGGLE_HINT_KEYS[key])}</span>
              </span>
              <ConfigSwitch
                checked={draft[key]}
                disabled={disabled}
                label={t(PURGE_TOGGLE_LABEL_KEYS[key])}
                onChange={(next) => edit(setPurgeToggle(draft, key, next))}
              />
            </div>
          ))}
        </div>
        <p className="settings-general-description">{t("purge.masterNote")}</p>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("purge.autoHeading")}</h3>
        <p className="settings-general-description">{t("purge.autoHint")}</p>
        <div className="settings-option-list">
          <div className="settings-option">
            <span className="settings-option-text">
              <span className="settings-option-title">{t("purge.autoEnable")}</span>
              <span className="settings-option-hint">{t("purge.autoEnableHint")}</span>
            </span>
            <ConfigSwitch
              checked={draft.auto_preset}
              disabled={disabled}
              label={t("purge.autoEnable")}
              onChange={(next) => edit({ auto_preset: next })}
            />
          </div>
        </div>
        {/* 拼接方式与匹配强度同思考强度：按钮组平铺，当前值与全部候选一眼可见。 */}
        <div className="settings-purge-floor" role="group" aria-label={t("purge.autoMode")}>
          {PURGE_AUTO_PRESET_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={`settings-purge-floor-btn${draft.auto_preset_mode === mode ? " is-active" : ""}`}
              aria-pressed={draft.auto_preset_mode === mode}
              disabled={disabled}
              onClick={() => edit({ auto_preset_mode: mode })}
            >
              {t(PURGE_AUTO_PRESET_MODE_LABEL_KEYS[mode])}
            </button>
          ))}
        </div>
        <div className="settings-purge-floor" role="group" aria-label={t("purge.autoMatch")}>
          {PURGE_AUTO_PRESET_MATCHES.map((match) => (
            <button
              key={match}
              type="button"
              className={`settings-purge-floor-btn${draft.auto_preset_match === match ? " is-active" : ""}`}
              aria-pressed={draft.auto_preset_match === match}
              disabled={disabled}
              onClick={() => edit({ auto_preset_match: match })}
            >
              {t(PURGE_AUTO_PRESET_MATCH_LABEL_KEYS[match])}
            </button>
          ))}
        </div>
        <div className="settings-purge-field">
          <label htmlFor="settings-purge-auto-preset-id">{t("purge.autoPresetId")}</label>
          <input
            id="settings-purge-auto-preset-id"
            className="settings-chats-control"
            type="text"
            aria-label={t("purge.autoPresetId")}
            placeholder={t("purge.autoPresetIdPlaceholder")}
            value={draft.auto_preset_id}
            disabled={disabled}
            onChange={(event) => edit({ auto_preset_id: event.target.value })}
          />
          <span className="settings-chats-hint">{t("purge.autoPresetIdHint")}</span>
        </div>
        <p className="settings-general-description" role="status">{autoPreviewText}</p>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("purge.reasoningHeading")}</h3>
        <p className="settings-general-description">{t("purge.reasoningFloorHint")}</p>
        {/* 五档全部平铺，一眼看清当前档位与可选档位；旧的下拉要先展开才知道有哪几档。 */}
        <div className="settings-purge-floor" role="group" aria-label={t("purge.reasoningFloor")}>
          {PURGE_REASONING_FLOORS.map((floor) => (
            <button
              key={floor}
              type="button"
              className={`settings-purge-floor-btn${draft.reasoning_floor === floor ? " is-active" : ""}`}
              aria-pressed={draft.reasoning_floor === floor}
              disabled={disabled}
              onClick={() => edit({ reasoning_floor: floor })}
            >
              {t(PURGE_REASONING_FLOOR_LABEL_KEYS[floor])}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("purge.fieldsHeading")}</h3>
        <div className="settings-purge-fields">
          <div className="settings-purge-field">
            <label htmlFor="settings-purge-skill-dir">{t("purge.skillDir")}</label>
            <input
              id="settings-purge-skill-dir"
              className="settings-chats-control"
              type="text"
              aria-label={t("purge.skillDir")}
              placeholder={t("purge.skillDirPlaceholder")}
              value={draft.skill_dir}
              disabled={disabled}
              onChange={(event) => edit({ skill_dir: event.target.value })}
            />
            <span className="settings-chats-hint">{t("purge.skillDirHint")}</span>
          </div>

          <div className="settings-purge-field">
            <label htmlFor="settings-purge-skill-limit">{t("purge.skillInjectLimit")}</label>
            <input
              id="settings-purge-skill-limit"
              className="settings-chats-control"
              type="number"
              inputMode="numeric"
              min={PURGE_SKILL_INJECT_LIMIT_MIN}
              max={PURGE_SKILL_INJECT_LIMIT_MAX}
              step={1}
              aria-label={t("purge.skillInjectLimit")}
              aria-describedby={limitHintId}
              value={limitDraft}
              disabled={disabled}
              onChange={(event) => { setLimitDraft(event.target.value); setDirty(true); }}
            />
            <span id={limitHintId} className="settings-chats-hint" role={limitInvalid ? "alert" : undefined}>
              {limitInvalid
                ? t("purge.skillInjectLimitInvalid", {
                  min: PURGE_SKILL_INJECT_LIMIT_MIN,
                  max: PURGE_SKILL_INJECT_LIMIT_MAX,
                })
                : t("purge.skillInjectLimitHint", {
                  min: PURGE_SKILL_INJECT_LIMIT_MIN,
                  max: PURGE_SKILL_INJECT_LIMIT_MAX,
                })}
            </span>
          </div>

          <div className="settings-purge-field">
            <label htmlFor="settings-purge-prefixes">{t("purge.stripPrefixes")}</label>
            <input
              id="settings-purge-prefixes"
              className="settings-chats-control"
              type="text"
              aria-label={t("purge.stripPrefixes")}
              placeholder={t("purge.stripPrefixesPlaceholder")}
              value={prefixDraft}
              disabled={disabled}
              onChange={(event) => { setPrefixDraft(event.target.value); setDirty(true); }}
            />
            <span className="settings-chats-hint">{t("purge.stripPrefixesHint")}</span>
          </div>

          <div className="settings-purge-field">
            <label htmlFor="settings-purge-structured-suffix">{t("purge.structuredSuffix")}</label>
            <textarea
              id="settings-purge-structured-suffix"
              className="settings-chats-control settings-purge-textarea"
              rows={4}
              aria-label={t("purge.structuredSuffix")}
              value={draft.structured_suffix}
              disabled={disabled}
              onChange={(event) => edit({ structured_suffix: event.target.value })}
            />
            <span className="settings-chats-hint">{t("purge.structuredSuffixHint")}</span>
          </div>
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("purge.presetsTemplatesHeading")}</h3>
        <p className="settings-general-description">{t("purge.presetsActiveTemplateHint")}</p>
        {draft.structured_templates.length === 0 ? (
          <p className="settings-purge-empty">{t("purge.presetsTemplatesEmpty")}</p>
        ) : (
          <>
            {/* 平铺成按钮组而不是原生下拉：与思考强度档位一致，一眼看清当前模板与全部候选。 */}
            <div className="settings-purge-floor" role="group" aria-label={t("purge.presetsActiveTemplate")}>
              <button
                type="button"
                className={`settings-purge-floor-btn${draft.active_template === "" ? " is-active" : ""}`}
                aria-pressed={draft.active_template === ""}
                disabled={disabled}
                onClick={() => edit({ active_template: "" })}
              >
                {t("purge.presetsDefaultSuffix")}
              </button>
              {draft.structured_templates.map((template) => (
                <button
                  key={template.name}
                  type="button"
                  className={`settings-purge-floor-btn${draft.active_template === template.name ? " is-active" : ""}`}
                  aria-pressed={draft.active_template === template.name}
                  disabled={disabled}
                  onClick={() => edit({ active_template: template.name })}
                >
                  {template.name}
                </button>
              ))}
            </div>
            <div className="settings-option-list">
              {draft.structured_templates.map((template) => (
                <div key={template.name} className="settings-option">
                  <span className="settings-option-text">
                    <span className="settings-option-title">{template.name}</span>
                    <span className="settings-option-hint">
                      {t("purge.presetsTemplateChars", { count: number(template.text.length) })}
                    </span>
                  </span>
                  <ConfigButton
                    variant="ghost"
                    size="small"
                    disabled={disabled}
                    aria-label={`${t("purge.presetsRemoveTemplate")} ${template.name}`}
                    onClick={() => removeTemplate(template.name)}
                  >
                    {t("purge.presetsRemoveTemplate")}
                  </ConfigButton>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* 预设库：浏览第三方公开 prompt 原文，一键落到模板草稿或技能目录。 */}
      <PurgePresetLibrary activeModel={autoPreview?.model ?? undefined} onApplyTemplate={applyPresetTemplate} />

      <PurgeRulesTable
        heading={t("purge.rewriteRulesHeading")}
        hint={t("purge.rewriteRulesHint")}
        addLabel={t("purge.addRewriteRule")}
        emptyLabel={t("purge.rewriteRulesEmpty")}
        columnFrom={t("purge.columnFrom")}
        columnTo={t("purge.columnTo")}
        columnAction={t("purge.columnAction")}
        removeLabel={t("purge.removeRule")}
        rows={draft.rewrite_rules}
        disabled={disabled}
        onAdd={() => { edit({ rewrite_rules: addPurgeRule(draft.rewrite_rules) }); }}
        onPatch={(index, part) => { edit({ rewrite_rules: patchPurgeRule(draft.rewrite_rules, index, part) }); }}
        onRemove={(index) => { edit({ rewrite_rules: removePurgeRule(draft.rewrite_rules, index) }); }}
      />

      <PurgeRulesTable
        heading={t("purge.synonymsHeading")}
        hint={t("purge.synonymsHint")}
        addLabel={t("purge.addSynonymPair")}
        emptyLabel={t("purge.synonymsEmpty")}
        columnFrom={t("purge.columnSensitiveWord")}
        columnTo={t("purge.columnSynonym")}
        columnAction={t("purge.columnAction")}
        removeLabel={t("purge.removeRule")}
        rows={draft.synonym_pairs}
        disabled={disabled}
        onAdd={() => { edit({ synonym_pairs: addPurgeRule(draft.synonym_pairs) }); }}
        onPatch={(index, part) => { edit({ synonym_pairs: patchPurgeRule(draft.synonym_pairs, index, part) }); }}
        onRemove={(index) => { edit({ synonym_pairs: removePurgeRule(draft.synonym_pairs, index) }); }}
      />

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("purge.statsHeading")}</h3>
        <p className="settings-general-description">{t("purge.statsHint")}</p>
        {stats === null ? (
          <p className="settings-purge-empty" role="status">
            {status === "loadFailed" ? t("purge.statsUnavailable") : t("purge.statsPending")}
          </p>
        ) : (
          <dl className="settings-purge-stats">
            {purgeStatValues(stats).map((row) => (
              <div key={row.labelKey} className="settings-purge-stat">
                <dt>{t(row.labelKey)}</dt>
                <dd>{number(row.value)}</dd>
              </div>
            ))}
            <div className="settings-purge-stat">
              <dt>{t("purge.statStartedAt")}</dt>
              <dd>{stats.started_at || "—"}</dd>
            </div>
            {runtime !== null && (
              <div className="settings-purge-stat">
                <dt>{t("purge.statUptime")}</dt>
                <dd>{t("purge.runtimeLine", { pid: runtime.pid, uptime })}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      <PurgeGateLogSection />

      {/* 试跑放在最后一节之前：它读的是上面的草稿，先看完效果再决定按不按保存。 */}
      <PurgePreviewPanel
        draft={draft}
        model={autoPreview?.model ?? undefined}
        dirty={dirty}
        disabled={!loaded}
      />

      <div className="settings-purge-actions">
        <ConfigButton
          variant="primary"
          disabled={!canSave}
          title={!dirty && loaded ? t("purge.noChanges") : undefined}
          onClick={save}
        >
          {saving ? t("purge.saving") : t("purge.save")}
        </ConfigButton>
        <span className="settings-chats-hint" role="status">
          {saving ? t("purge.saving") : status === "saved" ? t("purge.saved") : ""}
        </span>
        {status === "loadFailed" && (
          <ConfigButton
            variant="secondary"
            size="small"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            {t("purge.reload")}
          </ConfigButton>
        )}
      </div>

      {(status === "saveFailed" || status === "loadFailed") && (
        <p role="alert" className="settings-general-error">
          {status === "saveFailed" ? t("purge.saveFailed") : t("purge.loadFailed")}
        </p>
      )}

      {stats !== null && (
        <p className="settings-general-description">{t("purge.statsFootnote")}</p>
      )}
    </div>
  );
}
