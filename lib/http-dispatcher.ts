import { EventEmitter } from "node:events";
import * as undici from "undici";

/**
 * How long a response body may stay silent before undici aborts it.
 *
 * This is an *idle* timer: undici refreshes it on every chunk, so a stream that
 * keeps sending keeps living regardless of total duration. It is set well above
 * a model's thinking time on purpose — a relay that buffers a stream, or a
 * reasoning model that emits nothing for minutes, would otherwise be cut off
 * mid-response and seen upstream as "client disconnected before the response
 * completed". Override with PI_WEB_HTTP_IDLE_TIMEOUT_MS (ms, or "disabled").
 */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 30 * 60_000;

type DispatcherGlobal = typeof globalThis & {
  __piWebHttpDispatcherConfigured?: boolean;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const originalGlobalFetch = globalThis.fetch;
const ignoreUndiciDispatcherError = (): void => {};

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

/**
 * The idle timeout to configure: `PI_WEB_HTTP_IDLE_TIMEOUT_MS` as a number of
 * milliseconds, or `disabled`/`0` to leave body stalls entirely to the caller's
 * own AbortSignal. An unset, blank or unusable value falls back to the default.
 */
export function resolveHttpIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_HTTP_IDLE_TIMEOUT_MS,
): number {
  if (rawValue === undefined || rawValue.trim() === "") return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  const parsed = parseHttpIdleTimeoutMs(rawValue);
  if (parsed === undefined) {
    console.warn(
      `[pi-web] invalid PI_WEB_HTTP_IDLE_TIMEOUT_MS "${rawValue}", falling back to ${DEFAULT_HTTP_IDLE_TIMEOUT_MS} ms`,
    );
    return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  }
  return parsed;
}

export function configureHttpDispatcher(
  timeoutMs: number | string = resolveHttpIdleTimeoutMs(),
): void {
  if (dispatcherGlobal.__piWebHttpDispatcherConfigured) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: normalizedTimeoutMs,
      headersTimeout: normalizedTimeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  undici.setGlobalDispatcher(dispatcher);

  // Keep fetch and the dispatcher on the same undici implementation. Preserve
  // an intentional fetch override installed after this module was loaded.
  if (globalThis.fetch === originalGlobalFetch) {
    undici.install?.();
  }

  dispatcherGlobal.__piWebHttpDispatcherConfigured = true;
}
