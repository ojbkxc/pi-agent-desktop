import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { cancelOptimize } from "@/lib/prompt-optimize-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string; requestId: string }>;
}

// DELETE /api/sessions/[id]/optimize-prompt/[requestId]
// Cancel an in-flight prompt optimization for this session.
export async function DELETE(req: Request, { params }: RouteParams) {
  const { id, requestId } = await params;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const cancelled = await cancelOptimize(id, requestId);
    return NextResponse.json({ requestId, cancelled });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
