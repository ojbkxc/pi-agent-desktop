import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed, readJsonBody } from "@/lib/request-security";
import { appendPromptHistory, listPromptHistory } from "@/lib/prompt-history";

export const dynamic = "force-dynamic";

/**
 * Cross-session prompt history (ISSUE-11).
 *
 * Mirrors cc-haha's `/api/sessions/prompt-history` contract:
 *   GET  ?project=&projectRoot=&sessionId=&limit=&sessionOnly= — list history,
 *         current session first then same-project other sessions, newest-first.
 *   POST { display, project?, sessionId? } — append one submitted prompt.
 *
 * Both methods gate on `isApiRequestAllowed` so a remote visitor (Cloudflare
 * tunnel, Tailscale relay) cannot read or append another user's prompt history.
 */

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const searchParams = new URL(req.url).searchParams;
  const limitParam = searchParams.get("limit");
  if (limitParam !== null && !/^\d+$/.test(limitParam)) {
    return NextResponse.json({ error: "Invalid limit parameter" }, { status: 400 });
  }
  try {
    const entries = listPromptHistory({
      project: searchParams.get("project") ?? undefined,
      projectRoot: searchParams.get("projectRoot") ?? undefined,
      sessionId: searchParams.get("sessionId") ?? undefined,
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
      sessionOnly: searchParams.get("sessionOnly") === "1" || searchParams.get("sessionOnly") === "true",
    });
    return NextResponse.json({ entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const read = await readJsonBody(req);
    if (!read.ok) return read.response;
    const body = read.body as { display?: unknown; project?: unknown; sessionId?: unknown };
    if (typeof body?.display !== "string" || body.display.trim().length === 0) {
      return NextResponse.json({ error: "Non-empty display string is required" }, { status: 400 });
    }
    if (body.project !== undefined && typeof body.project !== "string") {
      return NextResponse.json({ error: "project must be a string when provided" }, { status: 400 });
    }
    if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
      return NextResponse.json({ error: "sessionId must be a string when provided" }, { status: 400 });
    }
    appendPromptHistory({
      display: body.display,
      project: body.project as string | undefined,
      sessionId: body.sessionId as string | undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
