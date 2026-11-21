import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";
import { AUTOFIX_MAX_ROUNDS } from "./autofix/types";

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

/**
 * Round cap accepted by autopilot. It must be the engine's own cap: a larger
 * value passes the settings validation, then `createAutofixTask` rejects it and
 * the scheduler's catch swallows the error, so the failed run silently gets no
 * repair at all.
 */
export const MAX_AUTOPILOT_FIX_ROUNDS = AUTOFIX_MAX_ROUNDS;

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

/**
 * Sessions started by unattended work, recognised by the custom entries their
 * runners write. A manual session never carries one of these.
 */
export const AUTOPILOT_SESSION_MARKERS = ["pi-web:scheduled-run", "pi-web:autofix"] as const;

export function isAutopilotOriginatedSession(customTypes: readonly string[]): boolean {
  return customTypes.some((type) => (AUTOPILOT_SESSION_MARKERS as readonly string[]).includes(type));
}

/**
 * How long a blocking dialog in an unattended session waits for a person before
 * it takes the safe default (cancel / "no"). Two minutes: long enough for the
 * phone notification to reach someone, short enough that a forgotten run does
 * not sit parked all night.
 */
export const AUTOPILOT_DIALOG_TIMEOUT_MS = 120_000;

/**
 * The timeout a blocking dialog gets, or `undefined` for "wait forever".
 * An extension's own timeout always wins; otherwise only autopilot sessions
 * with the master switch on are auto-answered.
 */
export function resolveAutopilotDialogTimeout(input: {
  requested?: number;
  autopilotSession: boolean;
  settings: AutopilotSettings;
}): number | undefined {
  if (input.requested) return input.requested;
  return input.autopilotSession && input.settings.enabled ? AUTOPILOT_DIALOG_TIMEOUT_MS : undefined;
}
