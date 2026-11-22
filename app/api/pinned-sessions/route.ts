import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isSessionRole } from "@/lib/pinned-sessions/types";
import {
  getPinnedRegistryHealth,
  isPinnedSessionRegistered,
  pinSession,
  readPinnedSessions,
  unpinSession,
} from "@/lib/pinned-sessions/store";
import { findPin } from "@/lib/pinned-sessions/types";

export const dynamic = "force-dynamic";

// GET  /api/pinned-sessions          — the pinned list plus whether this process holds
//                                      a live liveness registration for each one
// PUT  /api/pinned-sessions          — body { sessionId, role, note? } pins or re-roles a session
// DELETE /api/pinned-sessions?id=    — unpins
//
// Pinning means "survive the idle eviction" (lib/session-liveness.ts). The registration is
// process-local, so `registered` tells the UI whether it is actually in force right now.
export async function GET() {
  try {
    const file = readPinnedSessions();
    return NextResponse.json({
      sessions: file.sessions.map((session) => ({
        ...session,
        registered: isPinnedSessionRegistered(session.sessionId),
      })),
      // 名单读不出来时 pin 全部未生效；这个字段让设置页能明确说出来，
      // 而不是只显示一个空列表让人以为「pin 自己没了」。
      registryError: getPinnedRegistryHealth().error,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        registryError: getPinnedRegistryHealth().error,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await request.json() as { sessionId?: unknown; role?: unknown; note?: unknown };
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    if (!isSessionRole(body.role)) {
      return NextResponse.json({ error: "role must be \"router\" or \"worker\"" }, { status: 400 });
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return NextResponse.json({ error: "note must be a string" }, { status: 400 });
    }
    const session = pinSession(sessionId, body.role, body.note);
    return NextResponse.json({
      session,
      registered: isPinnedSessionRegistered(sessionId),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function DELETE(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const sessionId = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!sessionId) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    unpinSession(sessionId);
    return NextResponse.json({
      ok: true,
      stillPinned: Boolean(findPin(readPinnedSessions(), sessionId)),
      registered: isPinnedSessionRegistered(sessionId),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}