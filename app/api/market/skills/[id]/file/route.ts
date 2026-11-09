import { NextResponse } from "next/server";
import { clawhubProvider } from "@/lib/skill-market/clawhub-provider";
import { skillhubProvider } from "@/lib/skill-market/skillhub-provider";
import {
  MARKET_LIMITS,
  MarketUpstreamError,
  parseSkillId,
  type MarketProvider,
  type MarketSource,
} from "@/lib/skill-market/types";

export const dynamic = "force-dynamic";

const providers: Record<MarketSource, MarketProvider> = {
  clawhub: clawhubProvider,
  skillhub: skillhubProvider,
};

/**
 * GET /api/market/skills/[id]/file?path=&owner=
 *
 * 详情页的文件预览。正文超过 `previewTruncateBytes` 就截断并带 `truncated: true`——
 * 预览是只读远景，不为了完整显示把几 MB 的文本推给浏览器。
 *
 * 只读：`path` 是上游文件清单里的相对路径，原样转给上游的 file 端点，不落盘。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = parseSkillId(decodeURIComponent(id));
  if (!parsed) return NextResponse.json({ error: "无效的技能 id" }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path")?.trim();
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  if (path.length > 512 || path.includes("\0")) {
    return NextResponse.json({ error: "无效的 path" }, { status: 400 });
  }
  const owner = searchParams.get("owner")?.trim() || undefined;
  if (owner && !/^[A-Za-z0-9_.-]{1,64}$/.test(owner)) {
    return NextResponse.json({ error: "无效的 owner" }, { status: 400 });
  }

  try {
    const fetched = await providers[parsed.source].fetchFile(parsed.slug, path, owner);
    const truncated = fetched.size > MARKET_LIMITS.previewTruncateBytes
      || fetched.content.length > MARKET_LIMITS.previewTruncateBytes;
    const content = truncated
      ? fetched.content.slice(0, MARKET_LIMITS.previewTruncateBytes)
      : fetched.content;
    return NextResponse.json(
      { content, size: fetched.size, truncated },
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