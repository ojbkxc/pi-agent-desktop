import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  applyNetworkProxy,
  isNetworkProxyMode,
  networkProxyStatus,
  normalizeProxyUrl,
  writeNetworkProxySettings,
} from "@/lib/network-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/network-proxy — the saved mode/URL, the proxy actually in use, and what
// the system probe found. Read-only: it never touches process.env.
export async function GET(req: Request) {
  return NextResponse.json(await networkProxyStatus({ local: isLocalRequest(req) }), {
    headers: NO_STORE,
  });
}

// PUT /api/network-proxy  body: { mode: "direct" | "system" | "manual", url?: string }
//
// Routing this computer's traffic is this computer's business, so it is local-only —
// same rule as the listener port and the Cloudflare tunnel. The change takes effect
// immediately (the dispatcher is re-installed in-process); no restart.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      { error: "The network proxy can only be changed on this computer." },
      { status: 403 },
    );
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { mode?: unknown; url?: unknown };
    if (!isNetworkProxyMode(body?.mode)) {
      return NextResponse.json(
        { error: "mode must be one of direct, system, manual" },
        { status: 400 },
      );
    }
    const url = typeof body.url === "string" ? body.url : "";
    // A manual mode without a usable URL would silently fall back to "no proxy" and
    // look like the setting did nothing, so refuse it instead.
    if (body.mode === "manual" && !normalizeProxyUrl(url)) {
      return NextResponse.json(
        { error: "manual mode needs an http:// or https:// proxy URL" },
        { status: 400 },
      );
    }
    writeNetworkProxySettings({ mode: body.mode, url });
    return NextResponse.json(await applyNetworkProxy(), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
