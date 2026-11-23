"use client";

import { useCallback, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";
import type { PurgeSettings } from "./PurgeConsoleSection";

/**
 * 破甲控制台的「试跑」面板：把一段样例文本按**草稿**设置过一遍，左右对照改写前后。
 *
 * 为什么值得存在：这些开关（改写表、同义词、前缀剥离、技能注入、结构化后缀、
 * 按模型自动套用）光看名字推不出「我的请求会变成什么样」，而以前只能保存 → 发一轮
 * → 回头看；保存是全局生效的，调错一次整个会话都被改。试跑把「先看再保存」补上，
 * 且**不写任何东西**——服务端只是拿同一批纯函数算一遍（`lib/purge/preview.ts`）。
 *
 * 纪律：
 * - 只读端点，但仍按写路由配齐闸门（403/415/400）；
 * - 草稿变化后不自动重跑：试跑要花钱（一次网络往返 + 服务端治理），由用户点。
 *   顶部会提示「草稿已改，结果可能过期」，避免把旧结果当成新设置的答案。
 * - system 侧与 user 侧分开跑：预设正文只拼在系统提示词上，用户消息里永远看不到。
 */
export function PurgePreviewPanel({
  draft,
  model,
  dirty,
  disabled,
}: {
  draft: PurgeSettings;
  model?: string;
  dirty: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"user" | "system">("user");
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 发起试跑那一刻的草稿版本：与当前草稿不一致时提示「结果可能过期」。 */
  const [ranWith, setRanWith] = useState<string | null>(null);

  const draftKey = useMemo(() => JSON.stringify(draft), [draft]);
  const stale = result !== null && ranWith !== draftKey;

  const run = useCallback(() => {
    setRunning(true);
    setError(null);
    const snapshot = draftKey;
    fetch("/api/purge/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, kind, settings: draft, ...(model ? { model } : {}) }),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: unknown) => {
        const preview = asPreviewEnvelope(data);
        if (!preview) {
          setError(t("purge.previewFailed"));
          return;
        }
        setResult(preview);
        setRanWith(snapshot);
      })
      .catch(() => setError(t("purge.previewFailed")))
      .finally(() => setRunning(false));
  }, [draft, draftKey, kind, model, t, text]);

  return (
    <section className="settings-general-section settings-purge-preview">
      <h3 className="settings-general-heading">{t("purge.previewHeading")}</h3>
      <p className="settings-general-description">{t("purge.previewHint")}</p>

      {/* 两侧分开：system 走宿主提示词那一半治理（并可能套预设），user 走另一条。 */}
      <div className="settings-purge-floor" role="group" aria-label={t("purge.previewKind")}>
        {(["user", "system"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`settings-purge-floor-btn${kind === value ? " is-active" : ""}`}
            aria-pressed={kind === value}
            disabled={disabled}
            onClick={() => setKind(value)}
          >
            {t(value === "user" ? "purge.previewKindUser" : "purge.previewKindSystem")}
          </button>
        ))}
      </div>

      <div className="settings-purge-field">
        <label htmlFor="settings-purge-preview-text">{t("purge.previewSample")}</label>
        <textarea
          id="settings-purge-preview-text"
          className="settings-chats-control settings-purge-textarea"
          rows={5}
          aria-label={t("purge.previewSample")}
          placeholder={t("purge.previewSamplePlaceholder")}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
        <span className="settings-chats-hint">{t("purge.previewSampleHint")}</span>
      </div>

      <div className="settings-purge-actions">
        <ConfigButton variant="secondary" size="small" disabled={disabled || running} onClick={run}>
          {running ? t("purge.previewRunning") : t("purge.previewRun")}
        </ConfigButton>
        <span className="settings-chats-hint" role="status">
          {stale && dirty ? t("purge.previewStale") : result?.passthrough ? t("purge.previewPassthrough") : ""}
        </span>
      </div>

      {error && <p role="alert" className="settings-general-error">{error}</p>}

      {result && (
        <>
          <div className="settings-purge-preview-pair">
            <div className="settings-purge-preview-side">
              <span className="settings-purge-preview-label">{t("purge.previewBefore")}</span>
              <pre className="settings-purge-preview-text" aria-label={t("purge.previewBefore")}>{result.input}</pre>
            </div>
            <div className="settings-purge-preview-side">
              <span className="settings-purge-preview-label">{t("purge.previewAfter")}</span>
              <pre className="settings-purge-preview-text" aria-label={t("purge.previewAfter")}>{result.output}</pre>
            </div>
          </div>
          <dl className="settings-purge-stats">
            <div className="settings-purge-stat">
              <dt>{t("purge.previewDelta")}</dt>
              <dd>{result.deltaChars > 0 ? `+${result.deltaChars}` : String(result.deltaChars)}</dd>
            </div>
            <div className="settings-purge-stat">
              <dt>{t("purge.statRewriteHits")}</dt>
              <dd>{result.rewrite_hits}</dd>
            </div>
            <div className="settings-purge-stat">
              <dt>{t("purge.statSynonymHits")}</dt>
              <dd>{result.synonym_hits}</dd>
            </div>
            <div className="settings-purge-stat">
              <dt>{t("purge.statSkillHits")}</dt>
              <dd>{result.skill_hits}</dd>
            </div>
          </dl>
          {result.auto_preset && (
            <p className="settings-general-description" role="status">
              {t("purge.previewAutoPreset", { title: result.auto_preset.title, match: result.auto_preset.match })}
            </p>
          )}
        </>
      )}
    </section>
  );
}

interface PreviewResult {
  passthrough: boolean;
  input: string;
  output: string;
  deltaChars: number;
  rewrite_hits: number;
  synonym_hits: number;
  skill_hits: number;
  structured: boolean;
  auto_preset: { id: string; title: string; match: string } | null;
}

/** 宽容解析：字段缺失就补默认，绝不让一次预览把面板打崩。 */
export function asPreviewEnvelope(raw: unknown): PreviewResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const preview = (raw as { preview?: unknown }).preview;
  if (typeof preview !== "object" || preview === null) return null;
  const record = preview as Record<string, unknown>;
  const asCount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const asText = (value: unknown): string => (typeof value === "string" ? value : "");
  const auto = record.auto_preset;
  return {
    passthrough: record.passthrough === true,
    input: asText(record.input),
    output: asText(record.output),
    deltaChars: typeof record.deltaChars === "number" && Number.isFinite(record.deltaChars) ? record.deltaChars : 0,
    rewrite_hits: asCount(record.rewrite_hits),
    synonym_hits: asCount(record.synonym_hits),
    skill_hits: asCount(record.skill_hits),
    structured: record.structured === true,
    auto_preset: typeof auto === "object" && auto !== null
      ? {
        id: asText((auto as Record<string, unknown>).id),
        title: asText((auto as Record<string, unknown>).title),
        match: asText((auto as Record<string, unknown>).match),
      }
      : null,
  };
}