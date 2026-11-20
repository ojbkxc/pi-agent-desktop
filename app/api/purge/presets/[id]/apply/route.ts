import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readPurgeSettings } from "@/lib/purge-settings";
import { applyPreset, getPreset, isPresetApplyTarget } from "@/lib/purge/presets";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply one builtin preset to the Purge Console settings.
 *
 * The two targets differ in where they land, and the route keeps that difference
 * visible instead of hiding it behind one "saved" message:
 *
 * - `structured_template` returns the settings **in memory only** — applying a
 *   preset must never silently rewrite the operator's stored settings, so the
 *   caller merges this snapshot into its draft and saves it with the console's own
 *   `PUT /api/purge` when it decides to.
 * - `skill_file` writes `<skill_dir>/<id>/SKILL.md` and returns its path; the
 *   settings themselves are unchanged.
 *
 * The gates mirror `PUT /api/purge` exactly: 403 for an untrusted caller, 415 for
 * a non-JSON body, 400 for a body that is not JSON or names a target we do not
 * write to, 404 for an unknown preset, 500 for a failed write.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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
  if (!isRecord(body)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }

  const { target, activate } = body;
  if (!isPresetApplyTarget(target)) {
    return NextResponse.json(
      { error: 'target must be "structured_template" or "skill_file"' },
      { status: 400 },
    );
  }
  if (activate !== undefined && typeof activate !== "boolean") {
    return NextResponse.json({ error: "activate must be a boolean" }, { status: 400 });
  }

  const { id } = await params;
  // Resolve the id first: whether the preset exists is a catalog question with one
  // answer, and asking it here keeps the 404 independent of how `applyPreset`
  // reports a miss.
  if (!getPreset(id)) {
    return NextResponse.json({ error: "Preset not found" }, { status: 404 });
  }

  const settings = readPurgeSettings();
  try {
    const result = applyPreset(settings, id, target, activate);
    return NextResponse.json({ result, settings });
  } catch {
    // Never echo the underlying error: it can carry the skill directory path.
    return NextResponse.json({ error: "Failed to apply preset" }, { status: 500 });
  }
}
