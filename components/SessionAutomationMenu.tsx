"use client";

// Fork-owned: the composer's session (gear) menu — pi 0.86's session automation
// switches. ChatInput (upstream-owned) keeps the open state and ref (its
// outside-click handler closes every composer menu) and mounts this.
//
// Manual compaction and the auto-compaction switch live in the context-usage
// popover instead (`ContextUsageRing`): both answer "what happens to my
// context", and having a second Compact row here meant two entry points for one
// action, plus a threshold quoted in the popover that could not be changed
// where it was shown. The switch stays here too — it is a session-automation
// setting (`chat.autoCompaction` is fork-owned by this file, see
// `components/fork-extractions.test.mjs`), so both surfaces toggle one state.

import type { RefObject } from "react";
import type { SessionAutomation, SessionAutomationChange } from "@/hooks/useSessionAutomation";
import { useI18n } from "@/hooks/useI18n";

interface SessionAutomationMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: (update: (open: boolean) => boolean) => void;
  /** Anchor the popover to the left edge (mobile) instead of the right. */
  alignLeft: boolean;
  /** Known automation values; undefined while a new session has none yet. */
  automation?: SessionAutomation;
  onSetAutomation?: (change: SessionAutomationChange) => void;
  /** Retained for call-site compatibility; manual compaction now lives in the usage popover. */
  onCompact?: () => void;
}

export function SessionAutomationMenu({
  menuRef, open, onOpenChange, alignLeft, automation, onSetAutomation,
}: SessionAutomationMenuProps) {
  const { t } = useI18n();
  const hasAnyRow = Boolean(onSetAutomation && automation && (
    automation.autoCompactionEnabled !== null
    || automation.autoRetryEnabled !== null
    || automation.steeringMode !== null
    || automation.followUpMode !== null
  ));
  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        className="native-toolbar-button"
        onClick={() => onOpenChange((v) => !v)}
        title={t("chat.sessionAutomation")}
        aria-label={t("chat.sessionAutomation")}
        aria-expanded={open}
        disabled={!hasAnyRow}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          background: open ? "var(--bg-hover)" : "none",
          border: "none", borderRadius: "var(--radius-md)",
          color: "var(--text-muted)", cursor: hasAnyRow ? "pointer" : "default",
          opacity: hasAnyRow ? 1 : 0.45,
          transition: "background var(--dur-fast) var(--ease-native), color var(--dur-fast) var(--ease-native)",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {/* Not a gear: the sidebar gear opens app Settings, this opens per-session automation. */}
          <path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12L13 2Z" />
        </svg>
      </button>
      {open && hasAnyRow && (
        <div className="native-popover app-menu" style={{
          position: "absolute",
          bottom: "calc(100% + 6px)",
          ...(alignLeft ? { left: 0 } : { right: 0 }),
          zIndex: 100, background: "var(--bg)", border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-popover)",
          padding: "6px 0", minWidth: 230,
        }}>
          {onSetAutomation && automation && (<>
          {automation.autoCompactionEnabled !== null && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: "var(--fs-caption)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={automation.autoCompactionEnabled}
                onChange={(e) => onSetAutomation({ autoCompaction: e.target.checked })}
              />
              {t("chat.autoCompaction")}
            </label>
          )}
          {automation.autoRetryEnabled !== null && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: "var(--fs-caption)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={automation.autoRetryEnabled}
                onChange={(e) => onSetAutomation({ autoRetry: e.target.checked })}
              />
              {t("chat.autoRetry")}
            </label>
          )}
          {automation.steeringMode !== null && (
            <div style={{ padding: "6px 12px", borderTop: "var(--hairline) solid var(--border)", marginTop: 4, paddingTop: 10 }}>
              <div style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginBottom: 4 }}>{t("chat.steeringMode")}</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["all", "one-at-a-time"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onSetAutomation({ steeringMode: mode })}
                    style={{
                      flex: 1, height: 26, fontSize: "var(--fs-micro)",
                      border: "var(--hairline) solid var(--border)", borderRadius: "var(--radius-sm)",
                      background: automation.steeringMode === mode ? "var(--accent)" : "var(--bg)",
                      color: automation.steeringMode === mode ? "var(--accent-contrast)" : "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    {t(`chat.queueMode.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {automation.followUpMode !== null && (
            <div style={{ padding: "6px 12px 4px", marginBottom: 2 }}>
              <div style={{ fontSize: "var(--fs-micro)", color: "var(--text-dim)", marginBottom: 4 }}>{t("chat.followUpMode")}</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["all", "one-at-a-time"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onSetAutomation({ followUpMode: mode })}
                    style={{
                      flex: 1, height: 26, fontSize: "var(--fs-micro)",
                      border: "var(--hairline) solid var(--border)", borderRadius: "var(--radius-sm)",
                      background: automation.followUpMode === mode ? "var(--accent)" : "var(--bg)",
                      color: automation.followUpMode === mode ? "var(--accent-contrast)" : "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    {t(`chat.queueMode.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          </>)}
        </div>
      )}
    </div>
  );
}
