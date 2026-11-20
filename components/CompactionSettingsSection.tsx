"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "./AppSelect";

type CompactionMode = "balanced" | "long" | "native";
type CompactionModelChoice = "auto" | "current" | "preferred";

interface CompactionPolicy {
  mode: CompactionMode;
  keepRecentTokens: number;
  compactionModel: CompactionModelChoice;
  preferredModels: string[];
}

interface CompactionCandidate {
  provider: string;
  modelId: string;
  label: string;
  priceConfirmed: boolean;
}

interface CompactionTriggerMode {
  trigger: number;
  percent: number;
  /** False when this window is too small (or pi settings override the tier). */
  applied: boolean;
}

interface CompactionTriggerSummary {
  model: string;
  contextWindow: number;
  modes: Record<CompactionMode, CompactionTriggerMode>;
}

interface CompactionSettingsPayload {
  policy: CompactionPolicy;
  defaults: CompactionPolicy;
  limits: {
    keepRecentTokens: { min: number; max: number; default: number };
    preferredModels: { max: number };
  };
  candidates: CompactionCandidate[];
  candidatesError?: string;
  /** The default model's real trigger per tier; null when no default model is set. */
  thresholds: CompactionTriggerSummary | null;
}

const MODES: readonly CompactionMode[] = ["balanced", "long", "native"];
const MODE_LABEL_KEYS: Record<CompactionMode, string> = {
  balanced: "settings.compactionModeBalanced",
  long: "settings.compactionModeLong",
  native: "settings.compactionModeNative",
};

/** One line per tier: the label's share, the real token count it fires at. */
const MODE_TRIGGER_KEYS: Record<CompactionMode, string> = {
  balanced: "settings.compactionTriggerBalanced",
  long: "settings.compactionTriggerLong",
  native: "settings.compactionTriggerNative",
};

const MODEL_CHOICES: readonly CompactionModelChoice[] = ["auto", "current", "preferred"];
const MODEL_LABEL_KEYS: Record<CompactionModelChoice, string> = {
  auto: "settings.compactionModelAuto",
  current: "settings.compactionModelCurrent",
  preferred: "settings.compactionModelPreferred",
};

const KEEP_RECENT_FALLBACK = 65_536;
const KEEP_RECENT_MIN = 16_384;
const KEEP_RECENT_MAX = 262_144;

const FALLBACK_LIMITS: CompactionSettingsPayload["limits"] = {
  keepRecentTokens: { min: KEEP_RECENT_MIN, max: KEEP_RECENT_MAX, default: KEEP_RECENT_FALLBACK },
  preferredModels: { max: 8 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The same rule the server applies (`normalizeCompactionPolicy` in
 * lib/compaction-settings-api.ts): an integer inside the supported range,
 * otherwise the default. `Number.isFinite` alone would keep 0, negatives and
 * fractions that the server replaces.
 */
function asKeepRecentTokens(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= KEEP_RECENT_MIN && raw <= KEEP_RECENT_MAX
    ? raw
    : KEEP_RECENT_FALLBACK;
}

const MAX_PREFERRED_MODELS = 8;

/** A `provider/modelId` reference; the model id may itself contain slashes. */
function isModelRef(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

/**
 * The same all-or-nothing rule the server applies to `preferredModels`
 * (`parsePreferredModels` in lib/compaction-settings-api.ts): keep the list
 * only when it is an array of at most 8 `provider/modelId` strings, otherwise
 * empty. Deliberately duplicated instead of imported — the server module pulls
 * in `node:fs`, which must not enter the browser bundle — and locked equal to
 * it by `CompactionSettingsSection.test.mjs`.
 */
function asPreferredModels(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PREFERRED_MODELS) return null;
  const models: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const ref = item.trim();
    if (!isModelRef(ref)) return null;
    models.push(ref);
  }
  return models;
}

/**
 * One policy from an API response, with every missing field filled from the
 * defaults. Returns null when the response has no policy object at all, so a
 * body like `{}` (a stub server, an older build) reads as "no data" instead of
 * reaching the render with holes in it.
 */
export function asCompactionPolicy(raw: unknown): CompactionPolicy | null {
  if (!isRecord(raw)) return null;
  return {
    mode: raw.mode === "long" || raw.mode === "native" ? raw.mode : "balanced",
    keepRecentTokens: asKeepRecentTokens(raw.keepRecentTokens),
    compactionModel: raw.compactionModel === "current" || raw.compactionModel === "preferred"
      ? raw.compactionModel
      : "auto",
    preferredModels: asPreferredModels(raw.preferredModels) ?? [],
  };
}

/** One tier's numbers; a malformed row drops the whole hint rather than printing "NaN". */
function asTriggerMode(raw: unknown): CompactionTriggerMode | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.trigger !== "number" || !Number.isFinite(raw.trigger) || raw.trigger < 0) return null;
  return {
    trigger: raw.trigger,
    percent: typeof raw.percent === "number" && Number.isFinite(raw.percent) ? raw.percent : 0,
    applied: raw.applied === true,
  };
}

