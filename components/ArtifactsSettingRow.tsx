"use client";

import { useI18n } from "@/hooks/useI18n";
import { ServerSwitchSettingRow } from "./ServerSwitchSettingRow";

/**
 * Settings › General › Chat: whether sessions tell the model it can answer
 * with artifacts. Rendering `:::artifact` blocks does not depend on it.
 */
export function ArtifactsSettingRow() {
  const { t } = useI18n();
  return (
    <ServerSwitchSettingRow
      endpoint="/api/artifacts/settings"
      label={t("settings.artifacts")}
      hint={t("settings.artifactsHint")}
      failedHint={t("settings.artifactsFailed")}
      defaultEnabled
    />
  );
}

/**
 * Settings › General › Chat: whether sessions get the behavior-guide section
 * (concise-first replies, coding discipline, safety). See
 * lib/agent-guide-extension.ts; the text is English on purpose (server-side).
 */
export function AgentGuideSettingRow() {
  const { t } = useI18n();
  return (
    <ServerSwitchSettingRow
      endpoint="/api/agent-guide/settings"
      label={t("settings.agentGuide")}
      hint={t("settings.agentGuideHint")}
      failedHint={t("settings.agentGuideFailed")}
      defaultEnabled
    />
  );
}

/**
 * Settings › General › Chat: name a session automatically after its first
 * completed turn (#201). The server does it; see `autoTitleAfterRun()`.
 */
export function AutoTitleSettingRow() {
  const { t } = useI18n();
  return (
    <ServerSwitchSettingRow
      endpoint="/api/session-title/settings"
      label={t("settings.autoTitle")}
      hint={t("settings.autoTitleHint")}
      failedHint={t("settings.autoTitleFailed")}
      defaultEnabled={false}
    />
  );
}
