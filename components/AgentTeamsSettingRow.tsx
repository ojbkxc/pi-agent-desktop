"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useAgentTeamsEnabled, setAgentTeamsEnabled } from "@/hooks/useAgentTeamsEnabled";
import { shouldShowAgentTeamCostNotice } from "@/lib/agent-teams-notice";
import { ConfigSwitch } from "./SettingsUi";
import { AgentTeamCostDialog } from "./AgentTeams/AgentTeamCostDialog";

/**
 * Settings › General › Chat：Agent Team 的**全局可用性**开关（A1 / A8）。
 *
 * 语义已从旧的「下一条消息用团队」（单条 armed）改为**全局**：它只决定 composer 上要不
 * 要提供团队开关。真正的单条 armed 在 composer 上（默认关、按会话隔离，见
 * `hooks/useAgentTeamsEnabled.ts` 的 `useAgentTeamsArmed`）。
 *
 * 与相邻的 Artifacts / Auto-title 不同，这一项**不落服务端**：包装发生在浏览器里、发送
 * 之前（`components/ChatInput.tsx` 的 handleSend），所以偏好存在 localStorage。
 *
 * 「开启时也弹一次成本确认」（A8）：首次启用时弹 `AgentTeamCostDialog`，与 composer 首次
 * arm 共用同一份「不再提醒」偏好（`lib/agent-teams-notice.ts`）；勾了「不再提醒」后两处
 * 都不再弹。
 */
export function AgentTeamsSettingRow() {
  const { t } = useI18n();
  const enabled = useAgentTeamsEnabled();
  const [costDialogOpen, setCostDialogOpen] = useState(false);
  const title = t("settings.agentTeams.title");

  const onChange = (next: boolean) => {
    if (!next) {
      setAgentTeamsEnabled(false);
      return;
    }
    // 首次启用会开启一个会开多个子会话、并行烧 token 的功能，先确认一次。
    if (shouldShowAgentTeamCostNotice()) {
      setCostDialogOpen(true);
      return;
    }
    setAgentTeamsEnabled(true);
  };

  return (
    <div className="settings-chat-option settings-chat-switch-option artifacts-setting-row">
      <span className="artifacts-setting-text">
        <span>{title}</span>
        <span className="artifacts-setting-hint">{t("settings.agentTeams.description")}</span>
      </span>
      <ConfigSwitch
        checked={enabled}
        label={title}
        onChange={onChange}
      />
      <AgentTeamCostDialog
        open={costDialogOpen}
        onConfirm={() => { setCostDialogOpen(false); setAgentTeamsEnabled(true); }}
        onCancel={() => setCostDialogOpen(false)}
      />
    </div>
  );
}
