import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";

/**
 * Unattended ("autopilot") mode: let the app keep working without a human in
 * the loop. Everything it gates is opt-in and scoped — manual sessions keep
 * their normal review flow.
 *
 * The settings live in the shared Pi Web settings file (`<agent dir>/pi-web/
 * settings.json`) next to the other toggles, so the desktop and any other
 * reader see one source of truth.
 */
export interface AutopilotSettings {
  /** Master switch. On by default per the user's request. */
  enabled: boolean;
  /** Auto-approve a team plan the autopilot itself started. Manual sessions still review. */
  autoApproveTeamPlans: boolean;
  /** Turn a failed scheduled run into an autofix task when the folder has a verify command. */
  autoFixFailedRuns: boolean;
  /** Round cap for those automatic fixes. */
  maxAutoFixRounds: number;
}

export const AUTOPILOT_DEFAULTS: AutopilotSettings = {
  enabled: true,
  autoApproveTeamPlans: true,
  autoFixFailedRuns: true,
  maxAutoFixRounds: 12,
};

export const MAX_AUTOPILOT_FIX_ROUNDS = 50;

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readAutopilotSettings(settingsPath = getPiWebSettingsPath()): AutopilotSettings {
  const settings = { ...AUTOPILOT_DEFAULTS };
  let stored: Record<string, unknown>;
  try {
    stored = readStored(settingsPath);
  } catch {
    // An unreadable settings file keeps the default (on), so unattended work
    // does not silently stop because the file is mid-write.
    return settings;
  }
  const raw = stored.autopilot;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return settings;
  const value = raw as Record<string, unknown>;
  settings.enabled = readBool(value.enabled, settings.enabled);
  settings.autoApproveTeamPlans = readBool(value.autoApproveTeamPlans, settings.autoApproveTeamPlans);
  settings.autoFixFailedRuns = readBool(value.autoFixFailedRuns, settings.autoFixFailedRuns);
  if (
    typeof value.maxAutoFixRounds === "number" &&
    Number.isInteger(value.maxAutoFixRounds) &&
    value.maxAutoFixRounds >= 1 &&
    value.maxAutoFixRounds <= MAX_AUTOPILOT_FIX_ROUNDS
  ) {
    settings.maxAutoFixRounds = value.maxAutoFixRounds;
  }
  return settings;
}

/** Save a partial update; returns the settings as stored afterwards. */
export function writeAutopilotSettings(
  patch: Partial<AutopilotSettings>,
  settingsPath = getPiWebSettingsPath(),
): AutopilotSettings {
  const current = readAutopilotSettings(settingsPath);
  const next: AutopilotSettings = {
    enabled: readBool(patch.enabled, current.enabled),
    autoApproveTeamPlans: readBool(patch.autoApproveTeamPlans, current.autoApproveTeamPlans),
    autoFixFailedRuns: readBool(patch.autoFixFailedRuns, current.autoFixFailedRuns),
    maxAutoFixRounds: patch.maxAutoFixRounds ?? current.maxAutoFixRounds,
  };
  if (
    !Number.isInteger(next.maxAutoFixRounds) ||
    next.maxAutoFixRounds < 1 ||
    next.maxAutoFixRounds > MAX_AUTOPILOT_FIX_ROUNDS
  ) {
    throw new RangeError(`maxAutoFixRounds must be an integer between 1 and ${MAX_AUTOPILOT_FIX_ROUNDS}`);
  }
  updatePiWebSettings({ autopilot: next }, settingsPath);
  return next;
}

export function isAutopilotEnabled(settingsPath = getPiWebSettingsPath()): boolean {
  return readAutopilotSettings(settingsPath).enabled;
}
