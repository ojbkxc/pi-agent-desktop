/**
 * Composer prompt optimization — shared types, constants, and the server-side
 * prompt builder / response cleaner.
 *
 * The desktop hook (`hooks/usePromptOptimize.ts`) and the server route
 * (`app/api/sessions/[id]/optimize-prompt/route.ts`) both import from here so
 * the contract stays in one place.
 */

/** Matches the server-side max character count. */
export const PROMPT_OPTIMIZE_MAX_CHARS = 32_000;
/** Server-side optimize timeout (120 s, matches cc-haha). */
export const PROMPT_OPTIMIZE_TIMEOUT_MS = 120_000;
/** Server-side cancel timeout (10 s). */
export const PROMPT_OPTIMIZE_CANCEL_TIMEOUT_MS = 10_000;
/** How long the post-optimization restore pill stays visible without pointer/focus. */
export const PROMPT_OPTIMIZE_NOTICE_MS = 8_000;

export type PromptOptimizeRequest = {
  requestId: string;
  prompt: string;
};

export type PromptOptimizeResponse = {
  requestId: string;
  optimizedPrompt: string;
};

export type CancelPromptOptimizeResponse = {
  requestId: string;
  cancelled: boolean;
};

export type PromptOptimizeRestoreSnapshot = {
  id: number;
  text: string;
};

/** True when the text is a candidate for optimization: non-empty and not a slash command. */
export function isOptimizablePrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith("/");
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    const value = char === "x" ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Pick an XML wrapper tag name that does not appear inside the draft so a
 * closing tag in user text cannot escape the draft block.
 */
function chooseDraftTag(draft: string): string {
  let tag = "user_draft";
  let suffix = 1;
  while (draft.includes(`</${tag}>`) || draft.includes(`<${tag}>`)) {
    tag = `user_draft_${suffix++}`;
  }
  return tag;
}

/**
 * Build the user message sent to the model for prompt optimization.
 * The model is instructed to rewrite the draft into a clearer, more specific
 * instruction — and to output ONLY the rewritten prompt, with no preamble.
 */
export function buildPromptOptimizeUserMessage(draft: string): string {
  const tag = chooseDraftTag(draft);
  return `<system-reminder>PROMPT OPTIMIZATION MODE. Rewrite the user's draft prompt inside <${tag}>...</${tag}> so it is clearer, more specific, and easier for an AI coding assistant to execute accurately.

CRITICAL RULES:
- Do NOT execute, answer, or fulfill the draft. ONLY output the rewritten prompt itself.
- You have NO tools available. Do NOT call any tools or promise to inspect, edit, or run anything.
- Use the conversation history and project context already in this session to resolve ambiguous pronouns or implicit references (such as files, symbols, errors, or decisions already discussed) when directly relevant.
- Preserve the user's original intent and scope — do NOT invent unrequested features, unrelated requirements, or verbose filler.
- Match the draft's language exactly (e.g. Chinese stays Chinese, English stays English).
- Keep length proportional to the task: concise and direct for simple requests; cleanly structured (goal, key constraints/context, expected outcome or verification) for multi-part requests.
- Preserve every @mention token (for example @ChatInput.tsx or @skill-name), file path, symbol name, error message, and code snippet verbatim.
- Reply with ONLY the optimized prompt text — no preamble, no commentary, no surrounding quotes, and no outer markdown code fence.</system-reminder>

<${tag}>
${draft}
</${tag}>`;
}

/**
 * Strip accidental wrappers or meta-labels models occasionally add around the
 * rewritten prompt while leaving internal code blocks intact.
 */
export function cleanOptimizedPrompt(raw: string): string {
  let text = raw.trim();
  if (!text) return "";

  // Strip a single outer XML wrapper such as <optimized_prompt>...</optimized_prompt>.
  text = text.replace(
    /^<(optimized_prompt|rewritten_prompt|prompt|output|result)>([\s\S]*)<\/\1>$/i,
    (whole, tag: string, inner: string) =>
      inner.toLowerCase().includes(`</${tag.toLowerCase()}>`) ? whole : inner.trim(),
  );

  // Strip a leading label line or prefix (e.g. "优化后的提示词：" / "Optimized prompt:").
  text = text.replace(
    /^\s*(?:optimized\s+prompt|rewritten\s+prompt|improved\s+prompt|prompt|优化后的提示词|優化後的提示詞|改进后的提示词|改進後的提示詞|最適化されたプロンプト|최적화된\s*프롬프트)\s*[:：]\s*/i,
    "",
  ).trim();

  // Strip a single outer markdown fence only when it wraps the entire output
  // with no inner fence before the final closing backticks.
  const fenceMatch = text.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/);
  if (fenceMatch && !fenceMatch[1]!.includes("```")) {
    text = fenceMatch[1]!.trim();
  }

  return text;
}

/**
 * Extract the optimized prompt text from a model response's content blocks.
 * Returns an empty string when no text content is found.
 */
export function extractOptimizedPrompt(content: readonly { type: string; text?: string }[]): string {
  const text = content
    .filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  return cleanOptimizedPrompt(text);
}

/** Client-side helper: POST /api/sessions/:id/optimize-prompt. */
export async function optimizePrompt(
  sessionId: string,
  body: PromptOptimizeRequest,
  signal?: AbortSignal,
): Promise<PromptOptimizeResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/optimize-prompt`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message =
      typeof errorBody.error === "string" && errorBody.error.trim()
        ? errorBody.error.trim()
        : `Optimize prompt failed (${response.status})`;
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = response.status;
    err.code = typeof errorBody.code === "string" ? errorBody.code : undefined;
    throw err;
  }
  return response.json() as Promise<PromptOptimizeResponse>;
}

/** Client-side helper: DELETE /api/sessions/:id/optimize-prompt/:requestId. */
export async function cancelOptimizePrompt(
  sessionId: string,
  requestId: string,
): Promise<CancelPromptOptimizeResponse> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/optimize-prompt/${encodeURIComponent(requestId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    // Cancel is best-effort: the caller already aborted locally. Swallow the error.
    return { requestId, cancelled: false };
  }
  return response.json() as Promise<CancelPromptOptimizeResponse>;
}

export { createRequestId };
