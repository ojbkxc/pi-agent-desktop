import { NextResponse } from "next/server";
import { clawhubProvider } from "@/lib/skill-market/clawhub-provider";
import { installStateFor } from "@/lib/skill-market/install-service";
import { detailCacheKey, readCache, writeCache } from "@/lib/skill-market/market-service";
import { skillhubProvider } from "@/lib/skill-market/skillhub-provider";
import {
  MarketUpstreamError,
  parseSkillId,
  type MarketProvider,
  type MarketSource,
  type NormalizedSkillDetail,
} from "@/lib/skill-market/types";

export const dynamic = "force-dynamic";

const providers: Record<MarketSource, MarketProvider> = {
  clawhub: clawhubProvider,
  skillhub: skillhubProvider,
};

/**
 * GET /api/market/skills/[id]?owner=&version=
 *
 * `id` 形如 `clawhub:my-skill`。clawhub 的 slug 跨 owner 重复，`owner` 必须由列表页
 * 原样回传；缺省时上游会按第一条匹配返回。详情整体走 5 分钟 TTL 缓存（详情页会在
 * 安装确认里再被读一次）。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = parseSkillId(decodeURIComponent(id));
  if (!parsed) {
    return NextResponse.json({ error: "无效的技能 id" }, { status: 400 });
  }
  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner")?.trim() || undefined;
  if (owner && !/^[A-Za-z0-9_.-]{1,64}$/.test(owner)) {
    return NextResponse.json({ error: "无效的 owner" }, { status: 400 });
  }

  const cacheKey = detailCacheKey(parsed.source, parsed.slug, owner);
  try {
    let detail = readCache<NormalizedSkillDetail>(cacheKey);
    if (!detail) {
      detail = await providers[parsed.source].detail(parsed.slug, owner);
      writeCache(cacheKey, detail);
    }
    const installState = await installStateFor(parsed.source, parsed.slug);
    return NextResponse.json(
      { skill: { ...detail, ...installState } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const notFound = error instanceof MarketUpstreamError && error.code === "notFound";
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: notFound ? 404 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}