"use client";

import { useI18n } from "@/hooks/useI18n";
import {
  formatDownloads,
  securityBadgeClass,
  securityHintKey,
  skillSummary,
  visibleTags,
  type MarketListItem,
} from "./market-helpers";

/** 卡片上最多直显的标签数，其余折叠成「+N」（照 cc-haha SkillCard）。 */
const MAX_VISIBLE_TAGS = 3;

interface Props {
  item: MarketListItem;
  installed: boolean;
  active: boolean;
  onOpen: () => void;
}

/**
 * 市场里的一张技能卡：名字 / 摘要 / 标签 / 来源徽标 / 下载量 / 安全结论 / 已安装标记。
 * 整卡是按钮，点开由上层显示详情。
 */
export function SkillMarketCard({ item, installed, active, onOpen }: Props) {
  const { t, locale } = useI18n();
  const summary = skillSummary(item, locale);
  const tags = visibleTags(item, locale);
  const extraTags = Math.max(0, tags.length - MAX_VISIBLE_TAGS);
  return (
    <button
      type="button"
      className={`market-card${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      title={summary || item.name}
    >
      <span className="market-card-head">
        {item.iconUrl
          ? <img className="market-card-icon" src={item.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
          : <span className="market-card-icon is-fallback" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span>}
        <span className="market-card-name">{item.name}</span>
        {item.featured && (
          <span className="market-card-featured" title={t("market.featured")}>
            {t("market.featured")}
          </span>
        )}
        {installed && (
          <span className="market-card-installed" title={t("market.installed")}>
            {t("market.installed")}
          </span>
        )}
      </span>
      <span className="market-card-summary">{summary || t("market.noSummary")}</span>
      {tags.length > 0 && (
        <span className="market-card-tags" data-testid="market-card-tags">
          {tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
            <span key={tag} className="market-card-tag">{tag}</span>
          ))}
          {extraTags > 0 && (
            <span className="market-card-tag is-more">{t("market.card.moreTags", { count: String(extraTags) })}</span>
          )}
        </span>
      )}
      <span className="market-card-meta">
        <span className="market-source-tag">{t(`market.source.${item.source}`)}</span>
        <span
          className={`market-badge ${securityBadgeClass(item.securityStatus)}`}
          title={t(securityHintKey(item.securityStatus))}
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