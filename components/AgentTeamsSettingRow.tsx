"use client";

import { useI18n } from "@/hooks/useI18n";
import { useAgentTeamsEnabled, setAgentTeamsEnabled } from "@/hooks/useAgentTeamsEnabled";
import { ConfigSwitch } from "./SettingsUi";

/**
 * Settings › General › Chat：Agent Team 的 armed 开关。
 *
 * **一次性 armed**（对齐 cc-haha）：勾选表示「**下一条**消息用团队处理」——发送一条
 * 带团队指令的消息后自动复位关，后续闲聊按原样发送，不在每轮累积建团指令。命令类
 * 消息（`/`、`!`）不被包装，也不消耗这次勾选。开启时 composer 发出的那条消息会前置
 * 团队指令（`lib/agent-team-request.ts`），让模型建团队、把目标拆成有明确 owner 的任务
 * 再推进。
 *
 * 与相邻的 Artifacts / Auto-title 不同，这一项**不落服务端**：包装发生在浏览器里、
 * 发送之前（`components/ChatInput.tsx` 的 handleSend），所以偏好与发送键模式一样存在
 * localStorage。首次使用时默认开，复位后写回 "false"。
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
