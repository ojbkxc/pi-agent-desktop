/**
 * 市场服务的合并层：两个 provider 的结果去重、交错排序、游标编解码、TTL 缓存。
 *
 * 合并口径（与 cc-haha 的 `marketService.ts` 一致）：
 * - 列表：两个源各自翻页，按**来源交错**合并（clawhub, skillhub, clawhub, ...），
 *   避免一个源把整页占满；游标里分别记两个源各自的下一页。
 * - 搜索：两源并发跑一次（都无分页），按下载量降序合并、按 `source:slug` 去重，
 *   截到 searchResultCap。
 * - 去重只在**同一来源内**按 slug 做；跨源同名技能内容可能不同，不合并，
 *   卡片上带来源标签让用户自己选。
 */

import { clawhubProvider } from "./clawhub-provider";
import { skillhubProvider } from "./skillhub-provider";
import { catalogCategories, catalogEntryToSkill, catalogUpdatedAt, filterCatalog } from "./catalog";
import { annotateInstallState } from "./install-service";
import {
  MARKET_LIMITS,
  MARKET_SOURCES,
  MarketUpstreamError,
  type MarketCategory,
  type MarketInstallFilter,
  type MarketScope,
  type MarketSecurityFilter,
  type MarketProvider,
  type MarketSource,
  type NormalizedSkill,
  type ProviderListPage,
} from "./types";

const providers: Record<MarketSource, MarketProvider> = {
  clawhub: clawhubProvider,
  skillhub: skillhubProvider,
};

/** 每源每页拉多少（合并后一页 = 两源各 limit 条，交错取前 limit 条）。 */
function perSourceLimit(limit: number): number {
  return Math.max(1, Math.min(MARKET_LIMITS.maxPageSize, limit));
}

export type MergedCursor = Partial<Record<MarketSource, string>>;

export function encodeCursor(cursor: MergedCursor): string | null {
  const keys = Object.keys(cursor);
  if (keys.length === 0) return null;
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): MergedCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const cursor: MergedCursor = {};
    for (const source of MARKET_SOURCES) {
      const value = (parsed as Record<string, unknown>)[source];
      if (typeof value === "string" && value) cursor[source] = value;
    }
    return cursor;
  } catch {
    return undefined;
  }
}

export interface MarketListResult {
  items: NormalizedSkill[];
  nextCursor: string | null;
  /** 本次没给出结果的来源与原因（部分失败仍返回其余来源的结果）。catalog 路径恒为空。 */
  sourceErrors: Array<{ source: MarketSource; message: string }>;
  /** catalog 路径：过滤后的**总数**（供「共 N 个精选技能」）。 */
  total?: number;
  /** catalog 路径：分类栏条目（整库静态计数）。 */
  categories?: MarketCategory[];
  /** catalog 路径：快照生成时间（epoch 毫秒）。 */
  catalogUpdatedAt?: number;
}

/**
 * 一次市场列表 / 搜索的入参。
 *
 * `scope` 缺省 `catalog`（首页精选快照，不发网络）；`cursor` 是**原始字符串**——
 * catalog 用自编的 `catalog:<offset>`，live 用既有 base64url 双源游标（内部再 decode）。
 */
export interface MarketListParams {
  scope?: MarketScope;
  q?: string;
  /** catalog 专用：目录分类 key。 */
  category?: string;
  /** 单一来源筛选（`all` = 两个源都取）。 */
  source?: "all" | MarketSource;
  /** 兼容旧调用点的来源数组；与 `source` 同时给出时以 `sources` 为准。 */
  sources?: MarketSource[];
  security?: MarketSecurityFilter;
  installed?: MarketInstallFilter;
  cursor?: string;
  limit: number;
}

