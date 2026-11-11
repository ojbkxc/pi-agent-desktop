"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import { isImeComposing } from "@/lib/ime";
import { AppSelect } from "@/components/AppSelect";
import { SkillMarketCard } from "./SkillMarketCard";
import { SkillMarketDetail } from "./SkillMarketDetail";
import {
  INSTALLED_ALL,
  MARKET_PAGE_SIZE,
  SECURITY_ALL,
  SKILL_MARKET_INSTALLED_FILTERS,
  SKILL_MARKET_SECURITY_FILTERS,
  SKILL_MARKET_SOURCES,
  SOURCE_ALL,
  categoryLabel,
  formatIsoDate,
  installedFilterLabelKey,
  securityFilterLabelKey,
  sourceFilterLabelKey,
  type MarketCategory,
  type MarketInstalledFilter,
  type MarketListItem,
  type MarketListResponse,
  type MarketSecurityFilter,
  type MarketSourceFilter,
  type MarketSourceHealth,
} from "./market-helpers";

/**
 * 技能市场整页（对齐 cc-haha 的 ExtensionMarket › Skills）。
 *
 * 左列是浏览/已安装两个页签 + 搜索 + 三筛选 + 分类栏 + 计数行 + 结果网格；右侧是详情
 * （概览 / 文件 / 安全报告）与安装确认。数据全部来自 `/api/market/**`。
 *
 * 作用域：默认 `catalog`（服务端打包的精选快照，离线、快），搜到的结果里可一键切到
 * `live`（实时搜索全部市场）。分类栏只在 catalog 出现，live 的计数行读作实时结果数。
 *
 * 分页是游标式的：`nextCursor` 由服务端编码，页面只原样回传。翻页由
 * IntersectionObserver 触发（哨兵进入视口即拉下一页）；没有该 API 时回退到「加载更多」按钮。
 */

const SEARCH_DEBOUNCE_MS = 300;
/** 哨兵仍在视口下方这么多像素时就预拉下一页，骨架因此是「还有更多」的提示而非一堵墙。 */
const LOAD_MORE_MARGIN = "0px 0px 480px 0px";
/** 首屏/翻页骨架卡片数量。 */
const MARKET_SKELETON_COUNT = 8;
/** 免责声明的关闭状态持久化在本地，关过一次就不再出现。 */
const DISCLAIMER_STORAGE_KEY = "pi-web-market-disclaimer-dismissed";

type MarketScope = "catalog" | "live";

interface Props {
  /** 打开某个已安装技能的目录（可选）。 */
  onRevealInstalled?: (path: string) => void;
}

/* --------------------------------------------------------------------------
   可测试的展示子组件：状态留在 SkillMarketView，子组件只读 props，便于静态渲染断言。
   -------------------------------------------------------------------------- */

/** 顶部免责声明：技能来自第三方，安装前请自查。关闭状态持久化，关过一次不再出现。 */
export function MarketDisclaimer() {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(DISCLAIMER_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className="market-disclaimer" role="note" data-testid="market-disclaimer">
      <p className="market-disclaimer-text">
        <strong>{t("market.disclaimer.title")}</strong> {t("market.disclaimer.body")}
      </p>
      <button
        type="button"
        className="market-disclaimer-dismiss"
        aria-label={t("market.disclaimer.dismiss")}
        title={t("market.disclaimer.dismiss")}
        onClick={() => {
          setDismissed(true);
          try { localStorage.setItem(DISCLAIMER_STORAGE_KEY, "1"); } catch { /* 持久化失败也不影响本次会话 */ }
        }}
      >
        ×
      </button>
    </div>
  );
}

export interface MarketFilterBarProps {
  source: MarketSourceFilter;
  security: MarketSecurityFilter;
  installed: MarketInstalledFilter;
  onSourceChange: (value: MarketSourceFilter) => void;
  onSecurityChange: (value: MarketSecurityFilter) => void;
  onInstalledChange: (value: MarketInstalledFilter) => void;
}

