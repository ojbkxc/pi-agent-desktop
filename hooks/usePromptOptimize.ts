"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  cancelOptimizePrompt,
  createRequestId,
  isOptimizablePrompt,
  optimizePrompt,
  PROMPT_OPTIMIZE_MAX_CHARS,
  type PromptOptimizeRestoreSnapshot,
} from "@/lib/prompt-optimize";

export type { PromptOptimizeRestoreSnapshot } from "@/lib/prompt-optimize";

export type UsePromptOptimizeOptions = {
  sessionId: string | null;
  disabled: boolean;
  getDraft: () => { text: string };
  applyDraft: (text: string) => void;
};

export type PromptOptimizeController = {
  isOptimizing: boolean;
  restoreSnapshot: PromptOptimizeRestoreSnapshot | null;
  notice: string | null;
  issue: string | null;
  optimize: () => Promise<void>;
  cancel: () => void;
  restore: () => void;
  dismissRestore: () => void;
  dismissNotice: () => void;
  dismissIssue: () => void;
  notifyDraftChanged: () => void;
};

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; code?: string; status?: number };
  return (
    candidate.name === "AbortError"
    || candidate.code === "ABORT_ERR"
    || candidate.code === "PROMPT_OPTIMIZE_CANCELLED"
    || candidate.status === 499
  );
}

export function usePromptOptimize({
  sessionId,
  disabled,
  getDraft,
  applyDraft,
}: UsePromptOptimizeOptions): PromptOptimizeController {
  const t = useI18n().t;
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [restoreSnapshot, setRestoreSnapshot] = useState<PromptOptimizeRestoreSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const activeRef = useRef<{
    requestId: string;
    sessionId: string;
    controller: AbortController;
    baselineText: string;
  } | null>(null);
  const applyingRef = useRef(false);
  const noticeIdRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const cancel = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    active.controller.abort();
    setIsOptimizing(false);
    void cancelOptimizePrompt(active.sessionId, active.requestId).catch(() => {});
  }, []);

  const dismissRestore = useCallback(() => {
    setRestoreSnapshot(null);
  }, []);

  const dismissNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const dismissIssue = useCallback(() => {
    setIssue(null);
  }, []);

  const notifyDraftChanged = useCallback(() => {
    if (applyingRef.current) return;
    if (activeRef.current) cancel();
    setRestoreSnapshot(null);
  }, [cancel]);

  // Switching sessions or unmounting aborts any in-flight optimization so a
  // late response can never overwrite another chat's composer draft.
  useEffect(() => {
    setRestoreSnapshot(null);
    setNotice(null);
    setIssue(null);
    return () => {
      cancel();
    };
  }, [sessionId, cancel]);

  const optimize = useCallback(async () => {
    const targetSessionId = sessionIdRef.current;
    if (!targetSessionId || disabled || activeRef.current) return;
    const draft = getDraft();
    if (!isOptimizablePrompt(draft.text)) return;
    if (draft.text.trim().length > PROMPT_OPTIMIZE_MAX_CHARS) {
      setIssue(t("chat.promptOptimize.tooLong"));
      return;
    }

    const requestId = createRequestId();
    const controller = new AbortController();
    const active = {
      requestId,
      sessionId: targetSessionId,
      controller,
      baselineText: draft.text,
    };
    activeRef.current = active;
    setRestoreSnapshot(null);
    setNotice(null);
    setIssue(null);
    setIsOptimizing(true);

    try {
      const response = await optimizePrompt(
        targetSessionId,
        { requestId, prompt: draft.text },
        controller.signal,
      );
      if (activeRef.current !== active || controller.signal.aborted) return;
      if (sessionIdRef.current !== targetSessionId) return;
      // Guard against any edit that slipped in without going through onChange.
      if (getDraft().text !== active.baselineText) return;

      const optimizedText = response.optimizedPrompt.trim();
      if (!optimizedText) return;

      if (optimizedText === active.baselineText.trim()) {
        setNotice(t("chat.promptOptimize.unchanged"));
        return;
      }

      applyingRef.current = true;
      try {
        applyDraft(optimizedText);
      } finally {
        applyingRef.current = false;
      }
      setRestoreSnapshot({
        id: ++noticeIdRef.current,
        text: active.baselineText,
      });
    } catch (error) {
      if (activeRef.current !== active || controller.signal.aborted || isAbortError(error)) {
        return;
      }
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : t("chat.promptOptimize.failed");
      setIssue(message);
    } finally {
      if (activeRef.current === active) {
        activeRef.current = null;
        setIsOptimizing(false);
      }
    }
  }, [applyDraft, disabled, getDraft, t]);

  const restore = useCallback(() => {
    if (!restoreSnapshot) return;
    const snapshot = restoreSnapshot;
    setRestoreSnapshot(null);
    applyingRef.current = true;
    try {
      applyDraft(snapshot.text);
    } finally {
      applyingRef.current = false;
    }
  }, [applyDraft, restoreSnapshot]);

  return {
    isOptimizing,
    restoreSnapshot,
    notice,
    issue,
    optimize,
    cancel,
    restore,
    dismissRestore,
    dismissNotice,
    dismissIssue,
    notifyDraftChanged,
  };
}
