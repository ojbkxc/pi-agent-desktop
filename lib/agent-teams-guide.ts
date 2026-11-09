import { APP_PREF_KEYS, getPref, removePref, setPref } from "@/lib/app-prefs";

/**
 * Agent Team 的「一次性发现引导」（A1）。
 *
 * 首次提供团队开关时，在 composer 上给一次轻量提示，之后不再打扰。这里用**两态**而不是
 * 一个布尔：
 *
 * - 「引导已展示过」（`agentTeamsGuideSeen`）：用户自然看过 / 走完了引导，属于中性完成。
 * - 「用户已拒绝」（`agentTeamsGuideDismissed`）：用户主动关掉 / 拒绝了这份引导，是明确
 *   的否决，要尊重到底。
 *
 * 两者都能让提示不再出现，但语义不同、将来可以分开处理（例如只看过的用户仍可能从帮助里
 * 重新唤出，拒绝过的则不再主动推）。避免单一布尔把「看过」和「被拒绝」压成同一个信号、
 * 以后再也分不开。
 *
 * 与其它应用偏好一样落 localStorage（`lib/app-prefs.ts`），刷新 / 重启后保留。
 */

/** 引导是否还需展示：既没看过、也没被拒绝过时才是。 */
export function shouldShowAgentTeamGuide(): boolean {
  return !hasSeenAgentTeamGuide() && !isAgentTeamGuideDismissed();
}

/** 引导已经展示过（用户看过 / 走完）。 */
export function hasSeenAgentTeamGuide(): boolean {
  return getPref(APP_PREF_KEYS.agentTeamsGuideSeen) === "1";
}

/** 用户主动拒绝过这份引导。 */
export function isAgentTeamGuideDismissed(): boolean {
  return getPref(APP_PREF_KEYS.agentTeamsGuideDismissed) === "1";
}

/** 记下「引导展示过」。展示时调用；不改变拒绝态。 */
export function markAgentTeamGuideSeen(): void {
  setPref(APP_PREF_KEYS.agentTeamsGuideSeen, "1");
}

/** 用户关掉引导 = 看过 + 明确拒绝。之后 `shouldShowAgentTeamGuide()` 都为 false。 */
export function dismissAgentTeamGuide(): void {
  setPref(APP_PREF_KEYS.agentTeamsGuideSeen, "1");
  setPref(APP_PREF_KEYS.agentTeamsGuideDismissed, "1");
}

/** 清掉引导记录，让提示重新出现（设置里的「重新引导」/ 调试用）。 */
export function resetAgentTeamGuide(): void {
  removePref(APP_PREF_KEYS.agentTeamsGuideSeen);
  removePref(APP_PREF_KEYS.agentTeamsGuideDismissed);
}
