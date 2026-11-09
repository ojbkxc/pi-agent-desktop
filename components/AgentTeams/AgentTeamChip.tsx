"use client";

import { useI18n } from "@/hooks/useI18n";

/**
 * Agent Team 的 armed 标记 chip（A3 / A5）。
 *
 * - `composer`（默认）：显示在 composer 上，表示「下一条消息会用团队」；带 `onRemove`
 *   时右侧有 ✕，点一下撤掉这次 armed（A5 编辑态就靠它：编辑一条带团队块的旧消息时会
 *   自动 armed，✕ = 这次重发不套团队块）。
 * - `message`：显示在消息气泡旁，只读地标记「这条消息当初请求了团队」。
 *
 * 有 `onRemove` = 可摘（带 ✕）；没有 = 只读。绝不渲染成死按钮。
 */
interface Props {
  /** 提供则可摘：点击 ✕ 撤掉这次 armed。 */
  onRemove?(): void;
  /** 触屏（窄屏）档：由 CSS 决定是否放大点击区域。 */
  touch?: boolean;
  variant?: "composer" | "message";
  /** 覆盖默认标签；缺省仍是 `chat.agentTeam.chip`。消息气泡用它显式写「已请求团队」。 */
  label?: string;
}

export function AgentTeamChip({ onRemove, touch = false, variant = "composer", label }: Props) {
  const { t } = useI18n();
  const text = label ?? t("chat.agentTeam.chip");

  const className = [
    "composer-teams-chip",
    "is-armed",
    `composer-teams-chip--${variant}`,
    touch ? "is-touch" : "",
    onRemove ? "is-removable" : "",
  ].filter(Boolean).join(" ");

  return (
    <span className={className} data-agent-team-chip={variant}>
      <svg
        className="composer-teams-chip-icon"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span className="composer-teams-chip-label">{text}</span>
      {onRemove && (
        <button
          type="button"
          className="composer-teams-chip-remove"
          onClick={onRemove}
          title={t("chat.agentTeam.chipRemove")}
          aria-label={t("chat.agentTeam.chipRemove")}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <line x1="1" y1="1" x2="7" y2="7" />
            <line x1="7" y1="1" x2="1" y2="7" />
          </svg>
        </button>
      )}
    </span>
  );
}
