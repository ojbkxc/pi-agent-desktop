"use client";

import { useI18n } from "@/hooks/useI18n";
import {
  formatDownloads,
  securityBadgeClass,
  type MarketListItem,
} from "./market-helpers";

interface Props {
  item: MarketListItem;
  installed: boolean;
  active: boolean;
  onOpen: () => void;
}

/**
 * 市场里的一张技能卡：名字 / 摘要 / 来源徽标 / 下载量 / 安全结论 / 已安装标记。
 * 整卡是按钮，点开由上层显示详情。
 */
export function SkillMarketCard({ item, installed, active, onOpen }: Props) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`market-card${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      title={item.summary || item.name}
    >
      <span className="market-card-head">
        {item.iconUrl
          ? <img className="market-card-icon" src={item.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
          : <span className="market-card-icon is-fallback" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span>}
        <span className="market-card-name">{item.name}</span>
        {installed && (
          <span className="market-card-installed" title={t("market.installed")}>
            {t("market.installed")}
          </span>
        )}
      </span>
      <span className="market-card-summary">{item.summary || t("market.noSummary")}</span>
      <span className="market-card-meta">
        <span className="market-source-tag">{t(`market.source.${item.source}`)}</span>
        <span
          className={`market-badge ${securityBadgeClass(item.securityStatus)}`}
          title={t(`market.security.${item.securityStatus ?? "unknown"}`)}
        >
          {t(`market.security.${item.securityStatus ?? "unknown"}`)}
        </span>
        <span className="market-card-downloads">
          {t("market.downloads", { count: formatDownloads(item.stats?.downloads ?? 0) })}
        </span>
        {item.version && <span className="market-card-version">v{item.version}</span>}
      </span>
    </button>
  );
}