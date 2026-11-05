"use client";

import { useI18n } from "@/hooks/useI18n";
import { useAgentTeamsEnabled, setAgentTeamsEnabled } from "@/hooks/useAgentTeamsEnabled";
import { ConfigSwitch } from "./SettingsUi";

/**
 * Settings › General › Chat：Agent Team 开关。
 *
 * **默认开**。开启时，composer 发出的每条消息会前置一段团队指令
 * （`lib/agent-team-request.ts`），让模型建团队、把目标拆成有明确 owner 的任务再推进；
 * 关掉之后消息按原样发送，模型只当普通对话处理。
 *
 * 与相邻的 Artifacts / Auto-title 不同，这一项**不落服务端**：包装发生在浏览器里、
 * 发送之前（`components/ChatInput.tsx` 的 handleSend），所以偏好与发送键模式一样存在
 * localStorage。
 */
export function AgentTeamsSettingRow() {
  const { t } = useI18n();
  const enabled = useAgentTeamsEnabled();
  return (
    <div className="settings-chat-option settings-chat-switch-option">
      <span>{t("settings.agentTeams")}</span>
      <ConfigSwitch
        checked={enabled}
        label={t("settings.agentTeams")}
        onChange={(next) => setAgentTeamsEnabled(next)}
      />
    </div>
  );
}
