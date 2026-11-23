import { sendTestPush } from "@/lib/web-push";
import { readEndpoint } from "@/lib/push-endpoint-body";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// POST /api/push/test  body: { endpoint } - send a test notification to this device only.
export async function POST(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const endpoint = await readEndpoint(req);
  if (!endpoint) return Response.json({ error: "Invalid push endpoint" }, { status: 400 });
  try {
    const sent = await sendTestPush(endpoint);
    if (!sent) return Response.json({ error: "This device is not subscribed" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
