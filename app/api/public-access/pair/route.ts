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
