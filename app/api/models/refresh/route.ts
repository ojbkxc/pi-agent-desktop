import { NextResponse } from "next/server";
import { shareModelCatalogRefresh } from "@/lib/model-catalog-refresh";
import { hasJsonContentType } from "@/lib/request-security";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * POST /api/models/refresh — fetch the remote provider catalogs now.
 *
 * Body: `{ provider?: string }`. Without one every refreshable provider is
 * passed over, which is what the panel-wide button sends.
 *
 * 闸门说明（api-guard 审计的两条「有意等价」，这里写明免得后人当 bug 改）：
 * - **不强制 Content-Type**：面板按钮发的是 JSON，但这条端点的语义是「现在就
 *   刷新」，一个不带 body 的裸 POST（curl、健康检查脚本、上一版客户端）同样合法。
 *   415 会把这些没有任何危害的调用打成失败，而它们并不能让谁多做一件事。
 * - **空 body = 全部 provider**：这不是「解析失败被吞掉」，而是文档化的默认值
 *   （见上）。但**畸形 JSON 必须是 400**：以前两者混在一个 catch 里，一个打错的
 *   `{` 会静默触发对全部 provider 的网络请求——一次拼写错误变成一次全量刷新。
 *   所以先看原文是否为空，再决定「默认值」还是「解析错误」。
 *
 * The response says only whether the pass completed and whether anything
 * moved. The refreshed catalog itself reaches the browser through the
 * `/api/models` and `/api/models/enabled` reloads the caller does next, so
 * there is no second shape of the model list to keep in agreement.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  // `text()` rather than `json()`: the two outcomes below need to be told apart.
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read the request body" }, { status: 400 });
  }
  let provider: string | undefined;
  if (raw.trim() !== "") {
    if (!hasJsonContentType(req)) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      // Never echo the parser's message: it is an internal detail.
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (typeof body === "object" && body !== null) {
      const candidate = (body as { provider?: unknown }).provider;
      if (typeof candidate === "string" && candidate.trim()) provider = candidate.trim();
    }
  }

  const result = await shareModelCatalogRefresh(provider ? { providers: [provider] } : {});
  return Response.json(result);
}
