import { NextResponse } from "next/server";
import { autoPresetPayload } from "@/lib/purge/auto-preset";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 只读预览：自动套用会挑中哪一条（见 `lib/purge/auto-preset.ts`）。 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(autoPresetPayload(), { headers: NO_STORE });
}