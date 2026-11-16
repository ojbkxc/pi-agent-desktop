import { NextResponse } from "next/server";
import { loadAttentionSnapshot } from "@/lib/attention";

export const dynamic = "force-dynamic";

// GET /api/attention - the "Needs you" inbox: sessions parked on a question or
// approval, plus the newest sessions that finished lately. Read-only and cheap
// enough to poll (the session scan is the same 30s cache /api/sessions uses).
//
// Shape is pinned for the phone home screen: lib/attention-types.ts.
export async function GET() {
  try {
    const snapshot = await loadAttentionSnapshot();
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
