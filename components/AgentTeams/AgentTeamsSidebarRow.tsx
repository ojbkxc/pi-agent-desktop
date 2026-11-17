"use client";

import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  onOpen: () => void;
}

/**
 * 侧栏「智能体团队」入口：打开团队运行报告（工作台）整页。
 *
 * 为什么需要它：团队工作台原先只有**会话头部团队条**一个入口，而那条要「当前会话
 * 能反查到团队」才渲染。用户换个会话 / 团队已完成 / 会话记录被清理之后，页面就
 * 彻底没有入口了 —— 实测有人因此找不到「智能体团队 · 共享任务列表」这页。
 * 这里给一个与会话无关的常驻入口，头部条保留（它还能直接选中当前会话的团队）。
 */
export function AgentTeamsSidebarRow({ active, onOpen }: Props) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-scheduled-row sidebar-teams-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={t("sidebar.teams")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.teams")}</span>
    </button>
  );
}