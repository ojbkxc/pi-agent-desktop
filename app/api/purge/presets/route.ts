import { NextResponse } from "next/server";
import { listPresets } from "@/lib/purge/presets";

export const dynamic = "force-dynamic";

/**
 * A query parameter as the console sends it: absent and blank both mean "no
 * filter", so the UI can clear a search box without dropping the key from the URL
 * and still get the unfiltered list back.
 */
function textParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * `limit` is passed through only when it parses as a number; `listPresets` owns
 * the boundary policy (default 50, cap 500, non-positive falls back to the
 * default), so a garbage value here degrades to that policy instead of 400 —
 * the list is a read, and a bad query string must never blank the panel.
 */
function limitParam(params: URLSearchParams): number | undefined {
  const raw = textParam(params, "limit");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** The preset catalog: `{ items, vendors, total }` straight from `listPresets`. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  return NextResponse.json(listPresets({
    q: textParam(searchParams, "q"),
    vendor: textParam(searchParams, "vendor"),
    limit: limitParam(searchParams),
    // 给了就每项多带一个 `modelMatch`，让面板能标出「写给这个模型的」；
    // 不筛选、不重排，因此没有它时响应与以前完全一致。
    model: textParam(searchParams, "model"),
  }));
}
