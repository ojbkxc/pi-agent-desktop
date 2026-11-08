import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { readCompactionPolicy, type CompactionPolicy } from "./compaction-policy";
import {
  selectCompactionModels,
  type CompactionModelLike,
  type SelectCompactionModelsInput,
} from "./compaction-model-select";

/**
 * `session_before_compact` extension: try the policy's compaction-model chain,
 * then hand the run back to the SDK when nothing works.
 *
 * Everything the handler touches is injected (`modelRegistry`, `compactFn`,
 * `logger`), so tests can run the whole downgrade path with plain objects and
 * never reach a provider. The SDK is imported lazily inside the default
 * `compactFn`, which keeps the pure logic (and its tests) free of SDK runtime
 * loading.
 *
 * Behaviour the plan pins down:
 * - Only the summary request is re-routed. The session model, its thinking
 *   level and its `streamFn` are untouched — `compact()` is called with
 *   `thinkingLevel: undefined` and `streamFn: undefined`, so no thinking and no
 *   main-provider stream function leak into this request.
 * - The event's `AbortSignal` is forwarded verbatim. A user cancel stops the
 *   chain immediately; it never downgrades to the next model.
 * - Credential resolution happens per candidate. `ok:false` skips the candidate
 *   and the diagnostic never carries the error's raw text.
 * - Every failure (no credentials, throttling, network, empty summary, length
 *   stop, malformed result) is logged as a short secret-free code and the next
 *   candidate is tried.
 * - When the chain is exhausted the handler returns `undefined`, which is the
 *   SDK's native compaction path with the current model. The extension never
 *   appends a duplicate main-model request on its own.
 * - A success keeps `summary` / `firstKeptEntryId` / `tokensBefore` / `usage`
 *   from the SDK result, preserves its `readFiles` / `modifiedFiles` file
 *   tracking, and adds `{ compactionModel, fallbackCount, mode }`.
 */

export const COMPACTION_MODEL_EXTENSION_NAME = "pi-web-compaction-model";

/** System prompt, prompts and framing on top of the serialized conversation. */
const SUMMARIZATION_OVERHEAD_TOKENS = 1_024;
/** Longest diagnostic line kept in logs, before redaction. */
const DIAGNOSTIC_MAX_CHARS = 160;
/** SDK `serializeConversation` truncates each tool result to this many chars. */
const TOOL_RESULT_MAX_CHARS = 2_000;
/** Image blocks count as a fixed character budget in the SDK's estimator. */
const ESTIMATED_IMAGE_CHARS = 4_800;

export interface CompactionPreparationLike {
  firstKeptEntryId: string;
  messagesToSummarize: readonly unknown[];
  turnPrefixMessages: readonly unknown[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps?: {
    readonly read: ReadonlySet<string>;
    readonly written: ReadonlySet<string>;
    readonly edited: ReadonlySet<string>;
  };
  settings?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}

export interface CompactionResultLike {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  usage?: Usage;
  details?: unknown;
}

export interface SessionBeforeCompactEventLike {
  preparation: CompactionPreparationLike;
  signal: AbortSignal;
  customInstructions?: string;
  reason?: "manual" | "threshold" | "overflow";
  willRetry?: boolean;
}

export type CompactionAuthResolution =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string | null>;
      baseUrl?: string;
      env?: Record<string, string>;
    }
  | { ok: false; error?: string };

/** The `ModelRegistry` surface this extension needs (`ExtensionContext.modelRegistry`). */
export interface CompactionModelRegistryLike {
  getAvailable(): readonly CompactionModelLike[];
  getApiKeyAndHeaders(model: CompactionModelLike): Promise<CompactionAuthResolution>;
}

export interface CompactionExtensionContextLike {
  model?: CompactionModelLike;
  modelRegistry: CompactionModelRegistryLike;
}

/**
 * The SDK `compact()` call shape, minus the knobs this extension deliberately
 * leaves at their defaults. `thinkingLevel` and `streamFn` are declared as
 * `undefined` so a wiring layer cannot accidentally forward the session's.
 */
export type CompactionCompactFn = (
  preparation: CompactionPreparationLike,
  model: CompactionModelLike,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: undefined,
  streamFn?: undefined,
  env?: Record<string, string>,
) => Promise<CompactionResultLike>;

