import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import { redeemPairingSecret } from "@/lib/public-access/pairing";
import { isPublicAccessRequestHost, readPublicAccessConfig } from "@/lib/public-access/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/public-access/pair  body: { secret, name? }
 *
 * 手机扫码后的第一步（见 lib/public-access/pairing.ts）。只允许从隧道的公网
 * 域名进来：配对材料是扫出来的二维码，局域网/环回请求没有合法的手机在背后。
 * 这里不要求 web 密码 / device token —— 一次性 secret 本身就是凭据，且 proxy.ts
 * 只对隧道域名放行这条路径。
 *
 * 为什么第一道闸是 `isPublicAccessRequestHost` 而不是 `isApiRequestAllowed`
 * （api-guard 审计判为「有意等价」，写在这里免得后人照统一口径改错）：
 * - `isApiRequestAllowed` 要求 Host 是本机/已配置域名**且** Origin 同源。手机第一次
 *   配对时还没有任何凭据，它从隧道域名打开页面、请求自然带隧道 Host——这正是要放行
 *   的那一种。本机 Host 的请求则被这道闸明确拒绝：本机没有「扫码的手机」这回事，
 *   让它进来只会扩大一次性的 secret 的可用面。
 * - 凭据是 body 里的**一次性** secret：`redeemPairingSecret` 校验并消费它，错误
 *   401、超设备上限 429、成功签发按设备区分的 token。所以「谁能调这个端点」由
 *   secret 决定，而不是由来源决定——这与其它写路由的模型不同，是有意的。
 * - 隧道域名本身受 proxy.ts 的双重约束：未设 web 密码时公网流量被整个拒绝
 *   （见 proxy.ts 的 public-access 分支），所以这里不会先于密码闸生效。
 */
export async function POST(req: Request) {
  if (!isPublicAccessRequestHost(req, readPublicAccessConfig())) {
    return NextResponse.json(
      { error: "Pairing is only available through the public tunnel address" },
      { status: 403, headers: NO_STORE },
    );
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415, headers: NO_STORE },
    );
  }
  let body: { secret?: unknown; name?: unknown };
  try {
    body = (await req.json()) as { secret?: unknown; name?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400, headers: NO_STORE });
  }
  const result = redeemPairingSecret({ secret: body.secret, name: body.name });
  if (!result.ok) {
    return result.reason === "limit"
      ? NextResponse.json({ error: "Device limit reached" }, { status: 429, headers: NO_STORE })
      : NextResponse.json({ error: "Pairing code expired or invalid" }, { status: 401, headers: NO_STORE });
  }
  return NextResponse.json({ id: result.id, claimSecret: result.claimSecret }, { headers: NO_STORE });
}
