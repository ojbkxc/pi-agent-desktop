/**
 * Server-side prompt optimization: in-flight request tracking and the
 * single-turn LLM call.
 *
 * The POST route (`app/api/sessions/[id]/optimize-prompt/route.ts`) and the
 * DELETE route (`app/api/sessions/[id]/optimize-prompt/[requestId]/route.ts`)
 * share the in-flight Map through this module.
 */

import { join } from "path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  buildPromptOptimizeUserMessage,
  cleanOptimizedPrompt,
  PROMPT_OPTIMIZE_MAX_CHARS,
  type PromptOptimizeRequest,
} from "@/lib/prompt-optimize";
import {
  getLatestModelChange,
  openSessionManager,
  resolveSessionPath,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import type { SessionEntry } from "@/lib/types";

/** 120 s optimize timeout, matching the client. */
const OPTIMIZE_TIMEOUT_MS = 120_000;
/** 10 s cancel timeout. */
const CANCEL_TIMEOUT_MS = 10_000;

type PendingEntry = {
  requestId: string;
  sessionId: string;
  controller: AbortController;
  started: boolean;
  cancelPromise: Promise<void> | undefined;
};

/**
 * Module-level Map of in-flight optimization requests, keyed by session id.
 * Only one optimization per session at a time (the client also guards this,
 * but the server is the real authority).
 */
const pendingBySession = new Map<string, PendingEntry>();

/** Tombstones of recently cancelled request IDs so a late POST cannot restart. */
const seenRequestIds = new Map<string, Set<string>>();

function rememberRequestId(sessionId: string, requestId: string): void {
  const seen = seenRequestIds.get(sessionId) ?? new Set<string>();
  seen.add(requestId);
  if (seen.size > 1000) seen.delete(seen.values().next().value!);
  seenRequestIds.set(sessionId, seen);
}

export function hasPendingOptimize(sessionId: string): boolean {
  return pendingBySession.has(sessionId);
}

/**
 * Cancel an in-flight optimization. Returns true if a matching request was
 * found and cancelled, false if no request matched (already finished or
 * never started).
 */
export async function cancelOptimize(
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  const entry = pendingBySession.get(sessionId);
  if (!entry || entry.requestId !== requestId) {
    if (requestId) rememberRequestId(sessionId, requestId);
    return false;
  }
  await abortEntry(sessionId, entry);
  return true;
}

function abortEntry(_sessionId: string, entry: PendingEntry): Promise<void> {
  if (entry.cancelPromise) return entry.cancelPromise;
  entry.controller.abort();
  entry.cancelPromise = Promise.resolve();
  return entry.cancelPromise;
}

/**
 * Run the prompt optimization: call the session's model with a single-turn
 * completion request and return the cleaned optimized prompt.
 */
export async function runOptimizePrompt(
  sessionId: string,
  input: PromptOptimizeRequest,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) {
    throw new Error("Prompt optimization cancelled");
  }
  if (pendingBySession.has(sessionId)) {
    throw new Error("Prompt optimization is already running in this session");
  }
  const seen = seenRequestIds.get(sessionId) ?? new Set<string>();
  if (seen.has(input.requestId)) {
    throw new Error("This prompt optimization request ID has already been used");
  }
  rememberRequestId(sessionId, input.requestId);

  const entry: PendingEntry = {
    requestId: input.requestId,
    sessionId,
    controller: new AbortController(),
    started: false,
    cancelPromise: undefined,
  };
  pendingBySession.set(sessionId, entry);

  let timedOut = false;
  const cancel = () => {
    void abortEntry(sessionId, entry);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, OPTIMIZE_TIMEOUT_MS);

  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error("Prompt optimization aborted"));
    entry.controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });

  try {
    if (signal.aborted) cancel();
    const { model, modelRuntime } = await resolveSessionModel(sessionId);
    if (!model) {
      throw new Error("No model available for prompt optimization");
    }
    if (!modelRuntime.hasConfiguredAuth(model.provider)) {
      throw new Error("No authentication configured for the session's model");
    }

    entry.started = true;
    const userMessage = buildPromptOptimizeUserMessage(input.prompt);
    const response = await Promise.race([
      modelRuntime.completeSimple(
        model,
        {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: userMessage }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          cacheRetention: "none",
          sessionId: input.requestId,
          signal: entry.controller.signal,
        },
      ),
      aborted,
    ]);

    if (entry.controller.signal.aborted) {
      throw new Error("Prompt optimization aborted");
    }

    const optimizedText = cleanOptimizedPrompt(
      (response.content as readonly { type: string; text?: string }[])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("\n"),
    );
    if (!optimizedText) {
      throw new Error("Model returned an invalid optimized prompt");
    }
    return optimizedText;
  } catch (error) {
    if (entry.controller.signal.aborted) {
      throw new Error(
        timedOut ? "Prompt optimization timed out" : "Prompt optimization cancelled",
      );
    }
    if (error instanceof Error) throw error;
    throw new Error("Prompt optimization failed");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (rejectAbort) {
      entry.controller.signal.removeEventListener("abort", rejectAbort);
    }
    await entry.cancelPromise;
    if (pendingBySession.get(sessionId) === entry) {
      pendingBySession.delete(sessionId);
    }
  }
}

/**
 * Resolve the session's current model and a ModelRuntime capable of calling it.
 * Uses the live RPC session's modelRuntime when available; otherwise creates a
 * lightweight standalone ModelRuntime from the agent directory.
 */
async function resolveSessionModel(
  sessionId: string,
): Promise<{ model: Model<Api> | undefined; modelRuntime: ModelRuntime }> {
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) {
    const modelRuntime = live.inner.modelRuntime as unknown as ModelRuntime;
    const modelRef = live.inner.model;
    const model = modelRef
      ? modelRuntime.getModel(modelRef.provider, modelRef.id)
      : undefined;
    return { model, modelRuntime };
  }

  // Not live: read the session file for the last model_change, then create a
  // standalone ModelRuntime from the agent directory.
  const filePath = await resolveSessionPath(sessionId);
  let modelRef: { provider: string; modelId: string } | undefined;
  if (filePath) {
    try {
      const sm = openSessionManager(filePath);
      const entries = sm.getEntries() as unknown as SessionEntry[];
      const latest = getLatestModelChange(entries);
      modelRef = latest ?? undefined;
    } catch {
      // fall through to undefined
    }
  }

  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const model = modelRef
    ? modelRuntime.getModel(modelRef.provider, modelRef.modelId)
    : undefined;
  return { model: model ?? undefined, modelRuntime };
}

/** Reset internal state for tests. */
export function resetPromptOptimizeStateForTests(): void {
  pendingBySession.clear();
  seenRequestIds.clear();
}

// Re-export the constants the route needs.
export { PROMPT_OPTIMIZE_MAX_CHARS, CANCEL_TIMEOUT_MS, OPTIMIZE_TIMEOUT_MS };
