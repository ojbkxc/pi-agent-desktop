"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * composer 工具栏上的 Agent Team 开关（A2）。
 *
 * 语义是「**下一条**消息用团队处理」的单条 armed（一次性）：点一下勾上，发出去即复位。
 * 全局可用性（`hooks/useAgentTeamsEnabled.ts` 的 `useAgentTeamsEnabled`）**不决定显不显示**，
 * 只决定这一行能不能勾 —— 与 cc-haha 一致：全局关掉时那行仍然在，但**不是开关**，点击去设置
 * （`capabilityMenuModel.ts:391-408`：the row leads there instead of arming a mode the
 * session would not honour）。只有成员会话 / 极简档才整行隐藏。
 *
 * - `available === true`：**真开关**（`role="switch"` + `aria-checked`），右侧带一条 cc-haha
 *   形态的 Switch 轨道（`composer-teams-toggle-track`），点击 → `onToggle()`；armed 时轨道填
 *   accent、滑块右移。用户口径：「聊天页这个应该是个开关，打开后当前发送的就带着」。
 * - `available === false`：置灰（不做死按钮）——鼠标悬停用 tooltip 说明原因，点击跳设置
 *   （`onOpenSettings`）。这一档只是一个**去设置的动作行**，不冒充开关，所以不落 role /
 *   aria-checked。原因由 `disabledReason` 决定（chatOnly / disabled / lean / memberSession）。
 */

export type AgentTeamUnavailableReason = "chatOnly" | "disabled" | "lean" | "memberSession";

interface Props {
  /** 这一条是否已勾上（会带上团队指令）。 */
  armed: boolean;
  /** 当前会话是否允许使用团队开关。 */
  available: boolean;
  /** 不可用原因；决定 tooltip 文案。 */
  disabledReason?: AgentTeamUnavailableReason;
  /** 可用时的切换回调。 */
  onToggle(): void;
  /** 不可用时点击跳到设置（让置灰按钮不是死的）。 */
  onOpenSettings?(): void;
}

/** 不可用原因 → i18n key（文案由 lead 统一加进 messages）。 */
const REASON_KEY: Record<AgentTeamUnavailableReason, string> = {
  chatOnly: "chat.agentTeam.unavailable.chatOnly",
  disabled: "chat.agentTeam.unavailable.disabled",
  lean: "chat.agentTeam.unavailable.lean",
  memberSession: "chat.agentTeam.unavailable.member",
};

/**
 * 极简档（lean）是否开启。真源在服务端（`lib/lean-mode.ts` 的 settings.json），客户端
 * 没有镜像，所以这里按需拉一次 `GET /api/lean-mode`。读不到按「没开」处理（与
 * `ServerSwitchSettingRow` 的失败方向一致）：lean 关着只是多显示一个开关，不会静默
 * 收敛能力。
 */
export function useLeanModeEnabled(): boolean {
  const [lean, setLean] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/lean-mode", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { enabled?: unknown }) => {
        if (!cancelled) setLean(data?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setLean(false);
      });
    return () => { cancelled = true; };
  }, []);
  return lean;
}

export function AgentTeamToggle({ armed, available, disabledReason, onToggle, onOpenSettings }: Props) {
  const { t } = useI18n();
  const label = t("chat.agentTeam.toggle");
  const reasonText = disabledReason
    ? t(REASON_KEY[disabledReason])
    : t("chat.agentTeam.toggleHint");

  // 「显示为已勾」只在真正可用时成立：全局关掉后残留的 armed 不再高亮。
  const shownArmed = available && armed;
  const className = `composer-teams-toggle${shownArmed ? " is-armed" : ""}${available ? "" : " is-unavailable"}`;

  return (
    <button
      type="button"
      className={className}
      data-agent-team-toggle
      data-armed={shownArmed || undefined}
      data-disabled-reason={disabledReason}
      // 真开关语义（用户要求）：可用时按 `role="switch"` + `aria-checked` 暴露 armed 状态。
      // 不可用时它只是个「去设置」的动作行，不冒充开关，因此既不落 role 也不落 aria-checked；
      // 仍可聚焦、可点击跳设置。
      role={available ? "switch" : undefined}
      aria-checked={available ? armed : undefined}
      aria-label={label}
      title={available ? label : reasonText}
      onClick={() => {
        if (available) onToggle();
        else onOpenSettings?.();
      }}
    >
      {/* Users 图标：与 AgentTeamStrip / 内联卡同一套线性图标，不引外部资源。 */}
      <svg
        className="composer-teams-toggle-icon"
        width="14"
        height="14"
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
      <span className="composer-teams-toggle-label">{label}</span>
      {/* 真·Switch 轨道（照 cc-haha 的 Switch：小号 h-4 w-7 + 圆形滑块）；只做视觉，
          状态与点击语义都在外层 button 上（role=switch + aria-checked）。
          不可用时整行仍显示，但轨道不画 —— 那只是一行「去设置」。 */}
      {available && (
        <span className="composer-teams-toggle-track" aria-hidden="true">
          <span className="composer-teams-toggle-knob" />
        </span>
      )}
    </button>
  );
}
