/**
 * fetch with a hard deadline, plus one automatic retry.
 *
 * A request that *hangs* is worse than one that fails: a failure rejects and
 * the caller can show an error, while a hang leaves a loading state on screen
 * forever. Hangs are realistic here rather than theoretical — HTTP/1.1 allows
 * only a handful of connections per origin and the app holds several
 * long-lived SSE streams, so a request can sit queued behind them with nothing
 * to react to.
 *
 * Anything driving a user-visible loading state should go through this instead
 * of a bare fetch.
 */

/** Generous enough for a cold packaged server; short enough to not feel stuck. */
export const DEFAULT_FETCH_TIMEOUT_MS = 6_000;

export async function fetchWithDeadline(
  url: string,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  init: RequestInit = {},
): Promise<Response> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  // Merge the caller's signal (e.g. a per-request cancellation controller)
  // with the internal deadline: the combined signal fires on whichever comes
  // first. AbortSignal.any is available in Node 20+ and modern browsers; fall
  // back to manual propagation otherwise.
  const callerSignal = init.signal ?? null;
  let signal: AbortSignal = timeoutController.signal;
  let removeCallerListener: (() => void) | null = null;
  if (callerSignal) {
    if (typeof AbortSignal.any === "function") {
      signal = AbortSignal.any([timeoutController.signal, callerSignal]);
    } else {
      const merged = new AbortController();
      const abort = () => merged.abort();
      if (callerSignal.aborted || timeoutController.signal.aborted) {
        abort();
      } else {
        callerSignal.addEventListener("abort", abort, { once: true });
        timeoutController.signal.addEventListener("abort", abort, { once: true });
        removeCallerListener = () => {
          callerSignal.removeEventListener("abort", abort);
          timeoutController.signal.removeEventListener("abort", abort);
        };
      }
      signal = merged.signal;
    }
  }
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    // A bare AbortError reads as if the app cancelled the request on purpose.
    if (timedOut) throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    removeCallerListener?.();
  }
}

/**
 * Retry gets a longer deadline than the first attempt: reaching it at all
 * means the server was busy, and the most likely reason is a cold start whose
 * work continues server-side after the client gives up — so the retry usually
 * lands on an already-warm server, but deserves room if it does not.
 */
export const DEFAULT_FETCH_RETRY_TIMEOUT_MS = 10_000;

/**
 * One deadline-bounded retry. `shouldRetry` lets the caller drop a retry that
 * has become pointless — the user switching away mid-request, say — so a
 * stale load cannot cost another full timeout.
 */
export async function fetchWithRetry(
  url: string,
  options: {
    timeoutMs?: number;
    retryTimeoutMs?: number;
    init?: RequestInit;
    shouldRetry?: () => boolean;
  } = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    retryTimeoutMs = DEFAULT_FETCH_RETRY_TIMEOUT_MS,
    init = {},
    shouldRetry,
  } = options;
  try {
    return await fetchWithDeadline(url, timeoutMs, init);
  } catch (error) {
    if (shouldRetry && !shouldRetry()) throw error;
    return fetchWithDeadline(url, retryTimeoutMs, init);
  }
}
