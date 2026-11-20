import { NextResponse } from "next/server";
import { getPreset } from "@/lib/purge/presets";

export const dynamic = "force-dynamic";

/**
 * One preset, with the full prompt body. The list route deliberately omits
 * `body` (53 prompts of prose would swamp the panel), so this is the only way to
 * read it — a miss is a real 404, not an empty preset, because an unknown id
 * means the catalog moved on since the client loaded the list.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const preset = getPreset(id);
  if (!preset) {
    return NextResponse.json({ error: "Preset not found" }, { status: 404 });
  }
  return NextResponse.json({ preset });
}
