import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { activeModelPayload } from "@/lib/purge/active-model";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 只读：本机的默认模型标识（见 `lib/purge/active-model.ts`）。 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(activeModelPayload(), { headers: NO_STORE });
}