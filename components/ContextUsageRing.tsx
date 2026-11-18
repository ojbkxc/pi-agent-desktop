"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";

const RING_SIZE = 14;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** High-risk red threshold (fixed, Claude-convention). Single accent below it. */
const CTX_DANGER_PCT = 90;
/** Above this the panel's progress bar switches to the danger colour too. */
const BAR_DANGER_PCT = 90;

function fmtWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function fmtTokens(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

interface ContextUsageRingProps {
  contextUsage?: ContextUsage | null;
  sessionStats?: SessionStatsInfo | null;
  /** Open the existing top-bar session-stats panel (a row inside the popover). */
  onOpenStats?: () => void;
  /** Resolved compaction trigger; null/undefined when the session has not reported one yet. */
  compactionLimits?: { trigger: number | null; keepRecentTokens: number | null } | null;
  /** Manual compaction, offered in the popover while one can start. */
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
}

/**
 * Text-free usage ring next to the model selector, opening a square context
 * panel on click (C1 + the usage popover).
 *
 * The arc shows live context-window fullness in a single accent color and turns
 * red at the high-risk threshold (≥90%). The popover repeats the percentage,
 * shows the token counts, quotes the **trigger this session actually resolved**
 * (the compaction policy's, not a hard-coded share) and offers a manual
 * compaction. Hover keeps the plain title so a glance needs no click.
 *
 * When there is no context usage yet (no session, or nothing has run), the ring
 * renders dimmed and inert — no dead "Context usage" tooltip.
 */
export function ContextUsageRing({
  contextUsage,
  sessionStats,
  onOpenStats,
  compactionLimits,
  onCompact,
  onAbortCompaction,
  isCompacting = false,
}: ContextUsageRingProps) {
  const { t } = useI18n();
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const hasUsage = contextUsage != null;
  const percent = contextUsage?.percent ?? null;
  const windowSize = contextUsage?.contextWindow ?? 0;
  // A context window object always carries the denominator; percent may be
  // unknown (null) right after a compaction until the next LLM response.
  const showTooltip = hasUsage && (percent !== null || windowSize > 0);
  const pct = percent !== null ? Math.max(0, Math.min(100, percent)) : 0;
  const color = percent === null
    ? "var(--text-dim)"
    : pct >= CTX_DANGER_PCT
      ? "var(--danger)"
      : "var(--accent)";
  const filled = RING_CIRCUMFERENCE * (pct / 100);

  const tokens = contextUsage?.tokens ?? sessionStats?.tokens.total ?? null;
  const trigger = compactionLimits?.trigger ?? null;
  // The threshold only makes sense against the same window the usage is measured on.
  const triggerPercent = trigger !== null && windowSize > 0
    ? Math.round((trigger / windowSize) * 100)
    : null;

  const tooltipParts: string[] = [];
  if (showTooltip) {
    tooltipParts.push(percent !== null ? `${percent.toFixed(1)}% ctx` : `— / ${fmtWindow(windowSize)}`);
    if (sessionStats && sessionStats.tokens.total > 0) {
      tooltipParts.push(`${fmtWindow(sessionStats.tokens.total)} tok`);
    } else if (percent !== null && windowSize > 0) {
      tooltipParts[0] += ` / ${fmtWindow(windowSize)}`;
    }
    if (sessionStats && sessionStats.cost > 0) {
      tooltipParts.push(`$${sessionStats.cost.toFixed(3)}`);
    }
  }
  const title = tooltipParts.length > 0 ? tooltipParts.join(" · ") : t("chat.ctxUsage");

  // Close on outside click and Esc, like every other composer popover. The
  // panel is not modal: it holds no destructive action and must not trap focus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Claim the Escape: the global shortcut would otherwise stop a running agent.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Nothing to report yet (new or dormant session): an empty grey ring read
  // as a loading spinner, so leave the slot empty until usage arrives.
  if (!hasUsage) return null;

  // cc-haha's compact form: a short ring **with the percentage beside it**.
  // A bare arc reads as a spinner that never finishes (it is static by design),
  // so the number is what tells the user this is a gauge, not a loading state.
  const percentLabel = percent !== null
    ? `${pct.toFixed(pct >= 10 || Number.isInteger(pct) ? 0 : 1)}%`
    : null;
  const canCompactNow = Boolean(onCompact && !isCompacting);

  return (
    <div ref={rootRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={title}
        title={showTooltip ? title : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-disabled={!hasUsage}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
          width: percentLabel ? undefined : 32,
          minWidth: 32,
          height: 32,
          padding: percentLabel ? "0 6px" : 0,
          flexShrink: 0,
          background: open ? "var(--bg-hover)" : "none", border: "none", borderRadius: "var(--radius-md)",
          cursor: hasUsage ? "pointer" : "default",
          transition: "background var(--dur-fast) var(--ease-native), opacity var(--dur-fast) var(--ease-native)",
          opacity: hasUsage ? 1 : 0.5,
        }}
        onMouseEnter={(e) => {
          if (!hasUsage || open) return;
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (open) return;
          e.currentTarget.style.background = "none";
        }}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
          <circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" stroke="var(--border)" strokeWidth={RING_STROKE} />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={RING_STROKE}
            strokeDasharray={`${filled} ${RING_CIRCUMFERENCE - filled}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            opacity={percent === null ? 0.35 : 1}
          />
        </svg>
        {percentLabel && (
          <span
            aria-hidden="true"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
              fontVariantNumeric: "tabular-nums",
              color: pct >= CTX_DANGER_PCT ? "var(--danger)" : "var(--text-muted)",
              lineHeight: 1,
            }}
          >
            {percentLabel}
          </span>
        )}
      </button>

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={t("chat.ctxUsageTitle")}
          className="native-popover app-menu ctx-usage-popover"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            // The ring sits near the left of the composer row, so anchoring the
            // panel's left edge keeps it on screen at narrow widths instead of
            // pushing it past the viewport's left edge.
            left: 0,
            zIndex: "var(--z-dropdown)",
          }}
        >
          <div className="ctx-usage-head">
            <span className="ctx-usage-title">{t("chat.ctxUsageTitle")}</span>
            <span
              className="ctx-usage-pct"
              data-danger={percent !== null && pct >= CTX_DANGER_PCT ? "true" : undefined}
            >
              {percent !== null ? `${percent.toFixed(percent >= 10 || Number.isInteger(percent) ? 0 : 1)}%` : "—"}
            </span>
          </div>
          <div className="ctx-usage-bar" aria-hidden="true">
            <span
              className="ctx-usage-bar-fill"
              style={{ width: `${pct}%`, background: pct >= BAR_DANGER_PCT ? "var(--danger)" : "var(--accent)" }}
            />
            {triggerPercent !== null && (
              <span className="ctx-usage-bar-mark" style={{ left: `${Math.min(100, triggerPercent)}%` }} />
            )}
          </div>
          <div className="ctx-usage-tokens">
            {tokens !== null && windowSize > 0
              ? `${fmtTokens(tokens)} / ${fmtTokens(windowSize)} tokens`
              : windowSize > 0
                ? `— / ${fmtTokens(windowSize)} tokens`
                : t("chat.ctxUsageUnknown")}
          </div>
          <div className="ctx-usage-trigger">
            {triggerPercent !== null && trigger !== null
              ? t("chat.ctxAutoCompactAt", { percent: triggerPercent, tokens: fmtTokens(trigger) })
              : t("chat.ctxTriggerUnknown")}
          </div>
          {compactionLimits?.keepRecentTokens ? (
            <div className="ctx-usage-kept">
              {t("chat.ctxKeepRecent", { tokens: fmtTokens(compactionLimits.keepRecentTokens) })}
            </div>
          ) : null}
          <div className="ctx-usage-actions">
            {onCompact ? (
              <button
                type="button"
                className="ctx-usage-action"
                disabled={!canCompactNow}
                onClick={() => {
                  setOpen(false);
                  onCompact();
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 9V5a1 1 0 0 1 1-1h4M20 15v4a1 1 0 0 1-1 1h-4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4" />
                </svg>
                {t("chat.ctxCompactNow")}
              </button>
            ) : null}
            {onCompact && isCompacting && onAbortCompaction ? (
              <button
                type="button"
                className="ctx-usage-action"
                onClick={() => {
                  setOpen(false);
                  onAbortCompaction();
                }}
              >
                {t("chat.stopCompaction")}
              </button>
            ) : null}
            {onOpenStats ? (
              <button
                type="button"
                className="ctx-usage-action ctx-usage-action-secondary"
                onClick={() => {
                  setOpen(false);
                  onOpenStats();
                }}
              >
                {t("chat.ctxOpenStats")}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}