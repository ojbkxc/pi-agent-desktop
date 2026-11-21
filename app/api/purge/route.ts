import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readPurgeSettings, writePurgeSettings } from "@/lib/purge-settings";
import { purgeStatsSnapshot } from "@/lib/purge/stats";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The console snapshot: the effective settings, the in-process counters, and the
 * server's own pid/uptime so the panel can show "running since".
 *
 * Gated like every other purge read: the console's settings carry the operator's
 * rewrite tables and skill directory, and a page on another origin must not be
 * able to read them just because it can reach the port.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json({
    settings: readPurgeSettings(),
    stats: purgeStatsSnapshot(),
    runtime: {
      pid: process.pid,
      uptime_secs: Math.round(process.uptime()),
    },
  });
}

/**
 * Replace the settings. The body is either a bare settings object or
 * `{ settings }` — both are normalized against the whitelist, so unknown keys
 * are dropped rather than saved.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = isRecord(body) && Object.prototype.hasOwnProperty.call(body, "settings")
    ? body.settings
    : body;
  if (!isRecord(input)) {
    return NextResponse.json({ error: "settings must be a JSON object" }, { status: 400 });
  }

  try {
    return NextResponse.json({ settings: writePurgeSettings(input) });
  } catch {
    // Never echo the underlying error: it can carry the settings file path.
    return NextResponse.json({ error: "Failed to save purge settings" }, { status: 500 });
  }
}