import { tailscaleLoginOf } from "@/lib/remote-access";
import { readRelayMark } from "@/lib/relay/mark";
import { addSubscription, type PushSubscriptionRecord } from "@/lib/web-push";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

interface SubscribeRequestBody {
  subscription?: Partial<PushSubscriptionRecord>;
  locale?: string;
}

function isValidSubscription(subscription: Partial<PushSubscriptionRecord> | undefined): subscription is PushSubscriptionRecord {
  if (typeof subscription !== "object" || subscription === null) return false;
  if (typeof subscription.endpoint !== "string" || !/^https:\/\//.test(subscription.endpoint)) return false;
  const keys = subscription.keys;
  if (typeof keys !== "object" || keys === null) return false;
  return typeof keys.p256dh === "string" && keys.p256dh.length > 0
    && typeof keys.auth === "string" && keys.auth.length > 0;
}

// POST /api/push/subscribe - register a browser push subscription. Upserts by
// endpoint, so the client can safely re-send its subscription on every load.
export async function POST(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: SubscribeRequestBody;
  try {
    const parsed: unknown = await req.json();
    // `null` / a primitive is legal JSON: reading `body.subscription` off it used
    // to throw a TypeError outside the guard, so the caller got a 500 without a
    // JSON body instead of the 400 that describes the actual mistake.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return Response.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    body = parsed as SubscribeRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isValidSubscription(body.subscription)) {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  const locale = body.locale === "zh-CN" || body.locale === "zh-TW" ? body.locale : "en";
  // A phone subscribing through Tailscale is tied to its login, so removing the login
  // (or turning remote access off) also stops its notifications.
  const login = tailscaleLoginOf(req);
  // Same for a phone paired through the encrypted relay: revoking it stops its notifications.
  const relay = readRelayMark(req);
  const relayDevice = relay && relay !== "forged" ? relay.deviceId : undefined;
  await addSubscription({
    endpoint: body.subscription.endpoint,
    keys: body.subscription.keys,
    locale,
    ...(login ? { login } : {}),
    ...(relayDevice ? { relayDevice } : {}),
  });
  return Response.json({ ok: true });
}
