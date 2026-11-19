import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { stripJsonComments } from "./jsonc";
import { invalidateModelsCache } from "./models-cache";

const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelCost(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const providedKeys = MODEL_COST_KEYS.filter((key) => value[key] !== undefined);
  if (providedKeys.length === 0) return undefined;
  if (providedKeys.some((key) => (
    typeof value[key] !== "number" || !Number.isFinite(value[key])
  ))) return undefined;

  return Object.fromEntries([
    ...Object.entries(value),
    ...MODEL_COST_KEYS.map((key) => [key, value[key] ?? 0]),
  ]);
}

/** Chat/inference endpoint suffixes people often paste as the Base URL. */
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|completions|messages|responses|embeddings)$/i;

/**
 * Where each API type expects the version segment, and whether it appends one
 * itself (checked in the SDK, 2026-11-19):
 * - `anthropic-messages`: the Anthropic client posts `/v1/messages` on top of
 *   `baseURL`, so the stored URL must **not** end in `/v1` (users paste it
 *   because every OpenAI-compatible proxy does).
 * - `google-generative-ai`: pi sets `apiVersion: ""`, the URL must carry
 *   `/v1beta`.
 * - `openai-*`: the baseURL is used verbatim with `/chat/completions`, so it
 *   needs `/v1`.
 */
const ANTHROPIC_VERSION_SUFFIX = /\/v1$/i;

/**
 * Normalize a provider's Base URL so "paste it with or without `/v1`" both work.
 * Endpoint pastes (`…/v1/chat/completions`) collapse to the API root. A URL
 * with a non-standard version path (`/api/coding/paas/v4`, `/openai/v1`) is left
 * alone — those are real provider layouts, not a stray version segment.
 */
export function normalizeProviderBaseUrl(baseUrl: string, api: string): string {
  const raw = baseUrl.trim();
  if (!raw) return baseUrl;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return baseUrl;
  }
  // Collapse a pasted inference endpoint (`…/v1/chat/completions`) to its root.
  const path = url.pathname.replace(/\/+$/, "").replace(ENDPOINT_SUFFIX, "");
  const isGoogle = api === "google-generative-ai";
  const expected = isGoogle ? "v1beta" : "v1";
  // A standard version segment this API wrote itself (`/v1`, `/v1beta`, and
  // their beta/alpha siblings). Deeper paths (`/api/coding/paas/v4`) are real
  // provider layouts and must survive untouched.
  const standardVersion = /\/(v\d+(?:(?:alpha|beta)\d*)?)$/i;
  const match = standardVersion.exec(path);
  const tail = match ? match[1].toLowerCase() : "";
  const knownVersion = /^v(?:\d+|1beta\d*|1alpha\d*)$/i.test(tail) || tail === "v1beta";
  const isShallow = path === "" || path === "/" || /^\/[^/]+$/.test(path) || /^\/[^/]+\/[^/]+$/.test(path);

  let next: string;
  if (api === "anthropic-messages") {
    // The client appends `/v1/messages` itself; a trailing `/v1` would double it.
    next = knownVersion && tail === "v1" ? path.replace(/\/v1$/i, "") : path;
  } else if (knownVersion && isShallow) {
    next = path.replace(standardVersion, `/${expected}`);
  } else if (knownVersion) {
    // A non-shallow standard-version path (e.g. `/openai/v1`): keep it as-is.
    next = path;
  } else {
    next = `${path}/${expected}`;
  }
  url.pathname = next || "/";
  return url.toString().replace(/\/$/, "");
}

/**
 * Apply {@link normalizeProviderBaseUrl} to every provider and to any per-model
 * `baseUrl` override. Providers without a Base URL (built-ins that fall back to
 * pi's catalog endpoint) are left untouched.
 */
export function normalizeModelsConfigBaseUrls(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;
  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider)) continue;
    const api = typeof provider.api === "string" ? provider.api : "openai-completions";
    if (typeof provider.baseUrl === "string" && provider.baseUrl.trim()) {
      provider.baseUrl = normalizeProviderBaseUrl(provider.baseUrl, api);
    }
    if (!Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || typeof model.baseUrl !== "string" || !model.baseUrl.trim()) continue;
      const modelApi = typeof model.api === "string" && model.api ? model.api : api;
      model.baseUrl = normalizeProviderBaseUrl(model.baseUrl, modelApi);
    }
  }
  return normalized;
}
export function normalizeModelsConfigCosts(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;

  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || !("cost" in model)) continue;
      const cost = normalizeModelCost(model.cost);
      if (cost) model.cost = cost;
      else delete model.cost;
    }
  }
  return normalized;
}

function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

export function getModelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

/** models.json exists but its contents cannot be used, so it must not be replaced. */
export class ModelsConfigReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsConfigReadError";
  }
}

/**
 * Reads models.json with the same leniency as pi's loader (BOM, `//` comments,
 * trailing commas). `stripJsonComments` also drops block comments, which pi
 * rejects, and returns pi's own result for every file pi accepts. A file pi
 * accepts must never read as empty here: the panel saves its whole draft, so
 * an empty read would delete every provider on the next save. Unusable
 * contents throw instead.
 */
export function readModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  if (!existsSync(modelsPath)) return { providers: {} };
  let parsed: unknown;
  try {
    const content = readFileSync(modelsPath, "utf8").replace(/^\uFEFF/, "");
    if (!content.trim()) return { providers: {} };
    parsed = JSON.parse(stripJsonComments(content));
  } catch (error) {
    throw new ModelsConfigReadError(
      `Failed to read ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ModelsConfigReadError(`Failed to read ${modelsPath}: expected a JSON object`);
  }
  return parsed;
}

export function writeModelsConfig(
  data: Record<string, unknown>,
  modelsPath = getModelsConfigPath(),
): void {
  // Refuse to replace a file this panel could not read: the draft being saved
  // was not built from it, so writing would silently discard its contents.
  readModelsConfig(modelsPath);
  const dir = dirname(modelsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const normalized = normalizeModelsConfigCosts(
    normalizeModelsConfigBaseUrls(sanitizeModelsConfig(data)),
  );
  writePrivateFileAtomicSync(modelsPath, JSON.stringify(normalized, null, 2));
  invalidateModelsCache();
}
