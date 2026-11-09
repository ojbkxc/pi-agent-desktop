"use client";

import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  onOpen: () => void;
}

/**
 * 侧栏「市场」入口：打开技能市场整页（clawhub + skillhub 双源）。
 *
 * 这一行占的是原来「团队」行的位置——团队入口改为只在会话里出现（composer 开关与
 * 会话头部团队条），与 cc-haha 一致；市场则是一个需要常驻入口的整页能力。
 */
export function MarketSidebarRow({ active, onOpen }: Props) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-scheduled-row sidebar-market-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={t("sidebar.market")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 9l1.5-5h15L21 9" />
        <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" />
        <path d="M3 9h18" />
        <path d="M9 13a3 3 0 0 0 6 0" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.market")}</span>
    </button>
  );
}