"use client";

import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  /** 运行中的成员数（用于徽标），0 时不显示。 */
  runningCount: number;
  onOpen: () => void;
}

/** 侧栏「团队」入口：打开 Agents 泳道面板，显示运行中的成员数。 */
export function TeamsSidebarRow({ active, runningCount, onOpen }: Props) {
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
        <path d="M4 6h16M4 12h10M4 18h13" />
        <circle cx="19" cy="12" r="1.6" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.teams")}</span>
      {runningCount > 0 && (
        <span className="sidebar-scheduled-badge" aria-label={t("sidebar.teamsRunning", { count: runningCount })}>
          {runningCount > 99 ? "99+" : runningCount}
        </span>
      )}
    </button>
  );
}
