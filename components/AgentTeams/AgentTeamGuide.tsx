"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * A9 一次性发现引导（composer 上方一条可关闭的横条）。
 *
 * 纯展示组件：**不自己读写 storage**。「是否还需要展示」由调用方用
 * `lib/agent-teams-guide.ts`（`shouldShowAgentTeamGuide()` 等）判断，本组件只负责外观
 * 与两个动作回调：
 * - `onEnable()`：点主按钮「开启」——调用方 arm 团队，并记下「引导已看过」；
 * - `onDismiss()`：点关闭按钮——调用方记下「用户已拒绝」。
 *
 * 文案走三语 i18n（`chat.agentTeam.guide.*`）。样式内联 + 主题 CSS 变量，不新增全局类；
 * 挂载点（ChatInput.tsx）由 lead 协调，本文件不挂载。
 */
interface Props {
  onEnable: () => void;
  onDismiss: () => void;
}

type TFn = (key: string) => string;

const S: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 10px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
  },
  text: { display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 },
  title: { fontSize: 12.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.3 },
  body: { fontSize: 12, color: "var(--text-muted)", lineHeight: 1.3 },
  enable: {
    flex: "0 0 auto",
    border: "none",
    borderRadius: 7,
    padding: "4px 10px",
    background: "var(--accent)",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: 1.2,
  },
  dismiss: {
    flex: "0 0 auto",
    border: "none",
    background: "transparent",
    color: "var(--text-dim)",
    fontSize: 12,
    cursor: "pointer",
    padding: "4px 6px",
    lineHeight: 1.2,
  },
};

/**
 * 纯视图（不含 hook），便于单测直接调用并遍历元素树验证回调接线。
 */
export function agentTeamGuideView(t: TFn, onEnable: () => void, onDismiss: () => void) {
  return (
    <div className="agent-team-guide" data-testid="agent-team-guide" role="note" style={S.bar}>
      <div className="agent-team-guide-text" style={S.text}>
        <span className="agent-team-guide-title" style={S.title}>
          {t("chat.agentTeam.guide.title")}
        </span>
        <span className="agent-team-guide-body" style={S.body}>
          {t("chat.agentTeam.guide.body")}
        </span>
      </div>
      <button type="button" className="agent-team-guide-enable" onClick={onEnable} style={S.enable}>
        {t("chat.agentTeam.guide.action")}
      </button>
      <button
        type="button"
        className="agent-team-guide-dismiss"
        onClick={onDismiss}
        title={t("chat.agentTeam.guide.dismiss")}
        style={S.dismiss}
      >
        {t("chat.agentTeam.guide.dismiss")}
      </button>
    </div>
  );
}

export function AgentTeamGuide({ onEnable, onDismiss }: Props) {
  const { t } = useI18n();
  return agentTeamGuideView(t, onEnable, onDismiss);
}
