import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";

// Pi Web behavior-guide switch, kept next to `artifactsPrompt` in
// ~/.pi/agent/pi-web/settings.json for the same reason: the pi CLI and other
// hosts read that file and have no behavior guide to turn off.

/**
 * Whether sessions get the behavior-guide section. On by default; an
 * unreadable file keeps it on, matching `isArtifactsPromptEnabled`: the cost
 * of a wrong "on" is one short prompt section, a silent "off" would look like
 * the model stopped following basic discipline.
 */
export function isAgentGuidePromptEnabled(settingsPath = getPiWebSettingsPath()): boolean {
  try {
    return readStored(settingsPath).agentGuidePrompt !== false;
  } catch {
    return true;
  }
}

export function writeAgentGuidePromptEnabled(
  enabled: boolean,
  settingsPath = getPiWebSettingsPath(),
): boolean {
  updatePiWebSettings({ agentGuidePrompt: enabled }, settingsPath);
  return isAgentGuidePromptEnabled(settingsPath);
}
