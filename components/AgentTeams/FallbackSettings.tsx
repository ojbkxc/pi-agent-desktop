"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * 无人值守兜底的设置面 + manualNeeds 列表。
 *
 * 数据来自 GET /api/teams/fallback（{ config, envDisabled, manualNeeds }）。
 * 被环境变量 PI_WEB_DISABLE_TEAMS_FALLBACK 关掉时如实提示，而不是显示成开着。
 * 清除单条走 POST { action:"clear-manual-needs", keys:[key] }。
 */

export interface FallbackConfigView {
  enabled: boolean;
  approvalTimeoutMs: number;
  maxFailureRetries: number;
}

export interface ManualNeedView {
  key: string;
  at: number;
  reason: string;
}

export interface FallbackView {
  config: FallbackConfigView;
  envDisabled: boolean;
  manualNeeds: Record<string, { at: number; reason: string }>;
}

export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 24 * 60;
export const MAX_RETRY_LIMIT = 5;

/** 秒/毫秒 → 分钟（取整）；config 存毫秒，界面用分钟更直观。 */
export function msToMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

export function minutesToMs(minutes: number): number {
  return Math.round(minutes * 60_000);
}

/** manualNeeds → 有序列表（新的在前），供逐条清除。 */
export function manualNeedEntries(manualNeeds: FallbackView["manualNeeds"] | undefined): ManualNeedView[] {
  return Object.entries(manualNeeds ?? {})
    .map(([key, value]) => ({ key, at: value.at, reason: value.reason }))
    .sort((left, right) => right.at - left.at);
}

/** 把界面草稿折成 PUT body（毫秒换算在客户端完成）。 */
export function buildConfigBody(draft: { enabled: boolean; timeoutMinutes: number; maxFailureRetries: number }) {
  return {
    enabled: draft.enabled,
    approvalTimeoutMs: minutesToMs(draft.timeoutMinutes),
    maxFailureRetries: draft.maxFailureRetries,
  };
}

export function clearManualNeedsBody(keys: string[]) {
  return { action: "clear-manual-needs", keys };
}

/** 环境变量把兜底整体关掉时的提示（如实反映，不显示成开着）。 */
export function EnvDisabledNotice() {
  const { t } = useI18n();
  return (
    <p className="team-fallback-notice team-fallback-notice--env" role="status" data-testid="fallback-env-disabled">
      {t("teams.fallback.envDisabled")}
    </p>
  );
}

/** manualNeeds 列表：一条都没有时整块不渲染（不要空壳）。 */
export function ManualNeedsList({
  items,
  busyKey,
  onClear,
}: {
  items: ManualNeedView[];
  busyKey?: string | null;
  onClear: (key: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="team-fallback-manual" data-testid="fallback-manual-needs">
      <h4 className="team-fallback-subtitle">{t("teams.fallback.manualNeeds")}</h4>
      <ul className="team-fallback-manual-list">
        {items.map((item) => (
          <li key={item.key} className="team-fallback-manual-item" data-key={item.key}>
            <span className="team-fallback-manual-main">
              <span className="team-fallback-manual-key">{item.key}</span>
              <span className="team-fallback-manual-reason">{item.reason}</span>
              <time className="team-fallback-manual-time" dateTime={new Date(item.at).toISOString()}>
                {new Date(item.at).toLocaleString()}
              </time>
            </span>
            <button
              type="button"
              className="team-fallback-clear"
              disabled={busyKey === item.key}
              onClick={() => onClear(item.key)}
            >
              {t("teams.fallback.clear")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FallbackSettings() {
  const { t } = useI18n();
  const enabledId = useId();
  const timeoutId = useId();
  const retriesId = useId();

  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<FallbackView | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; timeoutMinutes: number; maxFailureRetries: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  const applyView = (next: FallbackView) => {
    setView(next);
    setDraft({
      enabled: next.config.enabled,
      timeoutMinutes: msToMinutes(next.config.approvalTimeoutMs),
      maxFailureRetries: next.config.maxFailureRetries,
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/teams/fallback", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as FallbackView;
        if (cancelled) return;
        applyView(payload);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(t("teams.fallback.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const items = useMemo(() => manualNeedEntries(view?.manualNeeds), [view]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSavedAt(false);
    try {
      const response = await fetch("/api/teams/fallback", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildConfigBody(draft)),
      });
      const payload = await response.json().catch(() => null) as (FallbackView & { error?: string }) | null;
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      if (payload) applyView(payload);
      setSavedAt(true);
    } catch (err) {
      setError(t("teams.fallback.requestFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  };

  const clear = async (key: string) => {
    setBusyKey(key);
    setError(null);
    try {
      const response = await fetch("/api/teams/fallback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(clearManualNeedsBody([key])),
      });
      const payload = await response.json().catch(() => null) as (FallbackView & { error?: string }) | null;
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      if (payload) applyView(payload);
    } catch (err) {
      setError(t("teams.fallback.requestFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) return <p className="scheduled-hint">{t("teams.fallback.loading")}</p>;
  if (!view || !draft) return <p className="scheduled-error" role="alert">{error ?? t("teams.fallback.loadFailed")}</p>;

  const controlsDisabled = view.envDisabled;

  return (
    <div className="team-fallback" data-testid="fallback-settings">
      <p className="scheduled-hint">{t("teams.fallback.hint")}</p>
      {view.envDisabled && <EnvDisabledNotice />}

      <div className="team-fallback-controls">
        <button
          type="button"
          id={enabledId}
          className="team-fallback-toggle"
          aria-pressed={draft.enabled}
          disabled={controlsDisabled}
          onClick={() => setDraft((current) => current && { ...current, enabled: !current.enabled })}
        >
          {t("teams.fallback.enabled")}
        </button>

        <label className="team-fallback-field" htmlFor={timeoutId}>
          <span className="team-fallback-field-label">{t("teams.fallback.timeout")}</span>
          <input
            id={timeoutId}
            className="team-fallback-input"
            type="number"
            min={MIN_TIMEOUT_MINUTES}
            max={MAX_TIMEOUT_MINUTES}
            value={draft.timeoutMinutes}
            disabled={controlsDisabled}
            onChange={(event) => {
              const value = Number(event.target.value);
              setDraft((current) => current && { ...current, timeoutMinutes: Number.isFinite(value) ? value : current.timeoutMinutes });
            }}
          />
        </label>

        <label className="team-fallback-field" htmlFor={retriesId}>
          <span className="team-fallback-field-label">{t("teams.fallback.retries")}</span>
          <input
            id={retriesId}
            className="team-fallback-input"
            type="number"
            min={0}
            max={MAX_RETRY_LIMIT}
            value={draft.maxFailureRetries}
            disabled={controlsDisabled}
            onChange={(event) => {
              const value = Number(event.target.value);
              setDraft((current) => current && { ...current, maxFailureRetries: Number.isFinite(value) ? value : current.maxFailureRetries });
            }}
          />
        </label>

        <button type="button" className="team-fallback-save" disabled={saving || controlsDisabled} onClick={() => void save()}>
          {saving ? t("teams.fallback.saving") : t("teams.fallback.save")}
        </button>
        {savedAt && <span className="team-fallback-saved" role="status">{t("teams.fallback.saved")}</span>}
      </div>

      {error && <p className="team-fallback-error" role="alert">{error}</p>}

      <ManualNeedsList items={items} busyKey={busyKey} onClear={(key) => void clear(key)} />
    </div>
  );
}
