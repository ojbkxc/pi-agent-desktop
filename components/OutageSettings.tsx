"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "./AppSelect";
import { ConfigSwitch } from "./SettingsUi";
import { ConfirmDangerButton } from "./ConfirmDangerButton";

/**
 * Settings › General › Provider outage recovery —— 模型 API 连续不可用（几分钟到
 * 几小时）时会话自动挂起等待，服务恢复后接着干（docs/agents/fork-provider-outage-resume.md）。
 *
 * 自包含：数据全走 `/api/outage`，不依赖 SettingsPanel 的 props（插入位置由 integrator
 * 决定）。**不要** import `lib/outage/store.ts`（含 node:fs），类型就地声明。
 *
 * 默认值：开关**开启**、最长等待 6 小时、额度类 24 小时（与服务端
 * `OUTAGE_SETTINGS_DEFAULTS` 一致；服务端是唯一真源，这里只做展示与提交）。
 */

export interface OutageSettingsValue {
  enabled: boolean;
  maxWaitHours: number;
  /** 0 = 不等待额度恢复（额度类直接按失败上报）。 */
  quotaMaxWaitHours: number;
}

interface OutageStatus {
  settings: OutageSettingsValue;
  maxWaitHoursOptions: readonly number[];
  waiting: number;
  local: boolean;
}

const FALLBACK_OPTIONS = [1, 2, 6, 24] as const;

export function OutageSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<OutageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/outage");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus((await response.json()) as OutageStatus);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<OutageSettingsValue>) => {
    if (!status) return;
    setBusy(true);
    try {
      const response = await fetch("/api/outage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "settings", settings: { ...status.settings, ...patch } }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { settings: OutageSettingsValue };
      setStatus({ ...status, settings: data.settings });
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const local = status?.local !== false;
  const disabled = busy || !local || !status;
  const settings = status?.settings;
  const hoursOptions = status?.maxWaitHoursOptions ?? FALLBACK_OPTIONS;

  const hourOptions = hoursOptions.map((hours) => ({
    value: String(hours),
    label: t("outage.hours", { hours }),
  }));

  const quotaOptions = [
    { value: "0", label: t("outage.quotaOff") },
    ...hourOptions,
  ];

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("outage.title")}</h3>
      <p className="settings-general-description">{t("outage.hint")}</p>
      <div className="settings-option-list">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("outage.enabled")}</span>
            <span className="settings-option-hint" role="status">
              {failed ? t("outage.saveFailed") : t("outage.enabledHint")}
            </span>
            {!local && <span className="settings-option-hint">{t("outage.localOnly")}</span>}
          </span>
          <ConfigSwitch
            checked={settings?.enabled === true}
            disabled={disabled}
            label={t("outage.enabled")}
            onChange={(checked) => void save({ enabled: checked })}
          />
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("outage.maxWait")}</span>
            <span className="settings-option-hint">{t("outage.maxWaitHint")}</span>
          </span>
          <AppSelect
            aria-label={t("outage.maxWait")}
            value={String(settings?.maxWaitHours ?? 6)}
            onValueChange={(next) => void save({ maxWaitHours: Number(next) })}
            options={hourOptions}
            disabled={disabled}
          />
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("outage.quotaMaxWait")}</span>
            <span className="settings-option-hint">{t("outage.quotaMaxWaitHint")}</span>
          </span>
          <AppSelect
            aria-label={t("outage.quotaMaxWait")}
            value={String(settings?.quotaMaxWaitHours ?? 24)}
            onValueChange={(next) => void save({ quotaMaxWaitHours: Number(next) })}
            options={quotaOptions}
            disabled={disabled}
          />
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-hint" role="status">
              {t("outage.waitingCount", { count: status?.waiting ?? 0 })}
            </span>
            <span className="settings-option-hint">{t("outage.capHint")}</span>
          </span>
          {status && status.waiting > 0 && (
            <ConfirmDangerButton
              label={t("outage.cancelAll")}
              confirmLabel={t("settings.confirmCancelAll")}
              busyLabel={t("i18n.saving")}
              busy={busy}
              disabled={busy || !local}
              className="config-button config-button-danger config-button-small"
              onConfirm={() => {
                setBusy(true);
                void fetch("/api/outage", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "cancel-all" }),
                })
                  .then(() => load())
                  .catch(() => setFailed(true))
                  .finally(() => setBusy(false));
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}