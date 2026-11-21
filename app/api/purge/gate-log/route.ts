import { NextResponse } from "next/server";
import { gateAttribution, gateSnapshot } from "@/lib/gate-attribution";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * 只读：哪个闸门拦了多少次，以及本进程最近 500 条闸门事件。
 *
 * 回答的是「这次没答，是模型拒绝还是宿主拦住了」—— 所以它记录、不参与判定。
 * 本路由不写盘、不改设置、不连接任何东西；`reason` 只有代码（`rejected`、
 * `timeout`、`not-trusted`），永不包含命令、路径或密钥。
 */
export function gateLogPayload() {
  return { attribution: gateAttribution(), events: gateSnapshot() };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(gateLogPayload(), { headers: NO_STORE });
}