export interface CompactionDiagnosticsLogger {
  warn(message: string): void;
}

export type CompactionFailureCode =
  | "no-credentials"
  | "credential-error"
  | "aborted"
  | "rate-limited"
  | "network"
  | "length-stop"
  | "empty-summary"
  | "invalid-result"
  | "request-failed";

export interface CompactionDiagnostic {
  code: CompactionFailureCode;
  /** `provider/modelId` of the candidate that failed. Never a credential. */
  ref: string;
}

/** The extra metadata attached next to the SDK's file lists. */
export interface CompactionModelSelectionDetails {
  compactionModel: { provider: string; modelId: string };
  /** Failed candidates tried before the successful one (0 = first try). */
  fallbackCount: number;
  /** The `compactionModel` policy choice that produced this chain. */
  mode: CompactionPolicy["compactionModel"];
}

export interface CompactionModelExtensionOptions {
  /**
   * Registry used for credentials and the candidate list. Production wiring may
   * omit it and let the handler use the session context's own
   * `ctx.modelRegistry`; tests inject a fake here.
   */
  modelRegistry?: CompactionModelRegistryLike;
  /** Defaults to the SDK's `compact`. Tests inject a fake. */
  compactFn?: CompactionCompactFn;
  /** Defaults to reading `compactionPolicy` from Pi Web's settings file. */
  readPolicy?: () => CompactionPolicy;
  /** Defaults to `console.warn`; receives only redacted diagnostics. */
  logger?: CompactionDiagnosticsLogger;
  /** See `SelectCompactionModelsInput.isZeroPriceTrusted`. Defaults to trusting 0/0. */
  isZeroPriceTrusted?: SelectCompactionModelsInput<CompactionModelLike>["isZeroPriceTrusted"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const defaultLogger: CompactionDiagnosticsLogger = {
  warn(message) {
    console.warn(message);
  },
};

/** Lazily loading the SDK keeps the pure module (and its tests) light. */
const defaultCompactFn: CompactionCompactFn = async (
  preparation,
  model,
  apiKey,
  headers,
  customInstructions,
  signal,
  _thinkingLevel,
  _streamFn,
  env,
) => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  return sdk.compact(
    preparation as unknown as Parameters<typeof sdk.compact>[0],
    model as unknown as Model<Api>,
    apiKey,
    headers,
    customInstructions,
    signal,
    undefined,
    undefined,
    env,
  ) as unknown as CompactionResultLike;
};

/**
 * Redact anything token-shaped before a diagnostic reaches a log file. The
 * extension never concatenates `apiKey`/`headers` itself; this is the second
 * line of defence for provider error strings, which sometimes echo a request.
 */
export function redactCompactionDiagnostic(text: string): string {
  const redacted = text
    .replace(/bearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/(?:api[-_]?key|authorization)["'\s:=]+[^\s,;"']+/gi, "credential [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > DIAGNOSTIC_MAX_CHARS
    ? `${redacted.slice(0, DIAGNOSTIC_MAX_CHARS)}…`
    : redacted;
}

/** Classify a thrown compaction error into a code + secret-free hint. */
export function classifyCompactionFailure(
  error: unknown,
): { code: CompactionFailureCode; message?: string } {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  // A genuine user cancel is caught by the handler's signal check *before*
  // classification. Here only unmistakable abort shapes count (the SDK's
  // AbortError and its "Compaction cancelled"); a provider-side "cancelled"
  // response is an ordinary upstream failure and must downgrade.
  if (/abort|compaction cancelled/i.test(raw) || (error instanceof Error && error.name === "AbortError")) {
    return { code: "aborted" };
  }
  if (/rate[\s_-]?limit|429|too many requests|quota/i.test(raw)) {
    return { code: "rate-limited", message: redactCompactionDiagnostic(raw) };
  }
  if (/fetch failed|econn|enotfound|etimedout|socket|network|tls|dns/i.test(raw)) {
    return { code: "network", message: redactCompactionDiagnostic(raw) };
  }
  if (/token cap|stop reason.*length|length stop|incomplete/i.test(raw)) {
    return { code: "length-stop", message: redactCompactionDiagnostic(raw) };
  }
  return { code: "request-failed", message: raw ? redactCompactionDiagnostic(raw) : undefined };
}

function estimatedChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/**
 * Conservative chars/4 estimate of one message, mirroring the SDK's own
 * `estimateTokens` for the roles compaction sees. Tool results get the
 * serializer's truncation cap (2 000 chars); user text is never truncated, so
 * it is not capped here either.
 */
function estimateMessageTokens(message: unknown): number {
  if (!isRecord(message)) return 0;
  switch (message.role) {
    case "user":
    case "custom":
      return Math.ceil(estimatedChars(message.content) / 4);
    case "toolResult":
      return Math.ceil(Math.min(estimatedChars(message.content), TOOL_RESULT_MAX_CHARS) / 4);
    case "assistant": {
      let chars = 0;
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
          else if (block.type === "thinking" && typeof block.thinking === "string") {
            chars += block.thinking.length;
          } else if (block.type === "toolCall") {
            chars += String(block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "bashExecution":
      return Math.ceil(
        (String(message.command ?? "").length + String(message.output ?? "").length) / 4,
      );
    case "branchSummary":
    case "compactionSummary":
      return Math.ceil(String(message.summary ?? "").length / 4);
    case "system": {
      let chars = estimatedChars(message.content);
      if (isRecord(message.sections)) {
        for (const section of Object.values(message.sections)) {
          if (typeof section === "string") chars += section.length;
        }
      }
      if (message.toolsAdded !== undefined) chars += JSON.stringify(message.toolsAdded).length;
      return Math.ceil(chars / 4);
    }
    default:
      return 0;
  }
}

/** Conservative request estimate: per-message estimate plus prompt overhead. */
export function estimatePreparationTokens(preparation: CompactionPreparationLike): number {
  let tokens = SUMMARIZATION_OVERHEAD_TOKENS;
  for (const message of preparation.messagesToSummarize ?? []) {
    tokens += estimateMessageTokens(message);
  }
  for (const message of preparation.turnPrefixMessages ?? []) {
    tokens += estimateMessageTokens(message);
  }
  if (preparation.previousSummary) {
    tokens += Math.ceil(preparation.previousSummary.length / 4);
  }
  return tokens;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? [...strings] : undefined;
}

/**
 * Keep the SDK's file tracking exactly as `compact()` computed it, keep any
 * other extension metadata already stored in `details`, and add this
 * extension's selection block. If a (mocked or future) result omits the file
 * lists, rebuild them from `preparation.fileOps` — `modified = written ∪
 * edited`, `read` minus those — so an extension-provided compaction never
 * loses files the UI lists.
 */
export function buildCompactionDetails(
  resultDetails: unknown,
  preparation: CompactionPreparationLike,
  selection: CompactionModelSelectionDetails,
): CompactionModelSelectionDetails & { readFiles: string[]; modifiedFiles: string[] } {
  const details = isRecord(resultDetails) ? resultDetails : {};
  const ops = preparation.fileOps;
  let readFiles = stringList(details.readFiles);
  let modifiedFiles = stringList(details.modifiedFiles);
  if (!readFiles || !modifiedFiles) {
    const modified = new Set<string>([
      ...(ops ? ops.written : []),
      ...(ops ? ops.edited : []),
    ]);
    const readOnly = [...(ops ? ops.read : [])].filter((file) => !modified.has(file)).sort();
    readFiles ??= readOnly;
    modifiedFiles ??= [...modified].sort();
  }
  // Unknown SDK/other-extension fields survive; file lists are authoritative
  // from the SDK result (or rebuilt), and the selection block is appended.
  return {
    ...details,
    readFiles,
    modifiedFiles,
    ...selection,
  } as CompactionModelSelectionDetails & { readFiles: string[]; modifiedFiles: string[] };
}

function validateResult(result: CompactionResultLike): CompactionResultLike | undefined {
  if (!isRecord(result)) return undefined;
  if (typeof result.summary !== "string" || result.summary.trim().length === 0) return undefined;
  if (typeof result.firstKeptEntryId !== "string" || result.firstKeptEntryId.length === 0) {
    return undefined;
  }
  if (!isFiniteTokenCount(result.tokensBefore)) return undefined;
  return result;
}

/** Headers with `null` entries (removed credentials) dropped, as the SDK does. */
function usableHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * A user cancel. The SDK reports this as `aborted` and skips its native
 * compaction path, so no further request is issued on the aborted signal.
 */
const USER_CANCEL = { cancel: true } as const;

function createHandler(
  options: CompactionModelExtensionOptions,
  ctx: CompactionExtensionContextLike,
) {
  const compactFn = options.compactFn ?? defaultCompactFn;
  const readPolicy = options.readPolicy ?? readCompactionPolicy;
  const logger = options.logger ?? defaultLogger;
  const injectedRegistry = options.modelRegistry;

  const diagnose = (candidateRef: string, code: CompactionFailureCode, message?: string): void => {
    const suffix = message ? `: ${message}` : "";
    logger.warn(`[pi-web] compaction candidate ${candidateRef} failed (${code})${suffix}`);
  };

  return async (event: SessionBeforeCompactEventLike) => {
    const policy = readPolicy();
    const modelRegistry = injectedRegistry ?? ctx.modelRegistry;
    const candidates = selectCompactionModels<CompactionModelLike>({
      mainModel: ctx.model,
      availableModels: modelRegistry.getAvailable(),
      choice: policy.compactionModel,
      preferredModels: policy.preferredModels,
      requestTokens: estimatePreparationTokens(event.preparation),
      ...(options.isZeroPriceTrusted ? { isZeroPriceTrusted: options.isZeroPriceTrusted } : {}),
    });
    if (candidates.length === 0) return undefined;

    let fallbackCount = 0;
    for (const candidate of candidates) {
      // A user cancel must never be spent on another provider request.
      if (event.signal?.aborted) return USER_CANCEL;

      let auth: CompactionAuthResolution;
      try {
        auth = await modelRegistry.getApiKeyAndHeaders(candidate.model);
      } catch {
        diagnose(candidate.ref, "credential-error");
        fallbackCount += 1;
        continue;
      }
      if (!auth.ok) {
        // The registry's error string can carry provider internals; never log it.
        diagnose(candidate.ref, "no-credentials");
        fallbackCount += 1;
        continue;
      }

      const requestModel = auth.baseUrl
        ? { ...candidate.model, baseUrl: auth.baseUrl }
        : candidate.model;

      let result: CompactionResultLike;
      try {
        result = await compactFn(
          event.preparation,
          requestModel,
          auth.apiKey,
          usableHeaders(auth.headers),
          event.customInstructions,
          event.signal,
          undefined, // no main-session thinking level
          undefined, // no main-model stream function
          auth.env,
        );
      } catch (error) {
        if (event.signal?.aborted) return USER_CANCEL;
        const failure = classifyCompactionFailure(error);
        if (failure.code === "aborted") return USER_CANCEL;
        diagnose(candidate.ref, failure.code, failure.message);
        fallbackCount += 1;
        continue;
      }

      if (event.signal?.aborted) return USER_CANCEL;

      const validated = validateResult(result);
      if (!validated) {
        diagnose(candidate.ref, "empty-summary");
        fallbackCount += 1;
        continue;
      }

      return {
        compaction: {
          summary: validated.summary,
          firstKeptEntryId: validated.firstKeptEntryId,
          tokensBefore: validated.tokensBefore,
          ...(typeof validated.estimatedTokensAfter === "number"
            ? { estimatedTokensAfter: validated.estimatedTokensAfter }
            : {}),
          ...(validated.usage ? { usage: validated.usage } : {}),
          details: buildCompactionDetails(validated.details, event.preparation, {
            compactionModel: { provider: candidate.model.provider, modelId: candidate.model.id },
            fallbackCount,
            mode: policy.compactionModel,
          }),
        },
      };
    }

    // Nothing worked: the SDK's native path runs the current model. The
    // extension itself never re-requests a model it already tried.
    return undefined;
  };
}

/**
 * Build the `session_before_compact` extension. The factory reads the policy on
 * every compaction, so a settings change applies without a session restart.
 * Production wiring registers this once per session; the handler resolves
 * credentials from the session context's `modelRegistry`.
 */
export function createCompactionModelExtension(
  options: CompactionModelExtensionOptions = {},
): InlineExtension {
  return {
    name: COMPACTION_MODEL_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("session_before_compact", (event, ctx) => (
        createHandler(options, ctx as unknown as CompactionExtensionContextLike)(event)
      ));
    },
  };
}