function asTriggerSummary(raw: unknown): CompactionTriggerSummary | null {
  if (!isRecord(raw) || !isRecord(raw.modes)) return null;
  if (typeof raw.model !== "string" || typeof raw.contextWindow !== "number" || raw.contextWindow <= 0) return null;
  const balanced = asTriggerMode(raw.modes.balanced);
  const long = asTriggerMode(raw.modes.long);
  const native = asTriggerMode(raw.modes.native);
  if (!balanced || !long || !native) return null;
  return { model: raw.model, contextWindow: raw.contextWindow, modes: { balanced, long, native } };
}

/**
 * The whole GET payload, or null when it carries no usable policy. Every field
 * the render reads is completed here, so a response whose `limits` or
 * `candidates` are missing can never make the block throw — the failure mode
 * the E2E caught, where a stub endpoint answers `{}` and the Settings ›
 * General tab went down with a page-level TypeError.
 */
export function asCompactionSettings(raw: unknown): CompactionSettingsPayload | null {
  if (!isRecord(raw)) return null;
  const policy = asCompactionPolicy(raw.policy);
  if (!policy) return null;
  const limits = isRecord(raw.limits) ? raw.limits : {};
  const keepRecent = isRecord(limits.keepRecentTokens) ? limits.keepRecentTokens : {};
  const preferred = isRecord(limits.preferredModels) ? limits.preferredModels : {};
  return {
    policy,
    defaults: asCompactionPolicy(raw.defaults) ?? policy,
    limits: {
      keepRecentTokens: {
        min: typeof keepRecent.min === "number" ? keepRecent.min : FALLBACK_LIMITS.keepRecentTokens.min,
        max: typeof keepRecent.max === "number" ? keepRecent.max : FALLBACK_LIMITS.keepRecentTokens.max,
        default: typeof keepRecent.default === "number"
          ? keepRecent.default
          : FALLBACK_LIMITS.keepRecentTokens.default,
      },
      preferredModels: {
        max: typeof preferred.max === "number" ? preferred.max : FALLBACK_LIMITS.preferredModels.max,
      },
    },
    candidates: Array.isArray(raw.candidates)
      ? raw.candidates.filter((candidate): candidate is CompactionCandidate => isRecord(candidate)
        && typeof candidate.provider === "string"
        && typeof candidate.modelId === "string"
        && typeof candidate.label === "string"
        && typeof candidate.priceConfirmed === "boolean")
      : [],
    thresholds: asTriggerSummary(raw.thresholds),
    ...(typeof raw.candidatesError === "string" ? { candidatesError: raw.candidatesError } : {}),
  };
}

