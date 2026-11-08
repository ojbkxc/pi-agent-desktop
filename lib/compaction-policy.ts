import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";

/**
 * Pi Web's own compaction policy (v0.8.2), stored under `compactionPolicy` in
 * `~/.pi/agent/pi-web/settings.json` so the pi CLI never sees a key it does
 * not understand.
 *
 * The policy decides two things at session level:
 * - the threshold tier that maps a model's real `contextWindow` onto a
 *   compaction trigger (`balanced` 50% / `long` 80% / `native` untouched), and
 * - which model writes the summary (`auto` / `current` / `preferred`; the
 *   selection itself lives in a separate module).
 *
 * The schema constants here are also the API/UI contract's values; the
 * settings route validates its own writes, and this module re-validates on
 * every read so a hand-edited file can never break a session.
 */

export const COMPACTION_MODES = ["balanced", "long", "native"] as const;
export type CompactionMode = (typeof COMPACTION_MODES)[number];

export const COMPACTION_MODEL_CHOICES = ["auto", "current", "preferred"] as const;
export type CompactionModelChoice = (typeof COMPACTION_MODEL_CHOICES)[number];

export const KEEP_RECENT_TOKENS_DEFAULT = 65_536;
export const KEEP_RECENT_TOKENS_MIN = 16_384;
export const KEEP_RECENT_TOKENS_MAX = 262_144;
export const MAX_PREFERRED_MODELS = 8;

export interface CompactionPolicy {
  /** `balanced` = 50% of the real window, `long` = 80%, `native` = SDK settings untouched. */
  mode: CompactionMode;
  /** Verbatim tail kept when compacting; clamped to a quarter of small windows. */
  keepRecentTokens: number;
  /** Which model summarizes the discarded history. */
  compactionModel: CompactionModelChoice;
  /** Explicit `provider/modelId` entries, in the user's order. */
  preferredModels: string[];
}

/** A fresh object per call so no caller can mutate shared defaults. */
export function defaultCompactionPolicy(): CompactionPolicy {
  return {
    mode: "balanced",
    keepRecentTokens: KEEP_RECENT_TOKENS_DEFAULT,
    compactionModel: "auto",
    preferredModels: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `provider/modelId` reference. Only the first segment is the provider, so
 * OpenRouter-style ids with slashes inside the model id still parse.
 */
export function isCompactionModelRef(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

/**
 * All-or-nothing, matching `lib/compaction-settings-api.ts` (the settings
 * route's contract): one malformed entry makes the whole list read as the
 * default, so the settings UI and a running session never disagree about what
 * the file says.
 */
function normalizePreferredModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PREFERRED_MODELS) return [];
  const models: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return [];
    const ref = item.trim();
    if (!isCompactionModelRef(ref)) return [];
    models.push(ref);
  }
  return models;
}

/** Tolerant read: every malformed or out-of-range field falls back to its default. */
export function normalizeCompactionPolicy(raw: unknown): CompactionPolicy {
  const defaults = defaultCompactionPolicy();
  if (!isRecord(raw)) return defaults;
  const mode = (COMPACTION_MODES as readonly unknown[]).includes(raw.mode)
    ? (raw.mode as CompactionMode)
    : defaults.mode;
  const compactionModel = (COMPACTION_MODEL_CHOICES as readonly unknown[]).includes(raw.compactionModel)
    ? (raw.compactionModel as CompactionModelChoice)
    : defaults.compactionModel;
  const keepRecentTokens =
    typeof raw.keepRecentTokens === "number"
    && Number.isInteger(raw.keepRecentTokens)
    && raw.keepRecentTokens >= KEEP_RECENT_TOKENS_MIN
    && raw.keepRecentTokens <= KEEP_RECENT_TOKENS_MAX
      ? raw.keepRecentTokens
      : defaults.keepRecentTokens;
  return {
    mode,
    keepRecentTokens,
    compactionModel,
    preferredModels: normalizePreferredModels(raw.preferredModels),
  };
}

