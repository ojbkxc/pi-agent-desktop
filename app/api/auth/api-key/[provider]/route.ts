import { LLAMA_CPP_PROVIDER_ID } from "@/lib/provider-listing";
import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType, storeProviderCredential } from "@/lib/provider-credential-store";
import { getModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { refreshModelCatalogs } from "@/lib/model-catalog-refresh";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

// POST /api/auth/api-key/[provider]  body: { apiKey: string }
// llama.cpp takes the router URL and an optional key through its own login.
export async function POST(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { provider } = await params;
  try {
    let parsed: { apiKey?: unknown; serverUrl?: unknown };
    try {
      parsed = await req.json() as { apiKey?: unknown; serverUrl?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { apiKey = "", serverUrl } = parsed;
    const llama = provider === LLAMA_CPP_PROVIDER_ID;
    if (typeof apiKey !== "string" || (!llama && !apiKey.trim())) {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    let routerUrl: URL | null = null;
    if (llama) {
      try {
        routerUrl = typeof serverUrl === "string" ? new URL(serverUrl) : null;
      } catch {
        routerUrl = null;
      }
      if (!routerUrl || !["http:", "https:"].includes(routerUrl.protocol)) {
        return NextResponse.json({ error: "Enter an http or https llama.cpp router URL" }, { status: 400 });
      }
    }
    const modelRuntime = await getModelRuntimeWithExtensions();
    const apiKeyAuth = modelRuntime.getProvider(provider)?.auth.apiKey;
    if (!apiKeyAuth?.login) {
      throw new Error(`${provider} does not support API key login`);
    }
    let keySubmitted = false;
    const credential = await apiKeyAuth.login({
      signal: req.signal,
      notify: () => {},
      prompt: async (prompt) => {
        if (routerUrl && prompt.type === "text") return routerUrl.href;
        if (prompt.type === "select") {
          const keyOption = prompt.options.find((option) => option.id === "api-key" || option.id === "bearer-token");
          if (keyOption) return keyOption.id;
          throw new Error(`${provider} requires interactive authentication setup`);
        }
        if (!keySubmitted && prompt.type === "secret") {
          keySubmitted = true;
          return apiKey.trim();
        }
        throw new Error(`${provider} requires additional authentication settings`);
      },
    });
    // ModelRuntime.login() persists the credential and then performs an
    // unbounded network catalog refresh. Store the returned credential
    // directly so a slow catalog cannot leave the save request hanging.
    await storeProviderCredential(provider, credential);
    invalidateModelsCache();
    if (llama) {
      const catalog = await refreshModelCatalogs({ providers: [provider], signal: req.signal });
      return NextResponse.json({ success: true, catalog });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/auth/api-key/[provider] — removes stored API key
export async function DELETE(_req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    const removal = await removeStoredCredentialIfType(provider, "api_key");
    if (removal.status === "type_mismatch") {
      return NextResponse.json(
        { error: `${provider} is authenticated with OAuth, not an API key` },
        { status: 409 },
      );
    }
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
