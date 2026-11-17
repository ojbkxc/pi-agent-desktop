import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listDevices } from "@/lib/public-access/devices";
import { pairingSnapshot } from "@/lib/public-access/pairing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/public-access/devices
 *
 * 桌面「手机接入」子节的轮询接口：已配对设备（不含任何令牌/哈希）、等待批准
 * 的配对请求、二维码是否仍有效。只回给本机。
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Phones are managed on this computer." }, { status: 403 });
  }
  const snapshot = pairingSnapshot();
  return NextResponse.json(
    {
      devices: listDevices(),
      pending: snapshot.pending,
      pairing: { active: snapshot.active, expiresAt: snapshot.expiresAt },
    },
    { headers: NO_STORE },
  );
}
