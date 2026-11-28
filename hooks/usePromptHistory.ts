import { useEffect, useMemo, useRef, useState } from "react";
import { listPromptHistory, type PromptHistoryItem } from "@/lib/prompt-history-api";
import { mergeComposerHistory, type ComposerHistoryEntry } from "@/lib/composer-history";

/**
 * Cross-session prompt history for the composer (ISSUE-11).
 *
 * Fetches `/api/prompt-history` scoped by the current session/project and
 * merges it with the session's transcript-derived entries (from
 * `buildComposerHistory`) into the single newest-first list the composer's
 * ↑/↓ walks. The merge keeps the current session's entries (with images) ahead
 * of other sessions in the same project, deduplicating on trimmed text.
 *
 * The fetch is scoped: with no session and no project there is nothing to
 * recall, so it short-circuits to an empty list. `includeProjectHistory` is
 * false for member/subagent and chat-only sessions, which then recall only
 * their own session (matching cc-haha's session-isolated history).
 */
export function usePromptHistory(options: {
  sessionId?: string | null;
  projectPath?: string | null;
  projectRoot?: string | null;
  sessionEntries: ComposerHistoryEntry[];
  includeProjectHistory?: boolean;
  limit?: number;
}): ComposerHistoryEntry[] {
  const {
    sessionId,
    projectPath,
    projectRoot,
    sessionEntries,
    includeProjectHistory = true,
    limit,
  } = options;

  const contextKey = `${sessionId ?? ""}\0${projectPath ?? ""}\0${projectRoot ?? ""}\0${includeProjectHistory ? "1" : "0"}\0${limit ?? ""}`;
  const [serverEntries, setServerEntries] = useState<PromptHistoryItem[]>([]);
  const loadedKeyRef = useRef<string | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (loadedKeyRef.current === contextKey) return;
    if (inFlightKeyRef.current === contextKey) return;

    const hasScope = Boolean(sessionId || projectPath || projectRoot);
    if (!hasScope) {
      // Nothing to scope by: nothing to recall, cache the empty result.
      loadedKeyRef.current = contextKey;
      setServerEntries([]);
      return;
    }

    inFlightKeyRef.current = contextKey;
    let cancelled = false;
    listPromptHistory({
      project: projectPath ?? undefined,
      projectRoot: projectRoot ?? undefined,
      sessionId: sessionId ?? undefined,
      limit: limit ?? 100,
      sessionOnly: !includeProjectHistory,
    })
      .then((entries) => {
        if (cancelled) return;
        setServerEntries(entries);
        loadedKeyRef.current = contextKey;
      })
      .catch(() => {
        if (cancelled) return;
        setServerEntries([]);
        loadedKeyRef.current = contextKey;
      })
      .finally(() => {
        // Only clear the in-flight marker if no newer context has started.
        if (inFlightKeyRef.current === contextKey) inFlightKeyRef.current = null;
      });

    return () => {
      cancelled = true;
    };
  }, [contextKey, sessionId, projectPath, projectRoot, includeProjectHistory, limit]);

  return useMemo(
    () => mergeComposerHistory({
      sessionEntries,
      serverEntries,
      sessionId,
      includeProjectHistory,
      limit,
    }),
    [sessionEntries, serverEntries, sessionId, includeProjectHistory, limit],
  );
}
