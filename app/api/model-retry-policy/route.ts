import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed, readJsonBody } from "@/lib/request-security";
import { MODEL_RETRY_POLICIES, isModelRetryPolicy } from "@/lib/outage/retry-policy";
import {
  MODEL_RETRY_POLICY_WILDCARD,
  effectiveModelRetryPolicy,
  readModelRetryPolicySettings,
  setProviderModelRetryPolicy,
  writeModelRetryPolicySettings,
} from "@/lib/outage/retry-policy-store";

export const dynamic = "force-dynamic";

/**
 * `GET /api/model-retry-policy?provider=<id>`
 *
 * 每个 provider 的重试策略（`default` / `transient` / `all`）。不带 provider 时回
 * 整张表，供设置页一次画完；带 provider 时额外给出**生效值**（自己 → `*` → 默认）。
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const settings = readModelRetryPolicySettings();
  const provider = new URL(req.url).searchParams.get("provider");
  if (provider) {
    return NextResponse.json({
      provider,
      policy: effectiveModelRetryPolicy(provider, settings),
      policies: MODEL_RETRY_POLICIES,
    });
  }
  return NextResponse.json({
    policies: MODEL_RETRY_POLICIES,
    providers: settings.providers,
    wildcard: settings.providers[MODEL_RETRY_POLICY_WILDCARD] ?? "default",
    allMaxWaitHours: settings.allMaxWaitHours,
  });
}

/**
 * `PUT /api/model-retry-policy`  body: `{ provider, policy }` 或 `{ allMaxWaitHours }`
 *
 * 写的是 pi-web 自己的 settings.json（`modelRetryPolicy` 键），**不动 models.json**：
 * 那是 pi 的配置格式，塞自定义键会被它当成非法 provider 字段。
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const body = read.body as { provider?: unknown; policy?: unknown; allMaxWaitHours?: unknown };

  try {
    if (body?.allMaxWaitHours !== undefined) {
      if (typeof body.allMaxWaitHours !== "number" || !Number.isFinite(body.allMaxWaitHours) || body.allMaxWaitHours <= 0) {
        return NextResponse.json({ error: "allMaxWaitHours must be a positive number" }, { status: 400 });
      }
      const settings = writeModelRetryPolicySettings({ allMaxWaitHours: body.allMaxWaitHours });
      return NextResponse.json({ allMaxWaitHours: settings.allMaxWaitHours });
    }

    if (typeof body?.provider !== "string" || !body.provider.trim()) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    if (!isModelRetryPolicy(body.policy)) {
      return NextResponse.json(
        { error: `policy must be one of ${MODEL_RETRY_POLICIES.join(", ")}` },
        { status: 400 },
      );
    }
    const settings = setProviderModelRetryPolicy(body.provider, body.policy);
    return NextResponse.json({
      provider: body.provider.trim(),
      policy: effectiveModelRetryPolicy(body.provider, settings),
      providers: settings.providers,
    });
  } catch (error) {
    // Internal failures stay generic; the retry policy is not worth leaking a stack.
    console.error(
      "[pi-web] model retry policy write failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: "Could not save the retry policy" }, { status: 500 });
  }
}
