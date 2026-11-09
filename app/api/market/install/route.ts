import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { installMarketSkill, uninstallMarketSkill } from "@/lib/skill-market/install-service";
import { clearMarketCache } from "@/lib/skill-market/market-service";
import {
  MARKET_OWNER_PATTERN,
  MarketUpstreamError,
  parseSkillId,
} from "@/lib/skill-market/types";

export const dynamic = "force-dynamic";

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/market/install   body: { id: "clawhub:slug", owner?: string }
 * POST /api/market/uninstall body: { id: "clawhub:slug" }
 *
 * 写操作：与其它写路由同一道闸（isApiRequestAllowed + JSON Content-Type）。
 * 安装会真的往下落盘（`~/.pi/agent/skills/<source>-<slug>/`），所以请求体里**只有**
 * id 与 owner，落盘路径完全由服务端用 slug 生成，客户端无法指定目录。
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const body = await readJson(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const parsed = parseSkillId(id);
  if (!parsed) return NextResponse.json({ error: "无效的技能 id" }, { status: 400 });

  const owner = typeof body.owner === "string" ? body.owner.trim() : undefined;
  if (owner && !MARKET_OWNER_PATTERN.test(owner)) {
    return NextResponse.json({ error: "无效的 owner" }, { status: 400 });
  }

  if (body.action === "uninstall") {
    try {
      const result = await uninstallMarketSkill(parsed.source, parsed.slug);
      // 安装态变了：详情缓存里的 installState 已过期，整体清掉最简单。
      clearMarketCache();
      return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return marketError(error);
    }
  }

  try {
    const result = await installMarketSkill(parsed.source, parsed.slug, owner);
    clearMarketCache();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketError(error);
  }
}

function marketError(error: unknown): NextResponse {
  const code = error instanceof MarketUpstreamError ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const status = code === "notFound" ? 404
    : code === "notInstallable" || code === "installInProgress" || code === "uninstallRefused" ? 409
      : code === "sourceUnavailable" ? 503
        : 502;
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}