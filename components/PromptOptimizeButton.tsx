"use client";

import { useEffect, useState, type FocusEvent, type MouseEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { PROMPT_OPTIMIZE_NOTICE_MS } from "@/lib/prompt-optimize";
import type { PromptOptimizeController } from "@/hooks/usePromptOptimize";

const keepCaret = (event: MouseEvent) => event.preventDefault();

type PromptOptimizeButtonProps = {
  controller: PromptOptimizeController;
  canOptimize: boolean;
};

/**
 * Wand button that triggers prompt optimization on the composer draft.
 * Shows a spinner while optimizing, and an 8 s restore pill after a successful
 * rewrite so the user can undo the change. Hovering or focusing the pill pauses
 * the dismiss timer.
 */
export function PromptOptimizeButton({ controller, canOptimize }: PromptOptimizeButtonProps) {
  const { t } = useI18n();
  const { isOptimizing, restoreSnapshot, notice, issue, optimize, cancel, restore, dismissRestore, dismissNotice, dismissIssue } = controller;
  const [attended, setAttended] = useState(false);
  const snapshotId = restoreSnapshot?.id;

  useEffect(() => {
    setAttended(false);
  }, [snapshotId]);

  useEffect(() => {
    if (snapshotId === undefined || attended) return;
    const timer = setTimeout(dismissRestore, PROMPT_OPTIMIZE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [attended, dismissRestore, snapshotId]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setAttended(false);
    }
  };

  const buttonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "var(--control-h-lg)",
    height: "var(--control-h-lg)",
    padding: 0,
    border: "none",
    borderRadius: "var(--radius-md)",
    cursor: isOptimizing ? "default" : canOptimize ? "pointer" : "not-allowed",
    background: "none",
    color: "var(--text-muted)",
    opacity: isOptimizing ? 1 : canOptimize ? 0.75 : 0.4,
    flexShrink: 0,
    transition: "opacity 120ms ease",
  };

  return (
    <div data-testid="prompt-optimize" className="relative flex shrink-0 items-center">
      {isOptimizing ? (
        <button
          type="button"
          aria-busy="true"
          aria-label={t("chat.promptOptimize.cancel")}
          title={t("chat.promptOptimize.cancel")}
          data-testid="prompt-optimize-button"
          onMouseDown={keepCaret}
          onClick={cancel}
          style={{ ...buttonStyle, opacity: 1, color: "var(--accent)" }}
        >
          <span className="prompt-optimize-spinner" style={{
            display: "inline-block",
            width: 16,
            height: 16,
            border: "2px solid color-mix(in srgb, var(--accent) 25%, transparent)",
            borderTopColor: "var(--accent)",
            borderRadius: "50%",
            animation: "spin 0.6s linear infinite",
          }} />
        </button>
      ) : (
        <button
          type="button"
          aria-label={t("chat.promptOptimize.action")}
          title={t("chat.promptOptimize.action")}
          data-testid="prompt-optimize-button"
          onMouseDown={keepCaret}
          onClick={() => { void optimize(); }}
          disabled={!canOptimize}
          style={buttonStyle}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 4V2M15 10V8M11.5 6.5h-3M19.5 6.5h-3M12.5 3.5 10.5 5.5M15.5 3.5l2 2M12 6.5 13.5 3M10.5 13.5 7.5 18a2.12 2.12 0 0 0 3 3l4.5-4.5" />
            <path d="M9 11 4.5 15.5a2.12 2.12 0 0 0 3 3L12 14" />
          </svg>
        </button>
      )}

      {restoreSnapshot && !isOptimizing ? (
        <div
          role="status"
          data-testid="prompt-optimize-notice"
          onPointerEnter={() => setAttended(true)}
          onPointerLeave={() => setAttended(false)}
          onFocus={() => setAttended(true)}
          onBlur={handleBlur}
          style={{
            position: "absolute",
            bottom: "100%",
            right: 0,
            zIndex: 60,
            marginBottom: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minHeight: 30,
            maxWidth: "min(22rem, calc(100vw - 2rem))",
            padding: "4px 8px 4px 12px",
            borderRadius: "var(--radius-xl)",
            fontSize: "var(--fs-caption)",
            color: "var(--text-muted)",
            background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
            border: "var(--hairline) solid color-mix(in srgb, var(--border) 72%, transparent)",
            boxShadow: "var(--shadow-popover)",
            backdropFilter: "blur(10px)",
            pointerEvents: "auto",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--success)" }}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span style={{ minWidth: 0, flex: 1 }}>{t("chat.promptOptimize.done")}</span>
          <button
            type="button"
            onMouseDown={keepCaret}
            onClick={restore}
            style={{
              flexShrink: 0,
              padding: "2px 8px",
              border: "none",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: "var(--fs-micro)",
              lineHeight: 1.4,
              whiteSpace: "nowrap",
            }}
          >
            {t("chat.promptOptimize.restore")}
          </button>
        </div>
      ) : null}

      {notice && !isOptimizing && !restoreSnapshot ? (
        <div
          role="status"
          data-testid="prompt-optimize-notice"
          onPointerEnter={() => setAttended(true)}
          onPointerLeave={() => setAttended(false)}
          onFocus={() => setAttended(true)}
          onBlur={handleBlur}
          style={{
            position: "absolute",
            bottom: "100%",
            right: 0,
            zIndex: 60,
            marginBottom: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minHeight: 30,
            maxWidth: "min(22rem, calc(100vw - 2rem))",
            padding: "4px 12px",
            borderRadius: "var(--radius-xl)",
            fontSize: "var(--fs-caption)",
            color: "var(--text-muted)",
            background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
            border: "var(--hairline) solid color-mix(in srgb, var(--border) 72%, transparent)",
            boxShadow: "var(--shadow-popover)",
            backdropFilter: "blur(10px)",
            pointerEvents: "auto",
          }}
        >
          <span style={{ minWidth: 0, flex: 1 }}>{notice}</span>
          <button
            type="button"
            onMouseDown={keepCaret}
            onClick={dismissNotice}
            style={{
              flexShrink: 0,
              padding: 0,
              border: "none",
              background: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: "var(--fs-body)",
              opacity: 0.6,
              lineHeight: 1,
            }}
            aria-label={t("chat.dismiss")}
          >
            ×
          </button>
        </div>
      ) : null}

      {issue && !isOptimizing && !restoreSnapshot ? (
        <div
          role="alert"
          data-testid="prompt-optimize-issue"
          onPointerEnter={() => setAttended(true)}
          onPointerLeave={() => setAttended(false)}
          onFocus={() => setAttended(true)}
          onBlur={handleBlur}
          style={{
            position: "absolute",
            bottom: "100%",
            right: 0,
            zIndex: 60,
            marginBottom: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minHeight: 30,
            maxWidth: "min(22rem, calc(100vw - 2rem))",
            padding: "4px 12px",
            borderRadius: "var(--radius-xl)",
            fontSize: "var(--fs-caption)",
            color: "var(--danger)",
            background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
            border: "var(--hairline) solid color-mix(in srgb, var(--danger) 30%, transparent)",
            boxShadow: "var(--shadow-popover)",
            backdropFilter: "blur(10px)",
            pointerEvents: "auto",
          }}
        >
          <span style={{ minWidth: 0, flex: 1 }}>{issue}</span>
          <button
            type="button"
            onMouseDown={keepCaret}
            onClick={dismissIssue}
            style={{
              flexShrink: 0,
              padding: 0,
              border: "none",
              background: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: "var(--fs-body)",
              opacity: 0.6,
              lineHeight: 1,
            }}
            aria-label={t("chat.dismiss")}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