/** 三个筛选（来源 / 安全状态 / 安装状态），统一用本仓 AppSelect。 */
export function MarketFilterBar({
  source,
  security,
  installed,
  onSourceChange,
  onSecurityChange,
  onInstalledChange,
}: MarketFilterBarProps) {
  const { t } = useI18n();
  return (
    <div className="market-filter-bar" data-testid="market-filter-bar">
      <AppSelect
        className="market-filter-select"
        aria-label={t("market.filter.source")}
        value={source}
        onValueChange={(value) => onSourceChange(value as MarketSourceFilter)}
        options={[SOURCE_ALL, ...SKILL_MARKET_SOURCES].map((value) => ({
          value,
          label: t(sourceFilterLabelKey(value)),
        }))}
      />
      <AppSelect
        className="market-filter-select"
        aria-label={t("market.filter.security")}
        value={security}
        onValueChange={(value) => onSecurityChange(value as MarketSecurityFilter)}
        options={SKILL_MARKET_SECURITY_FILTERS.map((value) => ({
          value,
          label: t(securityFilterLabelKey(value)),
        }))}
      />
      <AppSelect
        className="market-filter-select"
        aria-label={t("market.filter.installed")}
        value={installed}
        onValueChange={(value) => onInstalledChange(value as MarketInstalledFilter)}
        options={SKILL_MARKET_INSTALLED_FILTERS.map((value) => ({
          value,
          label: t(installedFilterLabelKey(value)),
        }))}
      />
    </div>
  );
}

export interface MarketCategoryBarProps {
  categories: readonly MarketCategory[];
  value: string;
  onChange: (key: string) => void;
}

/**
 * 分类 chip（全部 + 各分类名 + 计数），横向可滚动。
 * 分类来自服务端；没有分类时不渲染（一个只有「全部」的空栏等于没有选择）。
 */
export function MarketCategoryBar({ categories, value, onChange }: MarketCategoryBarProps) {
  const { t, locale } = useI18n();
  if (categories.length === 0) return null;
  return (
    <div className="market-category-bar" role="group" aria-label={t("market.category.label")} data-testid="market-category-bar">
      <button
        type="button"
        className={`market-category-chip${value === "all" ? " is-active" : ""}`}
        aria-pressed={value === "all"}
        onClick={() => onChange("all")}
      >
        {t("market.category.all")}
      </button>
      {categories.map((category) => (
        <button
          key={category.key}
          type="button"
          className={`market-category-chip${value === category.key ? " is-active" : ""}`}
          aria-pressed={value === category.key}
          onClick={() => onChange(category.key)}
        >
          <span>{categoryLabel(category, locale)}</span>
          <span className="market-category-count">{category.count}</span>
        </button>
      ))}
    </div>
  );
}

export interface MarketResultSummaryProps {
  scope: MarketScope;
  /** catalog 全量匹配数；服务端未给出时为 null，回退到当前已加载条数。 */
  total: number | null;
  loadedCount: number;
  catalogUpdatedAt?: number;
}

/** 计数行：catalog 说「共 N 个精选技能 / 清单更新于 date」，live 说实时结果数。 */
export function MarketResultSummary({ scope, total, loadedCount, catalogUpdatedAt }: MarketResultSummaryProps) {
  const { t } = useI18n();
  const catalog = scope === "catalog";
  const updated = catalog ? formatIsoDate(catalogUpdatedAt) : "";
  return (
    <p className="market-result-summary" aria-live="polite" data-testid="market-result-summary">
      <span>
        {catalog
          ? total !== null
            ? t("market.catalog.summary", { count: String(total) })
            : t("market.resultCount", { count: String(loadedCount) })
          : t("market.catalog.liveResults", { count: String(loadedCount) })}
      </span>
      {updated && <span className="market-result-updated">{t("market.catalog.updated", { date: updated })}</span>}
      {!catalog && <span className="market-not-curated">{t("market.scope.notCurated")}</span>}
    </p>
  );
}

/** 缓存时间的本地化展示；无效时间返回空串（调用方回退到不显示时间）。 */
function formatSourceTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch {
    return "";
  }
}

export interface MarketSourceStatusBarProps {
  /** `GET /api/market/skills` 响应里的 health；只渲染有记录的来源。 */
  sources: Record<string, MarketSourceHealth | undefined>;
}

/**
 * 来源状态条：每个有记录的注册源一个 chip（正常 / 降级 / 不可用 / 缓存于时间）。
 * 没有记录的来源直接跳过——编造一个「未知」状态等于给出它并不掌握的信息。
 * 一个来源都没记录时整条不渲染。
 */
