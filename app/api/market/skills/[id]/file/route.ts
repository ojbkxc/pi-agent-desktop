import { NextResponse } from "next/server";
import { clawhubProvider } from "@/lib/skill-market/clawhub-provider";
import { skillhubProvider } from "@/lib/skill-market/skillhub-provider";
import { isSafeRelativePath } from "@/lib/skill-market/install-service";
import { detailCacheKey, readCache } from "@/lib/skill-market/market-service";
import {
  MARKET_LIMITS,
  MarketUpstreamError,
  parseSkillId,
  type MarketFileMeta,
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
 * GET /api/market/skills/[id]/file?path=&owner=
 *
 * 详情页的文件预览。正文超过 `previewTruncateBytes` 就截断并带 `truncated: true`——
 * 预览是只读远景，不为了完整显示把几 MB 的文本推给浏览器。
 *
 * 只读：`path` 是上游文件清单里的相对路径，原样转给上游的 file 端点，不落盘。
 *
 * 安全闸门（两层，缺一不可）：
 * 1. **形状校验**：不是绝对路径、不含 `..` 段、不含 NUL、长度合理（与安装落盘同一把
 *    `isSafeRelativePath`）；
 * 2. **清单校验**：path 必须出现在该技能自己的文件清单里（详情缓存命中就用缓存的
 *    files，否则单独拉一次清单——比拉整份详情轻），否则拒绝——否则这个路由等于给
 *    上游开了一个任意 path 转发口子。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    // Same URIError as the detail route: an undecodable segment is a bad id, not
    // an internal failure, so it must answer 400 instead of an HTML 500.
    return NextResponse.json({ error: "无效的技能 id" }, { status: 400 });
  }
  const parsed = parseSkillId(decoded);
  if (!parsed) return NextResponse.json({ error: "无效的技能 id" }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path")?.trim();
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  if (!isSafeRelativePath(path)) {
    return NextResponse.json({ error: "无效的 path" }, { status: 400 });
  }
  const owner = searchParams.get("owner")?.trim() || undefined;
  if (owner && !/^[A-Za-z0-9_.-]{1,64}$/.test(owner)) {
    return NextResponse.json({ error: "无效的 owner" }, { status: 400 });
  }

  try {
    // 清单校验：path 必须在该技能的文件清单里，清单外一律拒绝。
    const cacheKey = detailCacheKey(parsed.source, parsed.slug, owner);
    let files: MarketFileMeta[] | undefined = readCache<NormalizedSkillDetail>(cacheKey)?.files;
    if (!files || files.length === 0) {
      const listed = await providers[parsed.source].listFiles(parsed.slug, owner);
      files = listed.map((file) => ({
        path: file.path,
        size: file.size,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
        ...(file.contentType ? { contentType: file.contentType } : {}),
        language: "",
        tooBig: file.size > MARKET_LIMITS.maxFileSize,
      }));
    }
    if (!files.some((file) => file.path === path)) {
      return NextResponse.json({ error: "该 path 不在该技能的文件清单里" }, { status: 400 });
    }

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
