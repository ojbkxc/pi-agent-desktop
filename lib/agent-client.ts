// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { missingCwdFromBody } from "./missing-cwd";

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
    /** The session's folder, when the refusal is that it no longer exists (#1422). */
    public readonly missingCwd?: string,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

/**
 * Default deadline for agent commands. 30 s covers a cold server + a slow
 * model ack while still bounding a true hang — without this, a stuck POST
 * leaves the composer in a "running" state forever (see audit ISSUE-3).
 *
 * Callers may pass their own `signal` (AbortSignal) to cancel earlier; the
 * helper composes the two so the first of {timeout, signal} wins.
 */
export const DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 30_000;

export interface SendAgentCommandOptions {
  /** Hard deadline in ms; pass `Infinity` to opt out of the built-in timeout. */
  timeoutMs?: number;
  /** Caller-owned cancellation. Composed with the internal timeout. */
  signal?: AbortSignal;
}

function makeAbortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/**
 * One fetch, bounded by both a timeout and an optional caller AbortSignal.
 *
 * We do not reuse `fetchWithDeadline` here because that helper builds its own
 * AbortController and does not expose it, so a caller-provided signal could
 * not reach the in-flight fetch. This implementation owns the controller and
 * fires it from whichever source wins.
 *
 * POST bodies are JSON commands; the server is idempotent-unaware, so this
 * helper deliberately does **not** auto-retry — retries are a per-call-site
 * decision (handleAbort retries abort explicitly; mutations like fork do not).
 */
async function fetchAgentCommand(
  sessionId: string,
  command: Record<string, unknown>,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Response> {
  if (callerSignal?.aborted) throw makeAbortError();
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    return await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`Agent command timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * GET /api/agent/[id] without the system prompt, for status reads: the usage read after each
 * reply and on every stream connect, the settle and reconcile polls. None of them shows the
 * prompt, and it is nearly all of the reply (context files, skills, tool notes: hundreds of KB
 * in a large project), fetched again after every model call (#1302).
 */
export function agentStatusUrl(sessionId: string): string {
  return `/api/agent/${encodeURIComponent(sessionId)}?systemPrompt=0`;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options: SendAgentCommandOptions = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_AGENT_COMMAND_TIMEOUT_MS, signal } = options;
  const res = await fetchAgentCommand(sessionId, command, timeoutMs, signal);
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
      missingCwdFromBody(body) ?? undefined,
    );
  }
  return body.data as T;
}