export function MarketSourceStatusBar({ sources }: MarketSourceStatusBarProps) {
  const { t } = useI18n();
  const present = SKILL_MARKET_SOURCES.filter((source) => sources[source]);
  if (present.length === 0) return null;
  return (
    <div className="market-source-status" data-testid="market-source-status">
      {present.map((source) => {
        const info = sources[source]!;
        const label = info.status === "cached" && info.at
          ? t("market.sourceStatus.cachedAt", { time: formatSourceTime(info.at) })
          : t(`market.sourceStatus.${info.status}`);
        return (
          <span
            key={source}
            className="market-source-status-item"
            data-testid={`market-source-status-${source}`}
            title={info.message || undefined}
          >
            <span className={`market-source-dot is-${info.status}`} aria-hidden="true" />
            <span className="market-source-status-name">{t(`market.source.${source}`)}</span>
            <span className="market-source-status-text">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

/** 骨架卡片网格：加载态给形状而不是一行文字。 */
export function MarketSkeleton({ count = MARKET_SKELETON_COUNT, label }: { count?: number; label: string }) {
  return (
    <>
      <ul className="market-grid market-skeleton" aria-hidden="true" data-testid="market-skeleton">
        {Array.from({ length: count }, (_, index) => (
          <li key={index}>
            <div className="market-card is-skeleton">
              <span className="market-skeleton-line is-icon" />
              <span className="market-skeleton-line is-title" />
              <span className="market-skeleton-line" />
              <span className="market-skeleton-line is-short" />
            </div>
          </li>
        ))}
      </ul>
      <span className="scheduled-visually-hidden" role="status">{label}</span>
    </>
  );
}

export interface MarketLoadMoreProps {
  /** 运行外壳是否支持 IntersectionObserver；不支持时回退「加载更多」按钮。 */
  canAutoLoad: boolean;
  loadingMore: boolean;
  /** 翻页失败信息；非空时停掉自动加载，只给手动重试。 */
  loadMoreError: string | null;
  onLoadMore: () => void;
  sentinelRef: RefObject<HTMLDivElement | null>;
}

/**
 * 无限滚动区域：哨兵 + 翻页骨架 + 失败重试 + 无 observer 时的回退按钮。
 * 哨兵紧贴网格底边，预取间距从最后一行量起；每次翻页后由上层 effect 重新 observe。
 */
export function MarketLoadMore({
  canAutoLoad,
  loadingMore,
  loadMoreError,
  onLoadMore,
  sentinelRef,
}: MarketLoadMoreProps) {
  const { t } = useI18n();
  return (
    <>
      <div ref={sentinelRef} className="market-sentinel" aria-hidden="true" data-testid="market-load-more-sentinel" />
      {loadingMore && <MarketSkeleton count={4} label={t("market.loadingMore")} />}
      {loadMoreError && !loadingMore && (
        <div className="market-load-more-error" role="alert">
          <p className="scheduled-error">{t("market.loadMoreError")}</p>
          <p className="scheduled-hint">{loadMoreError}</p>
          <button type="button" className="scheduled-button" onClick={onLoadMore}>
            {t("market.loadMore")}
          </button>
        </div>
      )}
      {!canAutoLoad && !loadingMore && !loadMoreError && (
        <button type="button" className="scheduled-button market-more" onClick={onLoadMore}>
          {t("market.loadMore")}
        </button>
      )}
    </>
  );
}

/* --------------------------------------------------------------------------
   整页
   -------------------------------------------------------------------------- */

export function SkillMarketView({ onRevealInstalled }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"browse" | "installed">("browse");
  const [scope, setScope] = useState<MarketScope>("catalog");
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [source, setSource] = useState<MarketSourceFilter>(SOURCE_ALL);
  const [security, setSecurity] = useState<MarketSecurityFilter>(SECURITY_ALL);
  const [installedFilter, setInstalledFilter] = useState<MarketInstalledFilter>(INSTALLED_ALL);
  const [category, setCategory] = useState<string>("all");
  const [items, setItems] = useState<MarketListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [categories, setCategories] = useState<MarketCategory[]>([]);
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [sourceErrors, setSourceErrors] = useState<Array<{ source: string; message: string }>>([]);
  const [health, setHealth] = useState<Record<string, MarketSourceHealth | undefined>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [installed, setInstalled] = useState<MarketListItem[]>([]);
  const [installedRoot, setInstalledRoot] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);

  // 代际守卫：切页签/改筛选/重搜都可能并发，旧响应后落地会把新结果盖掉。
  // 首页请求递增它；翻页只读取当前值，若期间发生过重载则丢弃这次追加。
  const listSeqRef = useRef(0);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // 运行外壳都有 IntersectionObserver；没有它（或测试环境）时渲染「加载更多」按钮。
  const [canAutoLoad] = useState(() => typeof IntersectionObserver === "function");

  const loadInstalled = useCallback(async () => {
    try {
      const response = await fetch("/api/market/installed", { cache: "no-store" });
      const data = await response.json() as { items?: MarketListItem[]; root?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setInstalled(data.items ?? []);
      setInstalledRoot(data.root ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** 单次列表请求：只取数据，不碰状态，由调用方按代际决定是否落地。 */
  const requestPage = useCallback(async (cursor: string | null): Promise<MarketListResponse> => {
    const params = new URLSearchParams();
    params.set("scope", scope);
    if (committedQuery) params.set("q", committedQuery);
    if (source !== SOURCE_ALL) params.set("source", source);
    if (security !== SECURITY_ALL) params.set("security", security);
    if (installedFilter !== INSTALLED_ALL) params.set("installed", installedFilter);
    if (scope === "catalog" && category !== "all") params.set("category", category);
    if (cursor) params.set("cursor", cursor);
    params.set("limit", String(MARKET_PAGE_SIZE));
    const response = await fetch(`/api/market/skills?${params}`, { cache: "no-store" });
    const data = await response.json() as MarketListResponse & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }, [scope, committedQuery, source, security, installedFilter, category]);

  /** 拉第一页并替换列表；返回时若已被更新的请求取代则不动状态。 */
  const loadFirstPage = useCallback(async () => {
    const generation = ++listSeqRef.current;
    setLoading(true);
    setLoadMoreError(null);
    setNextCursor(null);
    try {
      const data = await requestPage(null);
      if (generation !== listSeqRef.current) return;
      setItems(data.items ?? []);
      setNextCursor(data.nextCursor ?? null);
      setTotal(typeof data.total === "number" ? data.total : null);
      setSourceErrors(data.sourceErrors ?? []);
      setHealth(data.health ?? {});
      if (data.categories) setCategories(data.categories);
      if (data.catalogUpdatedAt !== undefined) setCatalogUpdatedAt(data.catalogUpdatedAt);
      setError(null);
    } catch (err) {
      if (generation === listSeqRef.current) {
        setItems([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === listSeqRef.current) setLoading(false);
    }
  }, [requestPage]);

  /** 追加下一页；沿用当前请求序号，重载期间落地的旧页会被丢弃。 */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || loading) return;
    const generation = listSeqRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const data = await requestPage(nextCursor);
      if (generation !== listSeqRef.current) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...(data.items ?? []).filter((item) => !seen.has(item.id))];
      });
      setNextCursor(data.nextCursor ?? null);
      setSourceErrors(data.sourceErrors ?? []);
      if (data.health) setHealth(data.health);
    } catch (err) {
      if (generation === listSeqRef.current) {
        setLoadMoreError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === listSeqRef.current) setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, loading, requestPage]);

  useEffect(() => {
    if (tab !== "browse") return;
    void loadFirstPage();
  }, [tab, loadFirstPage, reloadKey]);

  useEffect(() => { void loadInstalled(); }, [loadInstalled, reloadKey]);

  // 搜索防抖：只在停止输入后提交，避免每敲一个字打一次上游。
  useEffect(() => {
    const timer = setTimeout(() => setCommittedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // 无限滚动：哨兵进入视口即拉下一页。每次翻页后重 observe 是把高窗口持续填满的关键——
  // observer 只在变化时上报，一页之后仍处于范围内的哨兵否则永远不会再请求下一页。
  // 加载失败（loadMoreError）时不再自动拉，否则骨架一消失就又撞上同一个失败。
  useEffect(() => {
    if (tab !== "browse") return;
    if (!canAutoLoad || !nextCursor || loading || loadingMore || loadMoreError) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { root: scrollRootRef.current, rootMargin: LOAD_MORE_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [tab, canAutoLoad, nextCursor, loading, loadingMore, loadMoreError, loadMore]);

  const installedIds = useMemo(
    () => new Set(installed.filter((item) => item.source && item.slug).map((item) => `${item.source}:${item.slug}`)),
    [installed],
  );

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  const searchAllMarkets = useCallback(() => {
    setScope("live");
    setCategory("all");
  }, []);
  const backToCatalog = useCallback(() => setScope("catalog"), []);

  const list = tab === "installed" ? installed : items;
  const selectedKey = selected && list.some((item) => item.id === selected) ? selected : null;
  const showCountRow = tab === "browse" && !loading && !error;

  return (
    <main className="market-view" aria-label={t("market.title")}>
      <div className="market-shell">
        <header className="market-header">
          <div className="market-header-text">
            <h1 className="market-title">{t("market.title")}</h1>
            <p className="market-subtitle">{t("market.subtitle")}</p>
          </div>
          <div className="market-tabs" role="tablist" aria-label={t("market.tabsLabel")}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "browse"}
              className={`market-tab${tab === "browse" ? " is-active" : ""}`}
              onClick={() => { setTab("browse"); setSelected(null); }}
            >
              {t("market.tab.browse")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "installed"}
              className={`market-tab${tab === "installed" ? " is-active" : ""}`}
              onClick={() => { setTab("installed"); setSelected(null); }}
            >
              {t("market.tab.installed", { count: installed.length })}
            </button>
          </div>
        </header>

        <div className="market-body">
          <div className="market-browse" ref={scrollRootRef}>
            {tab === "browse" && <MarketDisclaimer />}
            <div className="market-filters">
              <input
                type="search"
                className="scheduled-input market-search"
                value={query}
                placeholder={scope === "catalog" ? t("market.searchPlaceholder") : t("market.scope.livePlaceholder")}
                aria-label={t("market.searchPlaceholder")}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // 输入法候选词里的回车不能触发提交。
                  if (event.key === "Enter" && !isImeComposing(event)) setCommittedQuery(query.trim());
                }}
              />
              {tab === "browse" && (
                <MarketFilterBar
                  source={source}
                  security={security}
                  installed={installedFilter}
                  onSourceChange={setSource}
                  onSecurityChange={setSecurity}
                  onInstalledChange={setInstalledFilter}
                />
              )}
            </div>

            {tab === "browse" && scope === "catalog" && (
              <MarketCategoryBar categories={categories} value={category} onChange={setCategory} />
            )}

            {tab === "browse" && showCountRow && (
              <>
                <MarketResultSummary
                  scope={scope}
                  total={total}
                  loadedCount={items.length}
                  catalogUpdatedAt={catalogUpdatedAt}
                />
                <MarketSourceStatusBar sources={health} />
              </>
            )}

            {tab === "browse" && committedQuery && (
              <p className="market-scope-hint" data-testid="market-scope-hint">
                <span>{scope === "catalog" ? t("market.scope.catalogHint") : t("market.scope.marketHint")}</span>
                <button
                  type="button"
                  className="market-scope-switch"
                  onClick={scope === "catalog" ? searchAllMarkets : backToCatalog}
                >
                  {scope === "catalog"
                    ? t("market.scope.searchMarket", { q: committedQuery })
                    : t("market.scope.backToCatalog")}
                </button>
              </p>
            )}

            {error && <p className="scheduled-error" role="alert">{error}</p>}
            {sourceErrors.map((failure) => (
              <p key={failure.source} className="scheduled-warning" role="status">
                {t("market.sourceUnavailable", { source: t(`market.source.${failure.source}`), error: failure.message })}
              </p>
            ))}

            {loading ? (
              <MarketSkeleton label={t("market.loading")} />
            ) : list.length === 0 ? (
              <div className="scheduled-empty">
                <p>{tab === "installed" ? t("market.noInstalled") : t("market.noMatches")}</p>
                {tab === "installed" && installedRoot && (
                  <p className="scheduled-hint market-root">{installedRoot}</p>
                )}
              </div>
            ) : (
              <>
                <ul className="market-grid" aria-label={tab === "installed" ? t("market.tab.installedLabel") : t("market.resultsLabel")}>
                  {list.map((item) => (
                    <li key={item.id}>
                      <SkillMarketCard
                        item={item}
                        installed={item.installState === "installed" || installedIds.has(item.id)}
                        active={selectedKey === item.id}
                        onOpen={() => setSelected(item.id)}
                      />
                    </li>
                  ))}
                </ul>
                {tab === "browse" && nextCursor && (
                  <MarketLoadMore
                    canAutoLoad={canAutoLoad}
                    loadingMore={loadingMore}
                    loadMoreError={loadMoreError}
                    onLoadMore={() => void loadMore()}
                    sentinelRef={sentinelRef}
                  />
                )}
                {tab === "installed" && installedRoot && (
                  <p className="scheduled-hint market-root">{installedRoot}</p>
                )}
              </>
            )}
          </div>

          <SkillMarketDetail
            selectedId={selectedKey}
            installedFallback={tab === "installed" ? list.find((item) => item.id === selectedKey) ?? null : null}
            onClose={() => setSelected(null)}
            onInstalled={reload}
            onRevealInstalled={onRevealInstalled}
          />
        </div>
      </div>
    </main>
  );
}
