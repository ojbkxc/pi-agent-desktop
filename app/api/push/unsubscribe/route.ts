import { removeSubscription } from "@/lib/web-push";
import { readEndpoint } from "@/lib/push-endpoint-body";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// POST /api/push/unsubscribe  body: { endpoint } - stop pushing to this device.
export async function POST(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const endpoint = await readEndpoint(req);
  if (!endpoint) return Response.json({ error: "Invalid push endpoint" }, { status: 400 });
  return Response.json({ ok: true, removed: await removeSubscription(endpoint) });
}
