import { NextResponse } from "next/server";
import { annotateInstallState, listInstalledMarketSkills } from "@/lib/skill-market/install-service";
import { decodeCursor, listMarketSkills } from "@/lib/skill-market/market-service";
import { getSourceHealth } from "@/lib/skill-market/provider-fetch";
import { MARKET_LIMITS, MARKET_SOURCES, MarketUpstreamError, type MarketSource } from "@/lib/skill-market/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/skills —— 市场第一页 / 搜索结果 / 已安装清单。
 *
 * 查询参数：
 *   q=<text>          搜索（两源并发，无分页）
 *   cursor=<opaque>   下一页（`encodeCursor` 的双源游标）
 *   limit=<n>         每页条数（上限 MARKET_LIMITS.maxPageSize）
 *   source=clawhub|skillhub  只看某源（缺省=两源）
 *   installed=1       只看本机已安装的（不访问网络）
 *
 * 只读：不带任何写操作，所以不需要 isApiRequestAllowed（与本仓其它 GET 一致）。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const cursor = decodeCursor(searchParams.get("cursor"));
  const limitParam = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitParam)
    ? Math.min(MARKET_LIMITS.maxPageSize, Math.max(1, Math.floor(limitParam)))
    : 12;
  const requestedSource = searchParams.get("source");
  const sources = MARKET_SOURCES.includes(requestedSource as MarketSource)
    ? [requestedSource as MarketSource]
    : undefined;

  if (searchParams.get("installed") === "1") {
    const installed = await listInstalledMarketSkills();
    return NextResponse.json(
      { items: installed.map((meta) => ({ ...meta })), nextCursor: null, sourceErrors: [], health: getSourceHealth() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await listMarketSkills({ cursor, limit, q, sources });
    const items = await annotateInstallState(result.items);
    return NextResponse.json(
      { items, nextCursor: result.nextCursor, sourceErrors: result.sourceErrors, health: getSourceHealth() },
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