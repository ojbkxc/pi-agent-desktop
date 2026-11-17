"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useModalDismiss } from "@/hooks/useModalDismiss";

/**
 * Shared confirmation for conversation deletion and access to the computer.
 * Escape closes only this dialog; submitting keeps its progress and errors visible.
 */
export function ChatConfirmDialog({
  title,
  subject,
  body,
  checkboxLabel,
  checkboxDefault = false,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** Full conversation name, separate from the action and its consequences. */
  subject?: string;
  body: string;
  /** An optional switch under the text; its value is handed to `onConfirm`. */
  checkboxLabel?: string;
  checkboxDefault?: boolean;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (checked: boolean) => void;
}) {
  const id = useId();
  const [checked, setChecked] = useState(checkboxDefault);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    busyRef.current = busy;
    onCancelRef.current = onCancel;
  }, [busy, onCancel]);
  // 共享模态基建（hooks/useModalDismiss）：Esc 只关最上层（capture + preventDefault，
  // 不会冒泡到 window 停掉运行中的 agent）、Tab 圈禁、初始焦点与关闭归还。
  const dialogRef = useModalDismiss<HTMLDivElement>(() => {
    if (!busyRef.current) onCancelRef.current();
  });
  useEffect(() => {
    // Disabling the focused submit button can otherwise drop focus behind the modal.
    if (busy) dialogRef.current?.focus({ preventScroll: true });
  }, [busy, dialogRef]);

  return (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${subject ? `${id}-subject ` : ""}${id}-body`}
        tabIndex={-1}
        className="project-trust-dialog chat-confirm-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id={`${id}-title`} className="project-trust-title">{title}</div>
            {subject && <div id={`${id}-subject`} className="chat-confirm-subject">{subject}</div>}
            <div id={`${id}-body`} className="project-trust-text">{body}</div>
            {checkboxLabel && (
              <label className="chat-confirm-check">
                <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={busy} />
                <span>{checkboxLabel}</span>
              </label>
            )}
          </div>
        </div>
        {error && <div role="alert" className="project-trust-error">{error}</div>}
        <div className="project-trust-footer">
          <button type="button" className="project-trust-button" onClick={onCancel} disabled={busy} data-autofocus>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`project-trust-button is-primary${danger ? " is-danger" : ""}`}
            onClick={() => onConfirm(checked)}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