/** live 路径内部用：已 decode 的双源游标。 */
interface QueryOptions {
  cursor?: MergedCursor;
  limit: number;
  q?: string;
  sources?: MarketSource[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 交错合并：两个源的结果轮流取一条，某一源先耗尽就继续取另一源。
 * 每个源内部再按 slug 去重（上游偶尔会重复同一 slug 的不同版本）。
 */
export function interleaveAndDedupe<T extends { slug: string }>(
  pages: Array<{ source: MarketSource; items: T[] }>,
): Array<T & { source: MarketSource }> {
  const seen = new Set<string>();
  const queues = pages.map((page) => ({
    source: page.source,
    items: page.items.filter((item) => {
      const key = `${page.source}:${item.slug}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  }));
  const merged: Array<T & { source: MarketSource }> = [];
  let index = 0;
  for (;;) {
    let took = false;
    for (const queue of queues) {
      const item = queue.items[index];
      if (item) {
        // 标记来源：上游 item 自己带 source（detail/search 都归一化过），这里再兜一次底，
        // 保证合并结果里每一条都能回答「来自哪个源」。
        merged.push({ ...item, source: queue.source });
        took = true;
      }
    }
    if (!took) break;
    index += 1;
  }
  return merged;
}

async function listSource(
  source: MarketSource,
  options: QueryOptions,
): Promise<ProviderListPage> {
  const provider = providers[source];
  const cursor = options.cursor?.[source];
  return options.q
    ? provider.search({ q: options.q, limit: perSourceLimit(options.limit) })
    : provider.list({ cursor, limit: perSourceLimit(options.limit) });
}

/** 安全筛选：`all`/缺省不筛，其余精确匹配 securityStatus。 */
function filterBySecurity(items: NormalizedSkill[], security?: MarketSecurityFilter): NormalizedSkill[] {
  if (!security || security === "all") return items;
  return items.filter((item) => item.securityStatus === security);
}

/** 安装筛选：按已标注的 installState 过滤（调用前必须先 annotateInstallState）。 */
function filterByInstalled(items: NormalizedSkill[], installed?: MarketInstallFilter): NormalizedSkill[] {
  if (!installed || installed === "all") return items;
  return items.filter((item) =>
    installed === "installed" ? item.installState === "installed" : item.installState !== "installed",
  );
}

/** 从入参解析出单一来源筛选项（兼容旧的 `sources` 数组）。 */
function resolveCatalogSource(params: MarketListParams): "all" | MarketSource {
  if (params.source && params.source !== "all") return params.source;
  if (params.sources?.length === 1) return params.sources[0]!;
  return "all";
}

/** 一页市场列表（或搜索结果）。默认走精选快照；`scope: "live"` 才打上游注册表。 */
export async function listMarketSkills(params: MarketListParams): Promise<MarketListResult> {
  return params.scope === "live" ? listLiveMarketSkills(params) : listCatalogSkills(params);
}

/** catalog 游标形如 `catalog:<offset>`；与 live 的 base64url 双源游标互不干扰。 */
const CATALOG_CURSOR_PREFIX = "catalog:";

/**
 * 精选快照的一页。整条链路本地完成，**不发任何网络请求**。
 *
 * 所有筛选（安全、安装）都在分页之前跑：只要还有数据，每页都是满的，无限滚动不会卡在
 * 「被筛掉的一页」上。安装筛选需要本机安装态，统一复用 install-service 的标注。
 */
async function listCatalogSkills(params: MarketListParams): Promise<MarketListResult> {
  let items: NormalizedSkill[] = await annotateInstallState(
    filterCatalog({ q: params.q, category: params.category, source: resolveCatalogSource(params) })
      .map(catalogEntryToSkill),
  );
  items = filterBySecurity(items, params.security);
  items = filterByInstalled(items, params.installed);

  const raw = params.cursor?.startsWith(CATALOG_CURSOR_PREFIX)
    ? params.cursor.slice(CATALOG_CURSOR_PREFIX.length)
    : "";
  const offset = Math.max(0, Number.parseInt(raw, 10) || 0);
  const end = offset + params.limit;

  return {
    items: items.slice(offset, end),
    nextCursor: end < items.length ? `${CATALOG_CURSOR_PREFIX}${end}` : null,
    sourceErrors: [],
    total: items.length,
    categories: catalogCategories(),
    catalogUpdatedAt,
  };
}

/** live 路径：两个源交错翻页，部分失败仍返回其余来源的结果。 */
async function listLiveMarketSkills(params: MarketListParams): Promise<MarketListResult> {
  const sources = params.sources?.length
    ? params.sources
    : params.source && params.source !== "all"
      ? [params.source]
      : [...MARKET_SOURCES];
  const options: QueryOptions = {
    cursor: decodeCursor(params.cursor),
    limit: params.limit,
    q: params.q,
    sources,
  };
  const settled = await Promise.allSettled(sources.map((source) => listSource(source, options)));

  const sourceErrors: MarketListResult["sourceErrors"] = [];
  const pages: Array<{ source: MarketSource; items: NormalizedSkill[] }> = [];
  const nextCursor: MergedCursor = {};
  settled.forEach((result, index) => {
    const source = sources[index]!;
    if (result.status === "rejected") {
      sourceErrors.push({ source, message: messageOf(result.reason) });
      return;
    }
    pages.push({ source, items: result.value.items });
    if (result.value.nextCursor) nextCursor[source] = result.value.nextCursor;
  });

  if (pages.length === 0 && sourceErrors.length > 0) {
    throw new MarketUpstreamError(sourceErrors[0]!.source, "sourceUnavailable", sourceErrors[0]!.message);
  }

  const merged = interleaveAndDedupe(pages);
  let items = params.q
    ? [...merged].sort((a, b) => b.stats.downloads - a.stats.downloads).slice(0, MARKET_LIMITS.searchResultCap)
    : merged.slice(0, MARKET_LIMITS.maxPageSize);

  // 安装筛选需要本机安装态；纯列表也顺带标注，让下游不用再扫一遍目录。
  items = await annotateInstallState(items);
  items = filterBySecurity(items, params.security);
  items = filterByInstalled(items, params.installed);

  return {
    items,
    nextCursor: params.q ? null : encodeCursor(nextCursor),
    sourceErrors,
  };
}

// ── TTL 缓存 ────────────────────────────────────────────────────────────────

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

// globalThis：Next 热重载会重建模块，缓存要在开发时也稳定。
const registry = globalThis as typeof globalThis & { __piMarketCache?: Map<string, CacheEntry> };

function cache(): Map<string, CacheEntry> {
  return registry.__piMarketCache ??= new Map();
}

function prune(now: number): void {
  const store = cache();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  // 仍超上限时按插入顺序淘汰最旧的（Map 保序），防止长会话把内存拖大。
  while (store.size > CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** 读缓存；miss 或过期返回 undefined。 */
export function readCache<T>(key: string): T | undefined {
  const now = Date.now();
  prune(now);
  const entry = cache().get(key);
  if (!entry || entry.expiresAt <= now) return undefined;
  return entry.value as T;
}

export function writeCache(key: string, value: unknown): void {
  cache().set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

/** 测试用：清空缓存（不改导出面，只给单测调用）。 */
export function clearMarketCache(): void {
  cache().clear();
}

/** 详情缓存键：clawhub 的 slug 跨 owner 重复，owner 必须进键。 */
export function detailCacheKey(source: MarketSource, slug: string, owner?: string): string {
  return `detail:${source}:${owner || ""}:${slug}`;
}