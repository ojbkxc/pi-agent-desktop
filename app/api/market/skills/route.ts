import { NextResponse } from "next/server";
import { listInstalledMarketSkills } from "@/lib/skill-market/install-service";
import { listMarketSkills } from "@/lib/skill-market/market-service";
import { getSourceHealth } from "@/lib/skill-market/provider-fetch";
import {
  MARKET_INSTALL_FILTERS,
  MARKET_LIMITS,
  MARKET_SCOPES,
  MARKET_SECURITY_FILTERS,
  MARKET_SOURCES,
  MarketUpstreamError,
  type MarketInstallFilter,
  type MarketScope,
  type MarketSecurityFilter,
  type MarketSource,
} from "@/lib/skill-market/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/skills —— 市场首页精选（catalog）/ 实时结果（live）/ 已安装清单。
 *
 * 查询参数：
 *   scope=catalog|live       数据面（缺省 catalog：精选快照，不发网络）
 *   q=<text>                 搜索（catalog 本地过滤；live 两源并发，无分页）
 *   category=<key>           分类筛选（catalog 专用）
 *   source=clawhub|skillhub  只看某源（缺省=两源）
 *   security=all|verified|benign|unknown|flagged   安全筛选
 *   installed=all|installed|installable            安装筛选
 *   cursor=<opaque>          下一页（catalog：`catalog:<offset>`；live：双源游标）
 *   limit=<n>                每页条数（上限 MARKET_LIMITS.maxPageSize）
 *   installed=1              兼容旧调用点：直接列本机已安装的市场技能（不访问网络）
 *
 * 响应：{ items, nextCursor, sourceErrors, total?, categories?, catalogUpdatedAt?, health }
 *   total / categories / catalogUpdatedAt 只在 catalog 路径给出。
 *
 * 只读：不带任何写操作，所以不需要 isApiRequestAllowed（与本仓其它 GET 一致）。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const scopeParam = searchParams.get("scope");
  const scope: MarketScope = MARKET_SCOPES.includes(scopeParam as MarketScope)
    ? (scopeParam as MarketScope)
    : "catalog";
  const q = searchParams.get("q")?.trim() ?? "";
  const category = searchParams.get("category")?.trim() || undefined;
  const cursor = searchParams.get("cursor") ?? undefined;
  const limitParam = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitParam)
    ? Math.min(MARKET_LIMITS.maxPageSize, Math.max(1, Math.floor(limitParam)))
    : 12;
  const requestedSource = searchParams.get("source");
  const source: "all" | MarketSource = MARKET_SOURCES.includes(requestedSource as MarketSource)
    ? (requestedSource as MarketSource)
    : "all";

  const securityParam = searchParams.get("security");
  const security = MARKET_SECURITY_FILTERS.includes(securityParam as MarketSecurityFilter)
    ? (securityParam as MarketSecurityFilter)
    : undefined;

  const installedParam = searchParams.get("installed");
  // 兼容旧调用点：`installed=1` 直接列已安装清单（Installed 标签页）。
  if (installedParam === "1") {
    const installed = await listInstalledMarketSkills();
    return NextResponse.json(
      { items: installed.map((meta) => ({ ...meta })), nextCursor: null, sourceErrors: [], health: getSourceHealth() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const installed = MARKET_INSTALL_FILTERS.includes(installedParam as MarketInstallFilter)
    ? (installedParam as MarketInstallFilter)
    : undefined;

  try {
    const result = await listMarketSkills({
      scope,
      q,
      category,
      source,
      security,
      installed,
      cursor,
      limit,
    });
    return NextResponse.json(
      {
        items: result.items,
        nextCursor: result.nextCursor,
        sourceErrors: result.sourceErrors,
        // catalog 专属字段：live 路径不给（保持既有响应形状）。
        ...(result.total !== undefined ? { total: result.total } : {}),
        ...(result.categories !== undefined ? { categories: result.categories } : {}),
        ...(result.catalogUpdatedAt !== undefined ? { catalogUpdatedAt: result.catalogUpdatedAt } : {}),
        health: getSourceHealth(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const status = error instanceof MarketUpstreamError ? 502 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