/**
 * Settings › General › Chat: the context-compaction policy (v0.8.2). The
 * threshold tier and the summarizer model are session-start settings — the
 * model's real context window never changes, and only a new session or a
 * reload picks the values up.
 */
export function CompactionSettingsSection() {
  const { t, locale } = useI18n();
  const keepRecentHintId = useId();
  const [policy, setPolicy] = useState<CompactionPolicy | null>(null);
  const [payload, setPayload] = useState<CompactionSettingsPayload | null>(null);
  const [keepRecentDraft, setKeepRecentDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [invalidKeepRecent, setInvalidKeepRecent] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/compaction/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: unknown) => {
        if (cancelled) return;
        const next = asCompactionSettings(data);
        if (!next) {
          setFailed(true);
          return;
        }
        setPayload(next);
        setPolicy(next.policy);
        setKeepRecentDraft(String(next.policy.keepRecentTokens));
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const save = (patch: Partial<CompactionPolicy>) => {
    setSaving(true);
    setFailed(false);
    if (savedTimer.current) { clearTimeout(savedTimer.current); savedTimer.current = null; }
    setJustSaved(false);
    fetch("/api/compaction/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: unknown) => {
        const next = asCompactionPolicy(isRecord(data) ? data.policy : undefined);
        if (!next) return;
        setPolicy(next);
        if ("keepRecentTokens" in patch) setKeepRecentDraft(String(next.keepRecentTokens));
        setJustSaved(true);
        savedTimer.current = setTimeout(() => setJustSaved(false), 2000);
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  };

  const limits = payload?.limits ?? FALLBACK_LIMITS;
  const min = limits.keepRecentTokens.min;
  const max = limits.keepRecentTokens.max;
  const defaultKeepRecent = limits.keepRecentTokens.default;
  const maxPreferred = limits.preferredModels.max;
  const candidates = payload?.candidates ?? [];
  const chosen = policy?.preferredModels ?? [];
  const thresholds = payload?.thresholds ?? null;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const percent = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  const busy = policy === null || saving;
  const keepRecentParsed = Number(keepRecentDraft.trim());
  const keepRecentDirty = policy !== null
    && keepRecentDraft.trim() !== ""
    && Number.isInteger(keepRecentParsed)
    && keepRecentParsed !== policy.keepRecentTokens;

  const commitKeepRecent = () => {
    const trimmed = keepRecentDraft.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      setInvalidKeepRecent(true);
      return;
    }
    setInvalidKeepRecent(false);
    if (policy && parsed !== policy.keepRecentTokens) save({ keepRecentTokens: parsed });
  };

  const labelFor = (ref: string) => candidates.find(
    (candidate) => `${candidate.provider}/${candidate.modelId}` === ref,
  )?.label ?? ref;

  const addPreferred = (ref: string) => {
    if (!ref || chosen.includes(ref) || chosen.length >= maxPreferred) return;
    save({ preferredModels: [...chosen, ref] });
  };

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.compaction")}</h3>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chat-choice-option">
          <span>{t("settings.compactionMode")}</span>
          <div className="settings-choice-group" role="radiogroup" aria-label={t("settings.compactionMode")}>
            {MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={policy?.mode === mode}
                className="settings-choice-option"
                disabled={busy}
                onClick={() => save({ mode })}
              >
                {t(MODE_LABEL_KEYS[mode])}
              </button>
            ))}
          </div>
        </div>

        {thresholds && (
          <div className="settings-chat-option settings-chats-field">
            <span className="settings-chats-hint">
              {t("settings.compactionTriggerModel", {
                model: thresholds.model,
                window: number(thresholds.contextWindow),
              })}
            </span>
            <span className="settings-chats-hint">
              {MODES.map((mode) => {
                const row = thresholds.modes[mode];
                const label = t(MODE_TRIGGER_KEYS[mode], {
                  percent: percent(row.percent),
                  tokens: number(row.trigger),
                });
                return row.applied ? label : `${label} ${t("settings.compactionTriggerUnsupported")}`;
              }).join(" · ")}
            </span>
          </div>
        )}

        <div className="settings-chat-option settings-chat-choice-option">
          <span>{t("settings.compactionModel")}</span>
          <div className="settings-choice-group" role="radiogroup" aria-label={t("settings.compactionModel")}>
            {MODEL_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={policy?.compactionModel === choice}
                className="settings-choice-option"
                disabled={busy}
                onClick={() => save({ compactionModel: choice })}
              >
                {t(MODEL_LABEL_KEYS[choice])}
              </button>
            ))}
          </div>
        </div>

        {policy?.compactionModel === "auto" && (
          <div className="settings-chat-option settings-chats-field">
            <span className="settings-chats-hint">{t("settings.compactionAutoOrder")}</span>
          </div>
        )}

        {policy && policy.compactionModel !== "current" && (
          <div className="settings-chat-option settings-chats-field">
            <label htmlFor="settings-compaction-preferred">{t("settings.compactionPreferredModels")}</label>
            <AppSelect
              id="settings-compaction-preferred"
              className="settings-chats-control"
              aria-label={t("settings.compactionPreferredModels")}
              value=""
              disabled={busy || chosen.length >= maxPreferred}
              placeholder={t("settings.compactionPreferredAdd")}
              onValueChange={addPreferred}
              options={candidates
                .filter((candidate) => !chosen.includes(`${candidate.provider}/${candidate.modelId}`))
                .map((candidate) => ({
                  value: `${candidate.provider}/${candidate.modelId}`,
                  label: candidate.priceConfirmed
                    ? candidate.label
                    : `${candidate.label} (${t("settings.compactionPriceUnconfirmed")})`,
                }))}
            />
            {chosen.length > 0 ? (
              <ul className="settings-compaction-selected">
                {chosen.map((ref) => (
                  <li key={ref} className="settings-compaction-chip">
                    <span className="settings-compaction-chip-label">{labelFor(ref)}</span>
                    <button
                      type="button"
                      className="settings-compaction-chip-remove"
                      aria-label={t("settings.compactionPreferredRemove", { model: labelFor(ref) })}
                      disabled={busy}
                      onClick={() => save({ preferredModels: chosen.filter((item) => item !== ref) })}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="settings-chats-hint">{t("settings.compactionPreferredEmpty")}</span>
            )}
            <span className="settings-chats-hint">
              {payload?.candidatesError
                ? t("settings.compactionCandidatesUnavailable")
                : t("settings.compactionPreferredHint", { count: maxPreferred })}
            </span>
          </div>
        )}

        <div className="settings-chat-option settings-chats-field">
          <label htmlFor="settings-compaction-keep-recent">{t("settings.compactionKeepRecent")}</label>
          <input
            id="settings-compaction-keep-recent"
            className="settings-chats-control"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1024}
            value={keepRecentDraft}
            disabled={busy}
            aria-describedby={keepRecentHintId}
            onChange={(event) => setKeepRecentDraft(event.target.value)}
            onBlur={commitKeepRecent}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commitKeepRecent();
            }}
          />
          <span
            id={keepRecentHintId}
            className="settings-chats-hint"
            role={invalidKeepRecent ? "alert" : undefined}
          >
            {invalidKeepRecent
              ? t("settings.compactionKeepRecentInvalid", { min, max })
              : t("settings.compactionKeepRecentHint", { min, max, default: defaultKeepRecent })}
          </span>
        </div>
      </div>

      <span className="settings-chats-hint" role={failed ? "alert" : "status"}>
        {failed
          ? t("settings.compactionFailed")
          : saving
            ? t("i18n.saving")
            : keepRecentDirty
              ? t("settings.unsaved")
              : justSaved
                ? t("settings.saved")
                : ""}
      </span>
      <p className="settings-general-description">{t("settings.compactionHint")}</p>
    </section>
  );
}
