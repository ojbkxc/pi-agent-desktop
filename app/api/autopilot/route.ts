import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  MAX_AUTOPILOT_FIX_ROUNDS,
  readAutopilotSettings,
  writeAutopilotSettings,
  type AutopilotSettings,
} from "@/lib/autopilot";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readAutopilotSettings());
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const patch: Partial<AutopilotSettings> = {};
    for (const key of ["enabled", "autoApproveTeamPlans", "autoFixFailedRuns"] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "boolean") {
        return NextResponse.json({ error: `${key} must be a boolean` }, { status: 400 });
      }
      patch[key] = body[key] as boolean;
    }
    if (body.maxAutoFixRounds !== undefined) {
      if (
        typeof body.maxAutoFixRounds !== "number" ||
        !Number.isInteger(body.maxAutoFixRounds) ||
        body.maxAutoFixRounds < 1 ||
        body.maxAutoFixRounds > MAX_AUTOPILOT_FIX_ROUNDS
      ) {
        return NextResponse.json(
          { error: `maxAutoFixRounds must be an integer between 1 and ${MAX_AUTOPILOT_FIX_ROUNDS}` },
          { status: 400 },
        );
      }
      patch.maxAutoFixRounds = body.maxAutoFixRounds;
    }
    return NextResponse.json(writeAutopilotSettings(patch));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
