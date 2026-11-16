import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "../artifact-settings";
import { isApprovalMode, type ApprovalMode } from "./policy";

/**
 * 命令审批的设置持久化：与 artifactsPrompt / leanMode 同住
 * `~/.pi/agent/pi-web/settings.json`。放在这里而不是 pi 的 settings.json，是因为
 * pi CLI 与其它宿主没有这个审批器，写进公共设置会让它们看到一个自己不会执行的键。
 *
 * 读取口径与 `isLeanMode` 一致：读不动文件就当作 **off**。审批器坏了要 fail-open
 * （见 extension.ts），一个坏文件更不能悄悄把它「挂上」把会话卡死。
 */

export const TOOL_APPROVAL_SETTINGS_KEY = "toolApprovalMode";

/** 默认档：off —— 与功能上线前完全一致，用户显式开启才生效。 */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "off";

export function readApprovalMode(settingsPath = getPiWebSettingsPath()): ApprovalMode {
  try {
    const stored = readStored(settingsPath)[TOOL_APPROVAL_SETTINGS_KEY];
    return isApprovalMode(stored) ? stored : DEFAULT_APPROVAL_MODE;
  } catch {
    return DEFAULT_APPROVAL_MODE;
  }
}

/** 只改这一个键，Pi Web 设置文件里的其它键原样保留；回读生效值。 */
export function writeApprovalMode(mode: ApprovalMode, settingsPath = getPiWebSettingsPath()): ApprovalMode {
  updatePiWebSettings({ [TOOL_APPROVAL_SETTINGS_KEY]: mode }, settingsPath);
  return readApprovalMode(settingsPath);
}