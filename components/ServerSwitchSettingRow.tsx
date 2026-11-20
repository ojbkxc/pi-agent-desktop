"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigSwitch } from "./SettingsUi";

/**
 * A Settings › General › Chat switch whose value lives on the server: GET
 * `endpoint` reads `{ enabled }`, PUT writes it. Optimistic, rolled back with
 * `failedHint` shown when the save fails.
 */
export function ServerSwitchSettingRow({
  endpoint,
  label,
  hint,
  failedHint,
  defaultEnabled,
  className,
}: {
  endpoint: string;
  label: string;
  hint: string;
  failedHint: string;
  /** Shown while loading, and what a response without a boolean means. */
  defaultEnabled: boolean;
  className?: string;
}) {
  const hintId = useId();
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const read = (data: { enabled?: unknown }) => (typeof data.enabled === "boolean" ? data.enabled : defaultEnabled);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { enabled?: unknown }) => {
        if (!cancelled) setEnabled(read(data));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const update = (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    setFailed(false);
    if (savedTimer.current) { clearTimeout(savedTimer.current); savedTimer.current = null; }
    setSaved(false);
    fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { enabled?: unknown }) => {
        setEnabled(read(data));
        setSaved(true);
        savedTimer.current = setTimeout(() => setSaved(false), 2000);
      })
      .catch(() => {
        setEnabled(previous);
        setFailed(true);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className={`settings-chat-option settings-chat-switch-option artifacts-setting-row${className ? ` ${className}` : ""}`}>
      <span className="artifacts-setting-text">
        <span>{label}</span>
        <span id={hintId} className="artifacts-setting-hint" role="status" aria-live="polite">
          {failed ? failedHint : saved ? t("settings.saved") : hint}
        </span>
      </span>
      <ConfigSwitch
        checked={enabled ?? defaultEnabled}
        loading={enabled === null || saving}
        label={label}
        describedBy={hintId}
        onChange={update}
      />
    </div>
  );
}
