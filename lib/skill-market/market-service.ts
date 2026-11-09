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
import {
  MARKET_LIMITS,
  MARKET_SOURCES,
  MarketUpstreamError,
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
  /** 本次没给出结果的来源与原因（部分失败仍返回其余来源的结果）。 */
  sourceErrors: Array<{ source: MarketSource; message: string }>;
}

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

/** 一页市场列表（或搜索结果）。某个源挂了不影响另一个源的结果。 */
export async function listMarketSkills(options: QueryOptions): Promise<MarketListResult> {
  const sources = options.sources?.length ? options.sources : [...MARKET_SOURCES];
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
    throw sourceErrors[0]!.source
      ? new MarketUpstreamError(sourceErrors[0]!.source, "sourceUnavailable", sourceErrors[0]!.message)
      : new Error(sourceErrors[0]!.message);
  }

  const merged = interleaveAndDedupe(pages);
  return {
    // 搜索无分页：合并后按下载量降序，再截上限。
    items: options.q
      ? [...merged].sort((a, b) => b.stats.downloads - a.stats.downloads).slice(0, MARKET_LIMITS.searchResultCap)
      : merged.slice(0, MARKET_LIMITS.maxPageSize),
    nextCursor: options.q ? null : encodeCursor(nextCursor),
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