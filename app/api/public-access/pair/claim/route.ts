import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import { claimPairingDevice } from "@/lib/public-access/pairing";
import { deviceCookieHeader } from "@/lib/public-access/devices";
import { isPublicAccessRequestHost, readPublicAccessConfig } from "@/lib/public-access/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/public-access/pair/claim  body: { id, claimSecret }
 *
 * 手机扫码后的第二步：批准之前只回 { status: "pending" }，批准后签发设备令牌
 * 并写 `__Host-pi-remote` Cookie。令牌明文**只**出现在 Set-Cookie 里，不进 JSON
 * body（HttpOnly Cookie 是唯一的浏览器交付通道）。被拒绝 / 过期需要重新扫码。
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
  let body: { id?: unknown; claimSecret?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; claimSecret?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400, headers: NO_STORE });
  }
  const result = claimPairingDevice({ id: body.id, claimSecret: body.claimSecret });
  switch (result.status) {
    case "invalid":
    case "expired":
      return NextResponse.json(
        { error: "Pairing request expired or invalid" },
        { status: 401, headers: NO_STORE },
      );
    case "pending":
    case "rejected":
      return NextResponse.json({ status: result.status }, { headers: NO_STORE });
    case "approved":
      return NextResponse.json(
        { status: "approved", deviceId: result.deviceId, expiresAt: result.expiresAt },
        { headers: { ...NO_STORE, "Set-Cookie": deviceCookieHeader(result.token) } },
      );
  }
}
