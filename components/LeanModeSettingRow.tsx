"use client";

import { useI18n } from "@/hooks/useI18n";
import { ServerSwitchSettingRow } from "./ServerSwitchSettingRow";

/**
 * Settings › General › Chat：全局「极简档」，对齐 cc-haha 的 lean 档。
 *
 * 打开后，新建或重开的会话都不加载扩展（因此没有 MCP / codemode / 团队 / LSP 工具）、
 * 不加载技能与上下文文件，只留内置的编码工具。真源在服务端（`lib/lean-mode.ts`），
 * 所以重开旧会话同样生效 —— 也因此这一项走接口而不是 localStorage。
 */
export function LeanModeSettingRow() {
  const { t } = useI18n();
  return (
    <ServerSwitchSettingRow
      endpoint="/api/lean-mode"
      label={t("settings.leanMode")}
      hint={t("settings.leanModeHint")}
      failedHint={t("settings.leanModeFailed")}
      defaultEnabled={false}
    />
  );
}
