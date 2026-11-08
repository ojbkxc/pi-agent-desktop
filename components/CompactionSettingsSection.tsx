"use client";

import { useEffect, useId, useState } from "react";
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

interface CompactionSettingsPayload {
  policy: CompactionPolicy;
  defaults: CompactionPolicy;
  limits: {
    keepRecentTokens: { min: number; max: number; default: number };
    preferredModels: { max: number };
  };
  candidates: CompactionCandidate[];
  candidatesError?: string;
}

const MODES: readonly CompactionMode[] = ["balanced", "long", "native"];
const MODE_LABEL_KEYS: Record<CompactionMode, string> = {
  balanced: "settings.compactionModeBalanced",
  long: "settings.compactionModeLong",
  native: "settings.compactionModeNative",
};

const MODEL_CHOICES: readonly CompactionModelChoice[] = ["auto", "current", "preferred"];
const MODEL_LABEL_KEYS: Record<CompactionModelChoice, string> = {
  auto: "settings.compactionModelAuto",
  current: "settings.compactionModelCurrent",
  preferred: "settings.compactionModelPreferred",
};

const KEEP_RECENT_FALLBACK = 65_536;

/**
 * Settings › General › Chat: the context-compaction policy (v0.8.2). The
 * threshold tier and the summarizer model are session-start settings — the
 * model's real context window never changes, and only a new session or a
 * reload picks the values up.
 */
export function CompactionSettingsSection() {
  const { t } = useI18n();
  const keepRecentHintId = useId();
  const [policy, setPolicy] = useState<CompactionPolicy | null>(null);
  const [payload, setPayload] = useState<CompactionSettingsPayload | null>(null);
  const [keepRecentDraft, setKeepRecentDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [invalidKeepRecent, setInvalidKeepRecent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/compaction/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: CompactionSettingsPayload) => {
        if (cancelled) return;
        setPayload(data);
        setPolicy(data.policy);
        setKeepRecentDraft(String(data.policy.keepRecentTokens));
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const save = (patch: Partial<CompactionPolicy>) => {
    setSaving(true);
    setFailed(false);
    fetch("/api/compaction/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { policy?: CompactionPolicy }) => {
        if (!data.policy) return;
        setPolicy(data.policy);
        if ("keepRecentTokens" in patch) setKeepRecentDraft(String(data.policy.keepRecentTokens));
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  };

  const min = payload?.limits.keepRecentTokens.min ?? 16_384;
  const max = payload?.limits.keepRecentTokens.max ?? 262_144;
  const defaultKeepRecent = payload?.limits.keepRecentTokens.default ?? KEEP_RECENT_FALLBACK;
  const maxPreferred = payload?.limits.preferredModels.max ?? 8;
  const candidates = payload?.candidates ?? [];
  const chosen = policy?.preferredModels ?? [];
  const busy = policy === null || saving;

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
        {failed ? t("settings.compactionFailed") : saving ? t("i18n.saving") : ""}
      </span>
      <p className="settings-general-description">{t("settings.compactionHint")}</p>
    </section>
  );
}