/** The effective policy. An unreadable or malformed file reads as the defaults. */
export function readCompactionPolicy(settingsPath = getPiWebSettingsPath()): CompactionPolicy {
  try {
    return normalizeCompactionPolicy(readStored(settingsPath).compactionPolicy);
  } catch {
    return defaultCompactionPolicy();
  }
}

/**
 * Merge `patch` into the stored policy and return what is now effective.
 * Unknown keys are dropped and every value is normalized, so the file can
 * never receive a value this module would not read back. Other keys in the
 * settings file are left to `updatePiWebSettings`, which re-reads them itself.
 */
export function writeCompactionPolicy(
  patch: Partial<CompactionPolicy>,
  settingsPath = getPiWebSettingsPath(),
): CompactionPolicy {
  const stored = readStored(settingsPath);
  const current = isRecord(stored.compactionPolicy) ? stored.compactionPolicy : {};
  // Drop explicit `undefined`s so a partial patch never resets a field to its
  // default just because the caller spelled the key out.
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const next = normalizeCompactionPolicy({ ...current, ...defined });
  updatePiWebSettings({ compactionPolicy: next }, settingsPath);
  return readCompactionPolicy(settingsPath);
}

// ---------------------------------------------------------------------------
// Threshold math
// ---------------------------------------------------------------------------

/** Share of the real window a tier may fill before compaction; `native` has none. */
export const COMPACTION_MODE_RATIOS: Readonly<Record<Exclude<CompactionMode, "native">, number>> = {
  balanced: 0.5,
  long: 0.8,
};

/** Floor for the trigger: never compact a window smaller than this from the top. */
export const COMPACTION_TRIGGER_FLOOR = 16_384;

/** The SDK's own default reserve, used when a policy cannot apply. */
export const NATIVE_RESERVE_TOKENS = 16_384;

export interface CompactionThresholds {
  /** Tier actually applied; `native` means the SDK settings stay untouched. */
  mode: CompactionMode;
  /** Token count that triggers compaction (`contextTokens > trigger`). */
  trigger: number;
  /** `contextWindow - trigger`, the reserve handed to `getCompactionSettings()`. */
  reserveTokens: number;
  /** Verbatim tail, already clamped against small windows. */
  keepRecentTokens: number;
}

/**
 * Map a real context window onto the policy's thresholds. Pure and total: an
 * unknown, non-positive, or too-small window falls back to `native` rather
 * than inventing capacity, and an explicit `keepRecentTokens` in pi's own
 * settings wins over the policy default.
 *
 * Formulae (plan r2):
 *   effectiveLimit = floor(window × ratio)
 *   keepRecentEff  = min(keepRecentTokens, floor(window / 4))
 *   trigger        = max(effectiveLimit − keepRecentEff, 16384)
 *   reserve        = clamp(window − trigger, 16384, max(16384, window − 1))
 */
