"use client";

import { useId } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useServerSetting } from "@/hooks/useServerSetting";
import { field, shown } from "./server-setting-machine";
import { ConfigSwitch } from "./SettingsUi";

/**
 * A Settings › General › Chat switch whose value lives on the server: GET
 * `endpoint` reads `{ enabled }`, PUT writes it. Optimistic, rolled back with
 * `failedHint` shown when the save fails. The race rules live in
 * `hooks/useServerSetting.ts`, shared with the preset row.
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
  const { value, saving, failed, saved, update } = useServerSetting<boolean>({
    endpoint,
    body: (enabled) => ({ enabled }),
    read: (payload) => {
      const enabled = field(payload, "enabled");
      return typeof enabled === "boolean" ? enabled : undefined;
    },
    fallback: defaultEnabled,
  });
  const enabled = shown(value, defaultEnabled);
  // Only a save disables the switch: a GET that failed leaves the row on its default
  // and still usable, with `failed` said in the hint line.
  const loading = saving;

  return (
    <div className={`settings-chat-option settings-chat-switch-option artifacts-setting-row${className ? ` ${className}` : ""}`}>
      <span className="artifacts-setting-text">
        <span>{label}</span>
        <span id={hintId} className="artifacts-setting-hint" role="status" aria-live="polite">
          {failed ? failedHint : saved ? t("settings.saved") : hint}
        </span>
      </span>
      <ConfigSwitch
        checked={enabled}
        loading={loading}
        label={label}
        describedBy={hintId}
        onChange={update}
      />
    </div>
  );
}
