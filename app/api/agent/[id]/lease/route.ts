import { NextResponse } from "next/server";
import { renewSessionLivenessLeases } from "@/lib/session-liveness";
import { isApiRequestAllowed } from "@/lib/request-security";

// POST /api/agent/[id]/lease - Renew selected-session SSE leases.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  return NextResponse.json({
    success: true,
    renewed: renewSessionLivenessLeases(id),
  }, { headers: { "Cache-Control": "no-store" } });
}
