"use client";

import { useI18n } from "@/hooks/useI18n";
import { ServerSwitchSettingRow } from "./ServerSwitchSettingRow";

/**
 * Settings › General › Chat：全局「无人值守模式」（autopilot）。
 *
 * 真源在服务端（`lib/autopilot.ts` 写在 `pi-web/settings.json`）。开启后：
 * - 由定时任务 / 自动修复发起的会话，其团队计划自动批准（手动会话仍走人工审阅）；
 * - 定时任务失败且目录是可验证的仓库时，自动创建一个自动修复任务。
 */
export function AutopilotSettingRow() {
  const { t } = useI18n();
  return (
    <ServerSwitchSettingRow
      endpoint="/api/autopilot"
      label={t("settings.autopilot")}
      hint={t("settings.autopilotHint")}
      failedHint={t("settings.autopilotFailed")}
      defaultEnabled={false}
    />
  );
}
