"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigSwitch } from "./SettingsUi";

/**
 * Settings › General › Chat：全局「无人值守模式」（autopilot）。
 *
 * 真源在服务端（`lib/autopilot.ts` 写在 `pi-web/settings.json`）。开启后：
 * - 由定时任务 / 自动修复发起的会话，其团队计划自动批准（手动会话仍走人工审阅）；
 * - 定时任务失败且目录是可验证的仓库时，自动创建一个自动修复任务。
 *
 * 本区块把总开关与三个子开关（团队计划自动批准 / 失败自动修复 / 修复轮次上限）
 * 一并暴露；子开关在总开关关闭时禁用。
 */
export interface AutopilotSettingsValue {
  enabled: boolean;
  autoApproveTeamPlans: boolean;
  autoFixFailedRuns: boolean;
  maxAutoFixRounds: number;
}

const MAX_AUTO_FIX_ROUNDS = 20;

export function AutopilotSettingRow() {
  const { t } = useI18n();
  const [value, setValue] = useState<AutopilotSettingsValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/autopilot");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setValue((await response.json()) as AutopilotSettingsValue);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<AutopilotSettingsValue>) => {
    if (!value) return;
    setBusy(true);
    try {
      const response = await fetch("/api/autopilot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...value, ...patch }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setValue((await response.json()) as AutopilotSettingsValue);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const enabled = value?.enabled === true;
  const disabled = busy || !value;
  const subDisabled = disabled || !enabled;

  const hintId = useId();
  const maxRoundsId = useId();

  return (
    <div className="settings-chat-option settings-chat-switch-option artifacts-setting-row">
      <span className="artifacts-setting-text">
        <span>{t("settings.autopilot")}</span>
        <span id={hintId} className="artifacts-setting-hint" role="status" aria-live="polite">
          {failed ? t("settings.autopilotFailed") : t("settings.autopilotHint")}
        </span>
      </span>
      <ConfigSwitch
        checked={enabled}
        disabled={disabled}
        label={t("settings.autopilot")}
        describedBy={hintId}
        onChange={(checked) => void save({ enabled: checked })}
      />

      <div className="settings-autopilot-suboptions">
        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("settings.autopilotAutoApproveTeamPlans")}</span>
            <span className="settings-option-hint">{t("settings.autopilotAutoApproveTeamPlansHint")}</span>
          </span>
          <ConfigSwitch
            checked={value?.autoApproveTeamPlans === true}
            disabled={subDisabled}
            label={t("settings.autopilotAutoApproveTeamPlans")}
            onChange={(checked) => void save({ autoApproveTeamPlans: checked })}
          />
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <span className="settings-option-title">{t("settings.autopilotAutoFixFailedRuns")}</span>
            <span className="settings-option-hint">{t("settings.autopilotAutoFixFailedRunsHint")}</span>
          </span>
          <ConfigSwitch
            checked={value?.autoFixFailedRuns === true}
            disabled={subDisabled}
            label={t("settings.autopilotAutoFixFailedRuns")}
            onChange={(checked) => void save({ autoFixFailedRuns: checked })}
          />
        </div>

        <div className="settings-option">
          <span className="settings-option-text">
            <label id={maxRoundsId} htmlFor="settings-autopilot-max-rounds" className="settings-option-title">
              {t("settings.autopilotMaxAutoFixRounds")}
            </label>
            <span className="settings-option-hint">{t("settings.autopilotMaxAutoFixRoundsHint")}</span>
          </span>
          <input
            id="settings-autopilot-max-rounds"
            type="number"
            min={1}
            max={MAX_AUTO_FIX_ROUNDS}
            step={1}
            value={value?.maxAutoFixRounds ?? 12}
            disabled={subDisabled}
            aria-labelledby={maxRoundsId}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next >= 1 && next <= MAX_AUTO_FIX_ROUNDS) {
                void save({ maxAutoFixRounds: next });
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
