import { NextResponse } from "next/server";
import { gatewayId } from "@/lib/public-access/gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /health - 公网隧道的「这真的是本机」验证端点。
// 不在 proxy 的 matcher 里（只有 /、/login、/api/*），所以无需鉴权、可被隧道访问。
// 只回状态与本进程随机 id，不放任何有用信息。
export async function GET() {
  return NextResponse.json(
    { status: "ok", gatewayId: gatewayId() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
