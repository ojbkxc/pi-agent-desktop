import { NextResponse } from "next/server";
import { resolveModelDiscoveryAuth, type ModelDiscoveryAuth } from "@/lib/model-discovery-auth";
import {
  disallowsStoredDiscoveryAuth,
  isSameDiscoveryBaseUrl,
  readStoredProvider,
  requestedDiscoveryBaseUrls,
  resolveSavedDiscoveryBaseUrl,
  validateDiscoveryBaseUrl,
} from "@/lib/model-discovery-target";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { isLocalRequest } from "@/lib/remote-access";
import { buildModelsListUrl, collectModelPages, parseDiscoveredModels, type ModelPageFetchResult } from "@/lib/model-discovery";

export const dynamic = "force-dynamic";

const DISCOVERY_TIMEOUT_MS = 20_000;
/** Budget for the whole walk, so 20 slow pages cannot hold the request for minutes. */
const DISCOVERY_TOTAL_TIMEOUT_MS = 60_000;
const MAX_DISCOVERY_PAGES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function buildHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;

  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ error: "provider is required" }, { status: 400 });

    const configuredBaseUrl = typeof body.provider.baseUrl === "string" ? body.provider.baseUrl.trim() : "";
    const configuredApi = typeof body.provider.api === "string" && body.provider.api ? body.provider.api : "";

    // A request that introduces a Base URL other than the saved one must not be
    // authenticated with this machine's stored credentials (auth.json); otherwise
    // an authenticated client could point a saved provider at its own host and
    // read the stored key off the outgoing request.
    const requestedUrls = requestedDiscoveryBaseUrls(body.provider);
    const savedBaseUrl = await resolveSavedDiscoveryBaseUrl(providerName, readStoredProvider(providerName));

    const useStoredAuth = !disallowsStoredDiscoveryAuth(requestedUrls, savedBaseUrl);

    // SSRF guard. Two different dangers live here, and they need different rules:
    //  • **Credential exfiltration**: this machine's stored key must never be spent on a
    //    host the request chose. That is already handled by `useStoredAuth` above.
    //  • **Reaching an internal service**: the server would fetch whatever address it is
    //    given, credentials or not. A local model server (`http://127.0.0.1:8787/v1`,
    //    Ollama's 11434, LM Studio) is a *documented* target, so the split is **who is
    //    asking**, not whether a key is involved: a request from this machine may point
    //    at a local/private address; a request relayed from another machine, the
    //    Tailscale funnel, or an allowed login may not.
    // Workshop note: the first version keyed the exemption off "no stored credential",
    // which let a remote client still probe loopback without sending a key — a
    // regression the route tests caught.
    const fromThisMachine = isLocalRequest(req);
    for (const url of requestedUrls) {
      const allowPrivate = fromThisMachine || isSameDiscoveryBaseUrl(url, savedBaseUrl);
      const invalid = validateDiscoveryBaseUrl(url, { allowPrivate });
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    }

    let auth: ModelDiscoveryAuth;
    if (useStoredAuth) {
      try {
        auth = await resolveModelDiscoveryAuth(providerName, body.provider);
      } catch (error) {
        // Without a configured Base URL, pi's catalog was the only other source of
        // one; for a custom provider it fails with an error about the placeholder model.
        if (!configuredBaseUrl) return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
        throw error;
      }
      if (typeof body.provider.apiKey === "string" && body.provider.apiKey.trim() && !auth.apiKey) {
        return NextResponse.json({ error: `No API key found for "${providerName}"` }, { status: 400 });
      }
    } else {
      // Unsaved endpoint: no stored credentials. Only a key the request itself
      // typed is used, passed through verbatim (`!cmd` / `$ENV` left as-is).
      const literalApiKey = typeof body.provider.apiKey === "string" && body.provider.apiKey.trim()
        ? body.provider.apiKey
        : undefined;
      auth = {
        apiKey: literalApiKey,
        headers: stringRecord(body.provider.headers),
        baseUrl: configuredBaseUrl || undefined,
        api: configuredApi || undefined,
      };
    }

    // Fall back to pi's provider catalog so built-in providers, and entries
    // that only list models, do not have to repeat the upstream base URL.
    const baseUrl = configuredBaseUrl || auth.baseUrl || "";
    if (!baseUrl) return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    const api = configuredApi || auth.api || "openai-completions";

    let endpoint: URL;
    try {
      endpoint = buildModelsListUrl(baseUrl, api);
    } catch {
      return NextResponse.json({ error: "Base URL is invalid" }, { status: 400 });
    }

    const headers = buildHeaders(api, auth.apiKey, auth.headers);
    const totalBudget = AbortSignal.timeout(DISCOVERY_TOTAL_TIMEOUT_MS);
    const collected = await collectModelPages({
      firstUrl: endpoint,
      api,
      maxPages: MAX_DISCOVERY_PAGES,
      fetchPage: async (pageUrl): Promise<ModelPageFetchResult> => {
        const response = await fetch(pageUrl, {
          cache: "no-store",
          headers,
          signal: AbortSignal.any([AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), totalBudget]),
        });
        const responseText = await response.text();
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            error: responseText.slice(0, 500) || `Upstream returned HTTP ${response.status}`,
          };
        }
        try {
          return { ok: true, payload: JSON.parse(responseText) };
        } catch {
          return { ok: false, status: response.status, error: "Upstream model list was not valid JSON" };
        }
      },
    });
    if (!collected.ok) {
      return NextResponse.json(
        collected.upstreamStatus === undefined
          ? { error: collected.error }
          : { error: collected.error, status: collected.upstreamStatus },
        { status: collected.status },
      );
    }

    const pages = collected.pages;
    const models = parseDiscoveredModels(pages.length === 1 ? pages[0] : pages);
    if (models.length === 0) {
      return NextResponse.json({ error: "No models found in the upstream response" }, { status: 502 });
    }

    return NextResponse.json({ models, endpoint: endpoint.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
