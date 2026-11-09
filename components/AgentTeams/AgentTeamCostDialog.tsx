"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { dismissAgentTeamCostNotice } from "@/lib/agent-teams-notice";

/**
 * Agent Team 成本确认弹窗（A6 / A8）。
 *
 * 首次勾 composer 开关、或首次在设置里启用全局功能时弹一次：团队会开多个子会话、
 * 并行消耗 token 与时间，先让用户确认。勾「不再提醒」后 `lib/agent-teams-notice.ts`
 * 会记住，之后不再弹。
 *
 * 组件本身不做「要不要弹」的判断 —— 调用方在打开前用 `shouldShowAgentTeamCostNotice()`
 * 决定（设置里首次启用也要弹，所以判断留在调用点更灵活）。`open` 为 false 时渲染 null。
 */
interface Props {
  open: boolean;
  /** 用户确认继续（勾了「不再提醒」时，先记住再回调）。 */
  onConfirm(): void;
  /** 用户取消（不开团队）。 */
  onCancel(): void;
}

export function AgentTeamCostDialog({ open, onConfirm, onCancel }: Props) {
  const { t } = useI18n();
  // 每次打开都从「不勾」开始：偏好本身由 lib/agent-teams-notice 持久化，这里只管这一次。
  const [dontRemind, setDontRemind] = useState(false);
  useEffect(() => {
    if (open) setDontRemind(false);
  }, [open]);

  if (!open) return null;

  const settle = (confirmed: boolean) => {
    if (dontRemind) dismissAgentTeamCostNotice();
    if (confirmed) onConfirm();
    else onCancel();
  };

  return (
    <div
      className="agent-team-cost-backdrop"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) settle(false); }}
    >
      <div
        className="agent-team-cost-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.agentTeam.cost.title")}
      >
        <h3 className="agent-team-cost-title">{t("chat.agentTeam.cost.title")}</h3>
        <p className="agent-team-cost-body">{t("chat.agentTeam.cost.body")}</p>
        <label className="agent-team-cost-remember">
          <input
            type="checkbox"
            checked={dontRemind}
            onChange={(event) => setDontRemind(event.target.checked)}
          />
          <span>{t("chat.agentTeam.cost.dontRemind")}</span>
        </label>
        <div className="agent-team-cost-actions">
          <button type="button" className="agent-team-cost-cancel" onClick={() => settle(false)}>
            {t("i18n.cancel")}
          </button>
          <button type="button" className="agent-team-cost-confirm native-primary-button" onClick={() => settle(true)}>
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
