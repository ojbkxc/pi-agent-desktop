"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * 团队并发上限（teamQuota）的设置面。
 *
 * 数据来自 GET /api/teams/quota（{ quota, sources, sourceHints, envNames, ranges, defaults }）。
 * 修改走 PUT /api/teams/quota（{ perTeamLimit?, globalLimit? }）。
 *
 * 取值优先级：env > 设置项 > 默认。env 顶掉的项必须禁用输入并如实提示
 * 「由环境变量 PI_TEAM_MAX_* 决定」，不能让人以为「改了不生效」是 bug。
 */

export interface TeamQuotaRange {
  min: number;
  max: number;
}

export interface TeamQuotaView {
  quota: { perTeamLimit: number; globalLimit: number };
  sources: { perTeamLimit: "env" | "settings" | "default"; globalLimit: "env" | "settings" | "default" };
  sourceHints: { perTeamLimit: string; globalLimit: string };
  envNames: { perTeamLimit: string; globalLimit: string };
  defaults: { perTeamLimit: number; globalLimit: number };
  ranges: { perTeamLimit: TeamQuotaRange; globalLimit: TeamQuotaRange };
  spawnConcurrency: number;
  globalWorkers: number | null;
}

export interface TeamQuotaDraft {
  perTeamLimit: number;
  globalLimit: number;
}

/** 把界面草稿折成 PUT body（数字输入；范围由 UI min/max 属性 + server 双层把关）。 */
export function buildQuotaBody(draft: TeamQuotaDraft) {
  return { perTeamLimit: draft.perTeamLimit, globalLimit: draft.globalLimit };
}

/** 当前生效值 + 来源徽标。env 顶掉时禁用输入。 */
export function QuotaRow({
  label,
  value,
  source,
  sourceHint,
  envName,
  range,
  disabled,
  onChange,
  id,
}: {
  label: string;
  value: number;
  source: "env" | "settings" | "default";
  sourceHint: string;
  envName: string;
  range: TeamQuotaRange;
  disabled: boolean;
  onChange: (next: number) => void;
  id: string;
}) {
  const { t } = useI18n();
  const sourceKey = `teams.quota.source.${source}`;
  return (
    <div className="team-quota-row" data-source={source}>
      <label className="team-quota-field" htmlFor={id}>
        <span className="team-quota-field-label">{label}</span>
        <input
          id={id}
          className="team-quota-input"
          type="number"
          min={range.min}
          max={range.max}
          value={value}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
      </label>
      <span className={`team-quota-source team-quota-source--${source}`} data-testid={`quota-source-${source}`}>
        {t(sourceKey)}
      </span>
      <p className="team-quota-hint" id={`${id}-hint`}>
        {sourceHint}
        {source === "env" ? ` (${envName})` : ""}
      </p>
    </div>
  );
}

export function QuotaSettings() {
  const { t } = useI18n();
  const perTeamId = useId();
  const globalId = useId();

  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<TeamQuotaView | null>(null);
  const [draft, setDraft] = useState<TeamQuotaDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const applyView = (next: TeamQuotaView) => {
    setView(next);
    setDraft({
      perTeamLimit: next.quota.perTeamLimit,
      globalLimit: next.quota.globalLimit,
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/teams/quota", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as TeamQuotaView;
        if (cancelled) return;
        applyView(payload);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSavedAt(false);
    setWarning(null);
    try {
      const response = await fetch("/api/teams/quota", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildQuotaBody(draft)),
      });
      const payload = (await response.json().catch(() => null)) as
        | (TeamQuotaView & { error?: string; warning?: string })
        | null;
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      if (payload) {
        applyView(payload);
        if (payload.warning) setWarning(payload.warning);
      }
      setSavedAt(true);
    } catch (err) {
      setError(t("teams.quota.requestFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="scheduled-hint">{t("teams.quota.loading")}</p>;
  if (!view || !draft) {
    return (
      <p className="scheduled-error" role="alert">
        {loadError !== null ? t("teams.quota.loadFailed") : error ?? t("teams.quota.loadFailed")}
      </p>
    );
  }

  const perTeamDisabled = view.sources.perTeamLimit === "env";
  const globalDisabled = view.sources.globalLimit === "env";
  const anyDisabled = perTeamDisabled || globalDisabled;

  return (
    <div className="team-quota" data-testid="quota-settings">
      <p className="scheduled-hint">{t("teams.quota.hint")}</p>

      <div className="team-quota-rows">
        <QuotaRow
          id={perTeamId}
          label={t("teams.quota.perTeamLimit")}
          value={draft.perTeamLimit}
          source={view.sources.perTeamLimit}
          sourceHint={view.sourceHints.perTeamLimit}
          envName={view.envNames.perTeamLimit}
          range={{ min: 1, max: 128 }}
          disabled={perTeamDisabled}
          onChange={(next) => setDraft((current) => current && { ...current, perTeamLimit: next })}
        />
        <QuotaRow
          id={globalId}
          label={t("teams.quota.globalLimit")}
          value={draft.globalLimit}
          source={view.sources.globalLimit}
          sourceHint={view.sourceHints.globalLimit}
          envName={view.envNames.globalLimit}
          range={{ min: 1, max: 128 }}
          disabled={globalDisabled}
          onChange={(next) => setDraft((current) => current && { ...current, globalLimit: next })}
        />
      </div>

      {view.globalWorkers !== null && (
        <p className="team-quota-usage">
          {t("teams.quota.usage", { current: view.globalWorkers, limit: view.quota.globalLimit })}
        </p>
      )}

      <div className="team-quota-actions">
        <button
          type="button"
          className="team-quota-save"
          disabled={saving || anyDisabled}
          onClick={() => void save()}
        >
          {saving ? t("teams.quota.saving") : t("teams.quota.save")}
        </button>
        {savedAt && !warning && (
          <span className="team-quota-saved" role="status">
            {t("teams.quota.saved")}
          </span>
        )}
      </div>

      {warning && (
        <p className="team-quota-warning" role="status">
          {warning}
        </p>
      )}
      {error && (
        <p className="team-quota-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