export function computeCompactionThresholds(
  policy: Pick<CompactionPolicy, "mode" | "keepRecentTokens">,
  contextWindow: number | undefined,
  explicitKeepRecentTokens?: number,
  nativeReserveTokens: number = NATIVE_RESERVE_TOKENS,
): CompactionThresholds {
  // An explicit `0` is meaningful (keep nothing), so it must not read as "unset".
  const keepRecentSetting = isExplicitTokenCount(explicitKeepRecentTokens)
    ? explicitKeepRecentTokens
    : policy.keepRecentTokens;
  const native: CompactionThresholds = {
    mode: "native",
    trigger: fallbackTrigger(contextWindow, nativeReserveTokens),
    reserveTokens: nativeReserveTokens,
    // Informational in native mode: the SDK keeps its own value; this is what
    // the policy would have used.
    keepRecentTokens: keepRecentSetting,
  };
  if (policy.mode === "native") return native;
  if (!isUsableTokenCount(contextWindow)) return native;

  const window = contextWindow;
  const ratio = COMPACTION_MODE_RATIOS[policy.mode];
  const effectiveLimit = Math.floor(window * ratio);
  const keepRecentEff = Math.min(keepRecentSetting, Math.floor(window / 4));
  const trigger = Math.max(effectiveLimit - keepRecentEff, COMPACTION_TRIGGER_FLOOR);
  // Three ways a tier cannot be expressed as a reserve:
  // - a window at or below the trigger floor (nothing to compact at the top),
  // - a trigger with no room above `window - 1` ("always compact"),
  // - less reserve headroom than the SDK floor, where `clamp()` would raise the
  //   reserve to 16384 and the SDK's real trigger would land far below the
  //   tier's intended one (a 20K window would compact at 3.6K). Native gives
  //   that same real trigger without pretending the tier applied.
  //
  // DEVIATION from the plan's r2 formula, approved by the team lead: the plan
  // lists only `trigger >= window → native`. The third clause above is a
  // deliberate tightening. Without it, a 20K window yields trigger = max(10240
  // − 16384, 16384) = 16384 and reserve = clamp(20480 − 16384, 16384, 20479) =
  // 16384, so the SDK fires at 20480 − 16384 = 4096 — far below the tier. The
  // point is not to hide that: it is to avoid *claiming* a tier whose reserve
  // cannot be represented. `window − trigger == 16384` exactly (e.g. 32768
  // under balanced) still applies the tier, because that reserve is
  // representable and the SDK fires exactly at the computed trigger.
  if (trigger >= window || window - trigger < NATIVE_RESERVE_TOKENS) return native;

  const reserve = Math.min(
    Math.max(window - trigger, NATIVE_RESERVE_TOKENS),
    Math.max(NATIVE_RESERVE_TOKENS, window - 1),
  );
  return { mode: policy.mode, trigger, reserveTokens: reserve, keepRecentTokens: keepRecentEff };
}

function isUsableTokenCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Like `isUsableTokenCount`, but zero counts: an explicit "keep nothing" is valid. */
function isExplicitTokenCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The trigger the SDK's own settings imply, for a window we cannot tier (or must not). */
function fallbackTrigger(contextWindow: number | undefined, nativeReserveTokens: number): number {
  if (!isUsableTokenCount(contextWindow)) return 0;
  return Math.max(contextWindow - nativeReserveTokens, 0);
}

// ---------------------------------------------------------------------------
// Session-level SettingsManager delegate
// ---------------------------------------------------------------------------

/** The compaction numbers a user set in pi's own settings, if any. */
export interface ExplicitCompactionSettings {
  reserveTokens?: number;
  keepRecentTokens?: number;
}

/**
 * Read the numbers the user wrote into pi's settings (`global` and trusted
 * `project` merged, plus per-model overrides). The SDK resolves every
 * `getCompactionSettings()` field through these before its defaults, so this
 * is the reliable way to tell "explicit" from "default": the accessors return
 * the default (16384 / 20000) indistinguishably.
 */
export function readExplicitCompactionSettings(
  settingsManager: Pick<SettingsManager, "getSettings">,
  model?: { provider: string; id: string },
): ExplicitCompactionSettings {
  let settings: unknown;
  try {
    settings = settingsManager.getSettings();
  } catch {
    return {};
  }
  if (!isRecord(settings)) return {};
  const compaction = settings.compaction;
  if (!isRecord(compaction)) return {};
  const override = model && isRecord(compaction.modelOverrides)
    ? (compaction.modelOverrides as Record<string, unknown>)[`${model.provider}/${model.id}`]
    : undefined;
  const fromOverride = isRecord(override) ? override : {};
  const reserveTokens = firstTokenCount(fromOverride.reserveTokens, compaction.reserveTokens);
  const keepRecentTokens = firstTokenCount(fromOverride.keepRecentTokens, compaction.keepRecentTokens);
  return {
    ...(reserveTokens !== undefined ? { reserveTokens } : {}),
    ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
  };
}

function firstTokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    // A malformed value is left for the SDK's own accessor to reject; treating
    // it as unset here would silently replace what the user wrote.
    if (value !== undefined) return undefined;
  }
  return undefined;
}

export type CompactionSettingsManager = SettingsManager;

/**
 * The SDK declares `getCompactionSettings(model)` as `Pick<Model, "provider" |
 * "id">`, but every call site passes the session's real model, which carries
 * `contextWindow`. Read it structurally instead of widening the SDK type.
 */
