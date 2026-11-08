import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";

/**
 * Contract for the `compactionPolicy` block in Pi Web's own settings file
 * (`~/.pi/agent/pi-web/settings.json`).
 *
 * The v0.8.2 compaction plan fixes this schema:
 *
 * ```json
 * { "compactionPolicy": {
 *     "mode": "balanced",
 *     "keepRecentTokens": 65536,
 *     "compactionModel": "auto",
 *     "preferredModels": []
 * } }
 * ```
 *
 * The runtime that applies the policy reads the same key through its own
 * module; this file is the API/UI contract only — it must not import the
 * policy/threshold modules so the settings route stays independently
 * deployable and testable.
 */

export const COMPACTION_MODES = ["balanced", "long", "native"] as const;
export type CompactionMode = (typeof COMPACTION_MODES)[number];

export const COMPACTION_MODEL_CHOICES = ["auto", "current", "preferred"] as const;
export type CompactionModelChoice = (typeof COMPACTION_MODEL_CHOICES)[number];

export const KEEP_RECENT_TOKENS_MIN = 16_384;
export const KEEP_RECENT_TOKENS_MAX = 262_144;
export const KEEP_RECENT_TOKENS_DEFAULT = 65_536;
export const MAX_PREFERRED_MODELS = 8;

export interface CompactionPolicy {
  /** Threshold tier: `balanced` (50% of the window) / `long` (80%) / `native` (leave the SDK alone). */
  mode: CompactionMode;
  /** Recent conversation tokens kept verbatim when a compaction runs. */
  keepRecentTokens: number;
  /** Which model summarizes: `auto` (save cost) / `current` (always the main model) / `preferred`. */
  compactionModel: CompactionModelChoice;
  /** Explicit `provider/modelId` preferences, in the order the user set them. */
  preferredModels: string[];
}

export interface CompactionLimits {
  keepRecentTokens: { min: number; max: number; default: number };
  preferredModels: { max: number };
}

export const COMPACTION_LIMITS: CompactionLimits = {
  keepRecentTokens: {
    min: KEEP_RECENT_TOKENS_MIN,
    max: KEEP_RECENT_TOKENS_MAX,
    default: KEEP_RECENT_TOKENS_DEFAULT,
  },
  preferredModels: { max: MAX_PREFERRED_MODELS },
};

/** A fresh defaults object each call, so a caller can never mutate shared state. */
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * A `provider/modelId` reference. The model id may itself contain slashes
 * (OpenRouter-style ids), so only the first segment is the provider.
 */
export function isCompactionModelRef(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

interface ParsedPreferredModels {
  models: string[] | null;
}

function parsePreferredModels(value: unknown): ParsedPreferredModels {
  if (!Array.isArray(value) || value.length > MAX_PREFERRED_MODELS) return { models: null };
  const models: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { models: null };
    const ref = item.trim();
    if (!isCompactionModelRef(ref)) return { models: null };
    models.push(ref);
  }
  return { models };
}

/** Tolerant read: every malformed or out-of-range field falls back to its default. */
export function normalizeCompactionPolicy(raw: unknown): CompactionPolicy {
  const defaults = defaultCompactionPolicy();
  if (!isRecord(raw)) return defaults;
  const mode = (COMPACTION_MODES as readonly unknown[]).includes(raw.mode)
    ? raw.mode as CompactionMode
    : defaults.mode;
  const compactionModel = (COMPACTION_MODEL_CHOICES as readonly unknown[]).includes(raw.compactionModel)
    ? raw.compactionModel as CompactionModelChoice
    : defaults.compactionModel;
  const keepRecentTokens = typeof raw.keepRecentTokens === "number"
    && Number.isInteger(raw.keepRecentTokens)
    && raw.keepRecentTokens >= KEEP_RECENT_TOKENS_MIN
    && raw.keepRecentTokens <= KEEP_RECENT_TOKENS_MAX
    ? raw.keepRecentTokens
    : defaults.keepRecentTokens;
  const preferredModels = parsePreferredModels(raw.preferredModels).models ?? defaults.preferredModels;
  return { mode, keepRecentTokens, compactionModel, preferredModels };
}

/** The effective policy. An unreadable or malformed file reads as the defaults. */
export function readCompactionPolicy(settingsPath = getPiWebSettingsPath()): CompactionPolicy {
  try {
    return normalizeCompactionPolicy(readStored(settingsPath).compactionPolicy);
  } catch {
    return defaultCompactionPolicy();
  }
}

export type CompactionPolicyPatchValidation =
  | { ok: true; patch: Partial<CompactionPolicy> }
  | { ok: false; error: string };

const POLICY_KEYS: readonly string[] = ["mode", "keepRecentTokens", "compactionModel", "preferredModels"];

