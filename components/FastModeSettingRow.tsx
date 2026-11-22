"use client";

import { useId } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useServerSetting } from "@/hooks/useServerSetting";
import { FAST_MODE_PRESET_IDS } from "@/lib/fast-mode/presets";
import { fastModePresetLabelKey, readFastModePresetPayload } from "./fast-mode-row-helpers";
import { field, shown } from "./server-setting-machine";

type Preset = (typeof FAST_MODE_PRESET_IDS)[number];

/**
 * Settings › General › Chat: the fast-mode preset. Three choices rather than a
 * switch, because `conservative` is a real state (brevity only) and mapping it
 * onto "off" would silently drop the one rule a conservative user kept.
 *
 * GET reads `{ preset }`, PUT writes `{ preset }`; the row is optimistic and
 * rolls back with `failedHint`, on the same shared server round trip as
 * `ServerSwitchSettingRow`.
 */
export function FastModeSettingRow() {
  const hintId = useId();
  const { t } = useI18n();
  const { value, saving, failed, saved, update } = useServerSetting<Preset>({
    endpoint: "/api/fast-mode",
    body: (preset) => ({ preset }),
    read: (payload) => {
      // A payload without a `preset` field is unreadable here; the helper's `off`
      // default applies only to values that are present but wrong.
      if (field(payload, "preset") === undefined) return undefined;
      return readFastModePresetPayload(payload);
    },
    fallback: "off",
  });

  const label = t("settings.fastMode");
  // An unanswered or failed first read shows the default ("off") and stays usable;
  // only an in-flight save disables the buttons.
  const selected = shown(value, "off");
  return (
    <div className="settings-chat-option settings-chat-choice-option">
      <span className="artifacts-setting-text">
        <span>{label}</span>
        <span id={hintId} className="artifacts-setting-hint" role="status" aria-live="polite">
          {failed ? t("settings.fastModeFailed") : saved ? t("settings.saved") : t("settings.fastModeHint")}
        </span>
      </span>
      <div className="settings-choice-group" role="radiogroup" aria-label={label} aria-describedby={hintId}>
        {FAST_MODE_PRESET_IDS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected === option}
            className="settings-choice-option"
            disabled={saving}
            onClick={() => update(option)}
          >
            {t(fastModePresetLabelKey(option))}
          </button>
        ))}
      </div>
    </div>
  );
}
