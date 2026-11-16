import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  cancelOutage,
  cancelOutageOnStop,
  countWaitingOutages,
  retryOutageNow,
} from "@/lib/outage/rpc-hook";
import { listOutageSnapshots, readOutageSettings, writeOutageSettings } from "@/lib/outage/store";
import {
  normalizeOutageSettings,
  OUTAGE_MAX_WAIT_HOURS_OPTIONS,
  type OutageSettings,
} from "@/lib/outage/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/outage — the waiting provider-outage records, the settings, and the
 * total count. Read-only: the scheduler owns every write.
 */
export async function GET(req: Request) {
  const local = isLocalRequest(req);
  return NextResponse.json({
    settings: readOutageSettings(),
    maxWaitHoursOptions: OUTAGE_MAX_WAIT_HOURS_OPTIONS,
    waiting: countWaitingOutages(),
    records: listOutageSnapshots({ waitingOnly: true }),
    local,
  }, { headers: NO_STORE });
}

/**
 * POST /api/outage — one action on one session (local-only):
 *   { action: "cancel", sessionId }      stop waiting, never resume
 *   { action: "retry", sessionId }       resume on the next scheduler tick
 *   { action: "stop", sessionId }        Stop from the chat: same as cancel
 *   { action: "cancel-all" }             cancel every waiting record
 *   { action: "settings", settings }     save the switch / wait limits
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      { error: "Provider-outage waiting can only be changed on this computer." },
      { status: 403 },
    );
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

  try {
    switch (action) {
      case "cancel":
        return NextResponse.json({ ok: cancelOutage(sessionId), waiting: countWaitingOutages() }, { headers: NO_STORE });
      case "stop":
        return NextResponse.json({ ok: cancelOutageOnStop(sessionId), waiting: countWaitingOutages() }, { headers: NO_STORE });
      case "retry":
        return NextResponse.json({ ok: retryOutageNow(sessionId), waiting: countWaitingOutages() }, { headers: NO_STORE });
      case "cancel-all": {
        const records = listOutageSnapshots({ waitingOnly: true });
        let cancelled = 0;
        for (const record of records) {
          if (cancelOutage(record.sessionId)) cancelled += 1;
        }
        return NextResponse.json({ ok: true, cancelled, waiting: countWaitingOutages() }, { headers: NO_STORE });
      }
      case "settings": {
        const patch = normalizeOutageSettings(body.settings) as OutageSettings;
        const settings = writeOutageSettings(patch);
        return NextResponse.json({ ok: true, settings }, { headers: NO_STORE });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}