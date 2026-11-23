import { NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readModelsConfig } from "@/lib/models-config-store";
import {
  disallowsStoredDiscoveryAuth,
  isSameDiscoveryBaseUrl,
  requestedDiscoveryBaseUrls,
  resolveSavedDiscoveryBaseUrl,
  validateDiscoveryBaseUrl,
} from "@/lib/model-discovery-target";
import { hasJsonContentType, isApiRequestAllowed, readJsonBody } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  let tempDir: string | undefined;

  try {
    const read = await readJsonBody(req);
    if (!read.ok) return read.response;
    const body = read.body as { providerName?: unknown; provider?: unknown; model?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required" }, { status: 400 });
    if (!isRecord(body.model)) return NextResponse.json({ ok: false, error: "model is required" }, { status: 400 });

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return NextResponse.json({ ok: false, error: "Model ID is required" }, { status: 400 });

    tempDir = mkdtempSync(join(tmpdir(), "pi-web-model-test-"));
    const modelsPath = join(tempDir, "models.json");
    // `GET /api/models-config` redacts stored literal apiKeys, so a provider the
    // user edited without touching the key reaches us with no apiKey. Without
    // this fallback the probe authenticates with nothing and fails until the key
    // is re-entered — the exact "only works after re-adding the key" symptom.
    // `!command` / `$ENV` references stay visible and pass through as-is; a key
    // stored in auth.json is resolved by the runtime itself.
    let storedProvider: Record<string, unknown> = {};
    try {
      const stored = readModelsConfig() as { providers?: Record<string, Record<string, unknown>> };
      storedProvider = stored.providers?.[providerName] ?? {};
    } catch {
      // Unreadable models.json: the runtime still resolves auth.json credentials.
    }

    // SSRF / credential-exfiltration guard: a request that points at a Base URL
    // other than the saved provider endpoint must not carry this machine's stored
    // credentials. A newly introduced literal local/private target is rejected;
    // the provider's own saved endpoint (a local Ollama, say) is exempt.
    const requestedUrls = requestedDiscoveryBaseUrls(body.provider, body.model);
    const savedBaseUrl = await resolveSavedDiscoveryBaseUrl(providerName, storedProvider);
    for (const url of requestedUrls) {
      const invalid = validateDiscoveryBaseUrl(url, { allowPrivate: isSameDiscoveryBaseUrl(url, savedBaseUrl) });
      if (invalid) return NextResponse.json({ ok: false, error: invalid }, { status: 400 });
    }
    const useStoredAuth = !disallowsStoredDiscoveryAuth(requestedUrls, savedBaseUrl);

    // With a saved endpoint, fold the stored provider back in (the editor omits
    // the redacted literal apiKey). For an unsaved endpoint, keep only what the
    // request itself sent so no stored credential is spent on it.
    const providerForRuntime = useStoredAuth
      ? { ...storedProvider, ...body.provider }
      : { ...body.provider };

    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [providerName]: {
          ...providerForRuntime,
          models: [{ ...body.model, id: modelId }],
        },
      },
    }, null, 2), "utf8");

    // For an unsaved endpoint, point the runtime at an empty credential store so
    // `completeSimple` cannot resolve this provider's auth.json credential onto
    // it. Only literal values still present in the temp models.json authenticate.
    const modelRuntime = await ModelRuntime.create(useStoredAuth
      ? { modelsPath }
      : { modelsPath, authPath: join(tempDir, "empty-auth.json") });
    const loadError = modelRuntime.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    const model = modelRuntime.getModel(providerName, modelId);
    if (!model) return NextResponse.json({ ok: false, error: `Model not found: ${providerName}/${modelId}` });

    // A status check, not getAuth(): the request resolves auth itself, so a
    // `!command` key runs once per test instead of twice.
    if (!modelRuntime.getProviderAuthStatus(providerName).configured) {
      return NextResponse.json({ ok: false, error: `No API key found for "${providerName}"` });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let status: number | undefined;
    const startedAt = Date.now();

    try {
      // The runtime adds the auth, models.json and session headers a chat request
      // gets (opencode.ai refuses a request without x-opencode-session). One
      // fresh id per probe.
      const message = await modelRuntime.completeSimple(model, {
        messages: [{
          role: "user",
          content: "Reply with OK only.",
          timestamp: Date.now(),
        }],
      }, {
        sessionId: randomUUID(),
        maxTokens: 16,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
        onResponse: (response) => { status = response.status; },
      });

      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return NextResponse.json({
          ok: false,
          error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
          latencyMs,
          status,
        });
      }

      return NextResponse.json({
        ok: true,
        latencyMs,
        status,
        responseText: getAssistantText(message).slice(0, 300),
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
