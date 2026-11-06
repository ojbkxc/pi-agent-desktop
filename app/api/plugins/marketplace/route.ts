import { NextResponse } from "next/server";
import { fetchMarketplace } from "@/lib/plugin-marketplace";

export const dynamic = "force-dynamic";

/**
 * GET /api/plugins/marketplace
 *
 * Read-only: fetches the pi-extensions catalog and returns it for the Plugins
 * panel. It takes no parameters — in particular no `cwd` — because the browser
 * matches entries against the already-loaded `packages[].source` itself.
 *
 * The upstream URL is server-fixed (`lib/plugin-marketplace.ts`), so the request
 * cannot steer it; no `isApiRequestAllowed` guard is needed (that is the write
 * gate). The only bounded cost is the 15s upstream timeout.
 */
export async function GET() {
  try {
    const catalog = await fetchMarketplace();
    return NextResponse.json({
      marketplace: {
        name: catalog.name,
        owner: catalog.owner,
        description: catalog.description,
        version: catalog.version,
      },
      entries: catalog.entries,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError") {
      return NextResponse.json({ error: "Marketplace request timed out" }, { status: 504 });
    }

    const upstreamStatus = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus;
    if (typeof upstreamStatus === "number" && upstreamStatus >= 400) {
      // Never echo the upstream body — only the status.
      return NextResponse.json(
        { error: `Marketplace upstream returned HTTP ${upstreamStatus}` },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
