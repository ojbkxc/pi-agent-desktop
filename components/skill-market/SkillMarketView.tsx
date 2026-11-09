"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { isImeComposing } from "@/lib/ime";
import { AppSelect } from "@/components/AppSelect";
import { SkillMarketCard } from "./SkillMarketCard";
import { SkillMarketDetail } from "./SkillMarketDetail";
import {
  MARKET_PAGE_SIZE,
  SKILL_MARKET_SOURCES,
  SOURCE_ALL,
  type MarketListItem,
  type MarketListResponse,
  type MarketSourceFilter,
} from "./market-helpers";

/**
 * 技能市场整页（对齐 cc-haha 的 ExtensionMarket › Skills）。
 *
 * 左列是浏览/已安装两个页签 + 搜索 + 来源筛选 + 结果网格；右侧是详情（概览 / 文件 /
 * 安全报告）与安装确认。数据全部来自 `/api/market/**`，页面本身不访问第三方站点。
 *
 * 分页是游标式的：`nextCursor` 由服务端编码，页面只原样回传。搜索无分页（上游两边都
 * 没有），输入停止后才发请求。
 */

const SEARCH_DEBOUNCE_MS = 300;

interface Props {
  /** 打开某个已安装技能的目录（可选）。 */
  onRevealInstalled?: (path: string) => void;
}

export function SkillMarketView({ onRevealInstalled }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"browse" | "installed">("browse");
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [source, setSource] = useState<MarketSourceFilter>(SOURCE_ALL);
  const [items, setItems] = useState<MarketListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceErrors, setSourceErrors] = useState<Array<{ source: string; message: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [installed, setInstalled] = useState<MarketListItem[]>([]);
  const [installedRoot, setInstalledRoot] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);

  // 代际守卫：切页签/改筛选/重搜都可能并发，旧响应后落地会把新结果盖掉。
  const listSeqRef = useRef(0);

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

  const loadPage = useCallback(async (cursor: string | null): Promise<boolean> => {
    const generation = ++listSeqRef.current;
    const params = new URLSearchParams();
    if (committedQuery) params.set("q", committedQuery);
    if (source !== SOURCE_ALL) params.set("source", source);
    if (cursor) params.set("cursor", cursor);
    params.set("limit", String(MARKET_PAGE_SIZE));
    try {
      const response = await fetch(`/api/market/skills?${params}`, { cache: "no-store" });
      const data = await response.json() as MarketListResponse & { error?: string };
      if (generation !== listSeqRef.current) return false;
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setItems((current) => (cursor ? [...current, ...(data.items ?? [])] : (data.items ?? [])));
      setNextCursor(data.nextCursor ?? null);
      setSourceErrors(data.sourceErrors ?? []);
      setError(null);
      return true;
    } catch (err) {
      if (generation === listSeqRef.current) setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [committedQuery, source]);

  useEffect(() => {
    if (tab !== "browse") return;
    let cancelled = false;
    setLoading(true);
    setNextCursor(null);
    void loadPage(null).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tab, loadPage, reloadKey]);

  useEffect(() => { void loadInstalled(); }, [loadInstalled, reloadKey]);

  // 搜索防抖：只在停止输入后提交，避免每敲一个字打一次两边上游。
  useEffect(() => {
    const timer = setTimeout(() => setCommittedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await loadPage(nextCursor);
    setLoadingMore(false);
  }, [loadPage, nextCursor, loadingMore]);

  const installedIds = useMemo(
    () => new Set(installed.filter((item) => item.source && item.slug).map((item) => `${item.source}:${item.slug}`)),
    [installed],
  );

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  const list = tab === "installed" ? installed : items;
  const selectedKey = selected && list.some((item) => item.id === selected) ? selected : null;

  const sourceOptions = useMemo(() => [
    { value: SOURCE_ALL, label: t("market.source.all") },
    ...SKILL_MARKET_SOURCES.map((value) => ({ value, label: t(`market.source.${value}`) })),
  ], [t]);

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
          <div className="market-browse">
            <div className="market-filters">
              <input
                type="search"
                className="scheduled-input market-search"
                value={query}
                placeholder={t("market.searchPlaceholder")}
                aria-label={t("market.searchPlaceholder")}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // 输入法候选词里的回车不能触发提交。
                  if (event.key === "Enter" && !isImeComposing(event)) setCommittedQuery(query.trim());
                }}
              />
              {tab === "browse" && (
                <AppSelect
                  value={source}
                  onValueChange={(value) => setSource(value as MarketSourceFilter)}
                  options={sourceOptions}
                  aria-label={t("market.sourceLabel")}
                  className="market-source-filter"
                />
              )}
            </div>

            {error && <p className="scheduled-error" role="alert">{error}</p>}
            {sourceErrors.map((failure) => (
              <p key={failure.source} className="scheduled-warning" role="status">
                {t("market.sourceUnavailable", { source: t(`market.source.${failure.source}`), error: failure.message })}
              </p>
            ))}

            {loading ? (
              <p className="scheduled-hint" role="status">{t("market.loading")}</p>
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
                  <button
                    type="button"
                    className="scheduled-button market-more"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? t("market.loadingMore") : t("market.loadMore")}
                  </button>
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