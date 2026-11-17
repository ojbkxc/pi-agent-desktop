import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { answerPairing } from "@/lib/public-access/pairing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// POST /api/public-access/pair/[id]  body: { action: "approve" | "reject" }
// 配对请求只在电脑上批准/拒绝（与 /api/relay/pairing/[id] 同一姿势）。
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Phones are approved on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const body = await req.json().catch(() => ({})) as { action?: unknown };
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });
  }
  const result = answerPairing(id, body.action);
  if (result === "not-found") {
    return NextResponse.json({ error: "That pairing request is gone or expired." }, { status: 404 });
  }
  if (result === "answered") {
    return NextResponse.json({ error: "That pairing request was already answered." }, { status: 409 });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
