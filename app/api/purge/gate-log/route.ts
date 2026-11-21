import { NextResponse } from "next/server";
import { gateLogPayload } from "@/lib/gate-attribution";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 只读：闸门归属视图（`gateLogPayload()` 在 lib/gate-attribution.ts）。 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(gateLogPayload(), { headers: NO_STORE });
}