/**
 * Validate one PUT body: a partial policy. Unknown keys are refused so a typo
 * never lands in the settings file, and a body with no known key is refused
 * rather than silently accepted.
 */
export function validateCompactionPolicyPatch(body: unknown): CompactionPolicyPatchValidation {
  if (!isRecord(body)) return { ok: false, error: "Request body must be a JSON object" };
  const unknownKey = Object.keys(body).find((key) => !POLICY_KEYS.includes(key));
  if (unknownKey) return { ok: false, error: `Unknown compaction setting: ${unknownKey}` };

  const patch: Partial<CompactionPolicy> = {};
  if (hasOwn(body, "mode")) {
    if (!(COMPACTION_MODES as readonly unknown[]).includes(body.mode)) {
      return { ok: false, error: `mode must be one of ${COMPACTION_MODES.join(", ")}` };
    }
    patch.mode = body.mode as CompactionMode;
  }
  if (hasOwn(body, "compactionModel")) {
    if (!(COMPACTION_MODEL_CHOICES as readonly unknown[]).includes(body.compactionModel)) {
      return { ok: false, error: `compactionModel must be one of ${COMPACTION_MODEL_CHOICES.join(", ")}` };
    }
    patch.compactionModel = body.compactionModel as CompactionModelChoice;
  }
  if (hasOwn(body, "keepRecentTokens")) {
    const value = body.keepRecentTokens;
    if (typeof value !== "number" || !Number.isInteger(value)
      || value < KEEP_RECENT_TOKENS_MIN || value > KEEP_RECENT_TOKENS_MAX) {
      return {
        ok: false,
        error: `keepRecentTokens must be an integer between ${KEEP_RECENT_TOKENS_MIN} and ${KEEP_RECENT_TOKENS_MAX}`,
      };
    }
    patch.keepRecentTokens = value;
  }
  if (hasOwn(body, "preferredModels")) {
    const { models } = parsePreferredModels(body.preferredModels);
    if (models === null) {
      return {
        ok: false,
        error: `preferredModels must be an array of at most ${MAX_PREFERRED_MODELS} "provider/modelId" strings`,
      };
    }
    patch.preferredModels = models;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "No compaction settings to update" };
  return { ok: true, patch };
}

/**
 * Merge a validated patch into the stored policy and return the effective
 * policy. `updatePiWebSettings` re-reads the file itself, so every other key
 * (and any unrelated Pi Web preference) stays untouched.
 */
export function writeCompactionPolicy(
  patch: Partial<CompactionPolicy>,
  settingsPath = getPiWebSettingsPath(),
): CompactionPolicy {
  const stored = readStored(settingsPath);
  const current = isRecord(stored.compactionPolicy) ? stored.compactionPolicy : {};
  updatePiWebSettings({ compactionPolicy: { ...current, ...patch } }, settingsPath);
  return readCompactionPolicy(settingsPath);
}

/** The part of a chat model the candidate list needs; nothing here is a secret. */
export interface CompactionModelCandidateInput {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  cost?: { input?: number; output?: number } | null;
}

export interface CompactionModelCandidate {
  provider: string;
  modelId: string;
  /** Display label the settings picker shows. */
  label: string;
  /**
   * Whether the catalog carries a usable price. A zero/zero cost is NOT proof
   * of "free": the SDK writes zeros for a model configured without cost data,
   * so only a positive known rate counts as confirmed. The UI must never call
   * an unconfirmed model free.
   */
  priceConfirmed: boolean;
}

/** `pi-virtual` entries are routers, not models that can summarize. */
const VIRTUAL_MODEL_API = "pi-virtual";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Map available chat models to the picker's candidates: de-duplicated by
 * `provider/modelId`, virtual routers excluded, sorted by provider then label
 * so the list is stable across calls.
 */
export function toCompactionModelCandidates(
  models: readonly CompactionModelCandidateInput[],
): CompactionModelCandidate[] {
  const seen = new Set<string>();
  const candidates: CompactionModelCandidate[] = [];
  for (const model of models) {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string") continue;
    if (model.api === VIRTUAL_MODEL_API) continue;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const input = model.cost?.input;
    const output = model.cost?.output;
    const priceConfirmed = isFiniteNumber(input) && isFiniteNumber(output) && (input > 0 || output > 0);
    candidates.push({
      provider: model.provider,
      modelId: model.id,
      label: `${model.name || model.id} · ${model.provider}`,
      priceConfirmed,
    });
  }
  return candidates.sort((a, b) => (
    a.provider.localeCompare(b.provider)
    || a.label.localeCompare(b.label)
    || a.modelId.localeCompare(b.modelId)
  ));
}