type CompactionSettingsModelArg = Parameters<SettingsManager["getCompactionSettings"]>[0];

function contextWindowOf(model: CompactionSettingsModelArg): number | undefined {
  const window = (model as { contextWindow?: unknown } | undefined)?.contextWindow;
  return typeof window === "number" ? window : undefined;
}

function modelRefOf(model: CompactionSettingsModelArg): { provider: string; id: string } | undefined {
  return model === undefined ? undefined : { provider: model.provider, id: model.id };
}

/**
 * Wrap a session's `SettingsManager` so `getCompactionSettings(model)` applies
 * the policy's thresholds while every other property and method stays exactly
 * the base manager's. Nothing in node_modules is patched, no SDK setting is
 * written back, and the base object itself is never mutated.
 *
 * The wrapper leaves the base behaviour alone (and returns the base manager
 * unchanged) when:
 * - the policy is `native`, or
 * - an explicit `compaction.reserveTokens` exists for this scope/model: the
 *   user has hand-tuned the threshold, and silently replacing it is exactly
 *   the "overwrite the user's SDK settings" the plan forbids.
 *
 * An explicit `compaction.keepRecentTokens` is respected inside a tiered mode:
 * it replaces the policy default, and the quarter-window clamp still applies
 * because a tail larger than the window cannot be kept.
 */
export function createCompactionSettingsManager(
  base: SettingsManager,
  policy: CompactionPolicy = readCompactionPolicy(),
): CompactionSettingsManager {
  if (policy.mode === "native") return base;

  const settingsFor = (model: CompactionSettingsModelArg) => {
    const baseSettings = base.getCompactionSettings(model);
    const explicit = readExplicitCompactionSettings(base, modelRefOf(model));
    if (explicit.reserveTokens !== undefined) return baseSettings;
    const thresholds = computeCompactionThresholds(
      policy,
      contextWindowOf(model),
      explicit.keepRecentTokens,
      baseSettings.reserveTokens,
    );
    if (thresholds.mode === "native") return baseSettings;
    return {
      enabled: baseSettings.enabled,
      reserveTokens: thresholds.reserveTokens,
      // Already the clamped explicit value when one exists; otherwise the
      // policy default clamped to a quarter of the window.
      keepRecentTokens: thresholds.keepRecentTokens,
    };
  };

  const override = ((model: CompactionSettingsModelArg) => settingsFor(model)) as SettingsManager["getCompactionSettings"];
  // Binding on every read would hand out a fresh function each time and break
  // `wrapper.method === wrapper.method`; cache them so identity is stable.
  const bound = new Map<PropertyKey, unknown>();

  return new Proxy(base, {
    get(target, property) {
      if (property === "getCompactionSettings") return override;
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!bound.has(property)) bound.set(property, value.bind(target));
      return bound.get(property);
    },
    set(target, property, value) {
      bound.delete(property);
      return Reflect.set(target, property, value, target);
    },
    has: (target, property) => Reflect.has(target, property),
    getPrototypeOf: (target) => Reflect.getPrototypeOf(target),
  }) as SettingsManager;
}

/**
 * The thresholds a wrapper would apply to `model`, without building one.
 * Convenience for diagnostics and tests; the wrapper uses the same maths.
 */
export function compactionThresholdsFor(
  base: SettingsManager,
  policy: CompactionPolicy,
  model?: { provider: string; id: string; contextWindow?: number },
): CompactionThresholds {
  const baseSettings = base.getCompactionSettings(model);
  const explicit = readExplicitCompactionSettings(base, model);
  if (policy.mode === "native" || explicit.reserveTokens !== undefined) {
    return {
      mode: "native",
      trigger: Math.max((model?.contextWindow ?? 0) - baseSettings.reserveTokens, 0),
      reserveTokens: baseSettings.reserveTokens,
      keepRecentTokens: baseSettings.keepRecentTokens,
    };
  }
  return computeCompactionThresholds(policy, model?.contextWindow, explicit.keepRecentTokens, baseSettings.reserveTokens);
}