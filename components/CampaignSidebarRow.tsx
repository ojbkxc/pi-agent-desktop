"use client";

import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  onOpen: () => void;
}

/**
 * 「长时项目战役（Campaign）」入口，放在侧栏 New Session 下方的功能区。
 *
 * 与 Auto-fix 行同形，但**不**带实时徽标：战役页自身轮询列表，侧栏行只做导航，
 * 避免再造一个共享 store / SSE（最简 UI，见 docs/agents/fork-long-run-campaign.md §10 P1）。
 */
export function CampaignSidebarRow({ active, onOpen }: Props) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-scheduled-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={t("sidebar.campaignsTitle")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
        <circle cx="20" cy="18" r="2" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.campaigns")}</span>
    </button>
  );
}
