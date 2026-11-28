import { NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Api, AssistantMessage, Model, ThinkingLevel } from "@earendil-works/pi-ai";
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
import { isLocalRequest } from "@/lib/remote-access";
import {
  PROBE_LEVELS,
  classifyProbeFailure,
  mapWithConcurrency,
  payloadCarriesValue,
  probeModelFor,
  probeFailureStatus,
  probeValueFor,
  summarizeThinkingProbe,
  type LevelProbeResult,
  type ThinkingLevelMap,
} from "@/lib/thinking-level-probe";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;
/** Level probes run a few at a time: six at once trips some providers' rate limits. */
const PROBE_CONCURRENCY = 2;

interface ProbeOutcome {
  message: AssistantMessage;
  status?: number;
  latencyMs: number;
  aborted: boolean;
}

/**
 * One small request through the runtime, prepared as a chat request is (auth,
 * models.json headers, a fresh session id). `reasoning` sets the thinking level.
 */
async function sendProbe(
  modelRuntime: ModelRuntime,
  model: Model<Api>,
  options: { reasoning?: ThinkingLevel; onPayload?: (payload: unknown) => void } = {},
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  let status: number | undefined;
  const startedAt = Date.now();
  try {
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
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      ...(options.onPayload ? { onPayload: (payload: unknown) => { options.onPayload?.(payload); return undefined; } } : {}),
      onResponse: (response) => { status = response.status; },
    });
    return { message, status, latencyMs: Date.now() - startedAt, aborted: controller.signal.aborted };
  } finally {
    clearTimeout(timeout);
  }
}

function draftThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  if (!isRecord(value)) return undefined;
  const map: ThinkingLevelMap = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || typeof entry === "string") map[key] = entry;
  }
  return map;
}

async function probeLevels(
  modelRuntime: ModelRuntime,
  model: Model<Api>,
  map: ThinkingLevelMap | undefined,
): Promise<LevelProbeResult[]> {
  return mapWithConcurrency(PROBE_LEVELS, PROBE_CONCURRENCY, async (level): Promise<LevelProbeResult> => {
    const value = probeValueFor(level, map);
    if (value === null) return { level, value, outcome: "skipped" };
    let carried = false;
    try {
      const outcome = await sendProbe(modelRuntime, probeModelFor(model, level, value), {
        reasoning: level,
        onPayload: (payload) => { carried = carried || payloadCarriesValue(payload, value); },
      });
      const failed = outcome.message.stopReason === "error" || outcome.message.stopReason === "aborted";
      if (!carried) return { level, value, outcome: "not-sent", status: outcome.status };
      if (!failed) return { level, value, outcome: "accepted", status: outcome.status };
      const status = probeFailureStatus(outcome.status, outcome.message.errorMessage);
      return {
        level,
        value,
        outcome: outcome.aborted ? "inconclusive" : classifyProbeFailure(status),
        status,
        error: outcome.message.errorMessage ?? (outcome.aborted ? "Test timed out" : "Model returned an error"),
      };
    } catch (error) {
      return { level, value, outcome: "inconclusive", error: errorMessage(error) };
    }
  });
}

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
    const body = read.body as { providerName?: unknown; provider?: unknown; model?: unknown; probeThinking?: unknown };
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

    // SSRF / credential-exfiltration guard. Two dangers, two rules:
    //  • the stored key must never be spent on a request-chosen host (handled by
    //    `useStoredAuth` below), and
    //  • the server must not be steered at an internal service. A local model server
    //    is a documented target, so the split is **who is asking**: a request from this
    //    machine may target a local/private address; one relayed from another machine,
    //    the Tailscale funnel, or an allowed login may not.
    const requestedUrls = requestedDiscoveryBaseUrls(body.provider, body.model);
    const savedBaseUrl = await resolveSavedDiscoveryBaseUrl(providerName, storedProvider);
    const useStoredAuth = !disallowsStoredDiscoveryAuth(requestedUrls, savedBaseUrl);
    const fromThisMachine = isLocalRequest(req);
    for (const url of requestedUrls) {
      const allowPrivate = fromThisMachine || isSameDiscoveryBaseUrl(url, savedBaseUrl);
      const invalid = validateDiscoveryBaseUrl(url, { allowPrivate });
      if (invalid) return NextResponse.json({ ok: false, error: invalid }, { status: 400 });
    }

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

    const probeThinking = body.probeThinking === true;
    if (probeThinking && !model.reasoning) {
      return NextResponse.json({ ok: false, error: "This model is not marked as a reasoning model" });
    }

    // The plain request first: it is the connection test, and the baseline that lets a
    // level's 400 count as that level being refused.
    const baseline = await sendProbe(modelRuntime, model);
    if (baseline.message.stopReason === "error" || baseline.message.stopReason === "aborted") {
      return NextResponse.json({
        ok: false,
        error: baseline.message.errorMessage ?? (baseline.aborted ? "Test timed out" : "Model returned an error"),
        latencyMs: baseline.latencyMs,
        status: baseline.status,
      });
    }

    return NextResponse.json({
      ok: true,
      latencyMs: baseline.latencyMs,
      status: baseline.status,
      responseText: getAssistantText(baseline.message).slice(0, 300),
      ...(probeThinking
        ? {
          // The draft's own map, not the runtime's: the suggestion replaces what the editor shows.
          thinking: summarizeThinkingProbe(
            draftThinkingLevelMap(body.model.thinkingLevelMap),
            await probeLevels(modelRuntime, model, draftThinkingLevelMap(body.model.thinkingLevelMap)),
          ),
        }
        : {}),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
