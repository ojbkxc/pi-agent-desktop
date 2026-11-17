import { NextResponse } from "next/server";
import qrcode from "qrcode-generator";
import { isLocalRequest } from "@/lib/remote-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { beginPairing } from "@/lib/public-access/pairing";
import { readPublicAccessConfig } from "@/lib/public-access/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 二维码内容：隧道公网地址上的配对页 + 一次性 secret。 */
function pairingUrl(origin: string, secret: string): string {
  return `${origin}/pair?secret=${encodeURIComponent(secret)}`;
}

/**
 * 复用仓里已有的 qrcode-generator（components/RelaySection.tsx 同一个库），
 * 服务端直接出 SVG，不引入新依赖、不走 canvas。
 */
function qrSvg(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
}

/**
 * POST /api/public-access/pair/qr
 *
 * 桌面侧生成「手机接入」二维码。只有本机可以调用（配对 secret 等同于一次
 * 免密登录机会）；旧二维码在新请求里立即作废。响应只回给本机界面。
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Phones are paired on this computer." }, { status: 403 });
  }
  const origin = readPublicAccessConfig().origin;
  if (!origin) {
    return NextResponse.json(
      { error: "The tunnel is not online yet. Start it, then show the QR code.", code: "tunnel-offline" },
      { status: 409, headers: NO_STORE },
    );
  }
  const { secret, expiresAt } = beginPairing();
  const url = pairingUrl(origin, secret);
  return NextResponse.json(
    { url, svg: qrSvg(url), expiresAt },
    { headers: NO_STORE },
  );
}
