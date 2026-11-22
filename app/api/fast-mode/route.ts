import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  normalizeFastModePatch,
  readFastModeConfig,
  writeFastModeConfig,
} from "@/lib/fast-mode/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = readFastModeConfig();
  return NextResponse.json({ preset: config.preset, switches: config.switches });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const next = normalizeFastModePatch(await req.json(), readFastModeConfig());
    const stored = writeFastModeConfig(next);
    return NextResponse.json({ preset: stored.preset, switches: stored.switches });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Validation failures are the caller's fault; a write failure is ours.
    const status = /must be|invalid json|unexpected token|body must/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
