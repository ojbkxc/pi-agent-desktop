import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isServerPort, readConfiguredServerPort, writeConfiguredServerPort } from "@/lib/server-port";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// `PORT` is what a hosting/desktop launcher sets; the fork's own launchers pass
// PI_WEB_PORT so a `next start -p` port is still visible to this route.
function runningPort(): number | null {
  const parsed = Number(process.env.PORT ?? process.env.PI_WEB_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// GET /api/server-settings - the port this process is listening on and the saved one.
// They differ until the server is restarted, which is what the UI tells the user.
export async function GET(req: Request) {
  return NextResponse.json(
    { port: runningPort(), configured: readConfiguredServerPort(), local: isLocalRequest(req) },
    { headers: NO_STORE },
  );
}

// PUT /api/server-settings  body: { serverPort }
// A listener port is this computer's business: local-only, and it takes effect on restart.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "The server port can only be changed on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { serverPort?: unknown };
    if (!isServerPort(body.serverPort)) {
      return NextResponse.json({ error: "serverPort must be an integer from 1024 to 65535" }, { status: 400 });
    }
    return NextResponse.json(
      { port: runningPort(), configured: writeConfiguredServerPort(body.serverPort), local: true },
      { headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
