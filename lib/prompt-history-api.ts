/**
 * Client for the cross-session prompt history API (ISSUE-11).
 *
 * Thin fetch wrapper over `/api/prompt-history`, mirroring cc-haha's
 * `promptHistoryApi`. The list call never throws on a bad response — it returns
 * an empty list so the composer's local history keeps working on transient
 * errors (matching cc-haha's `ensureServerHistoryLoaded` catch-and-return-[]).
 */

export type PromptHistoryItem = {
  display: string;
  timestamp: number;
  sessionId?: string;
};

export type PromptHistoryListParams = {
  project?: string;
  projectRoot?: string;
  sessionId?: string;
  limit?: number;
  sessionOnly?: boolean;
};

export async function listPromptHistory(
  params: PromptHistoryListParams,
): Promise<PromptHistoryItem[]> {
  const query = new URLSearchParams();
  if (params.project) query.set("project", params.project);
  if (params.projectRoot) query.set("projectRoot", params.projectRoot);
  if (params.sessionId) query.set("sessionId", params.sessionId);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.sessionOnly) query.set("sessionOnly", "1");
  const suffix = query.toString();
  try {
    const response = await fetch(`/api/prompt-history${suffix ? `?${suffix}` : ""}`);
    if (!response.ok) return [];
    const data = await response.json().catch(() => null);
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

export async function appendPromptHistory(input: {
  display: string;
  project?: string;
  sessionId?: string;
}): Promise<boolean> {
  try {
    const response = await fetch("/api/prompt-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return response.ok;
  } catch {
    return false;
  }
}
