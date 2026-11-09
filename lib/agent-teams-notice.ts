/**
 * Agent Team「成本确认弹窗」的提醒偏好（A6 / A8）。
 *
 * 首次勾选 composer 的团队开关（或首次在设置里启用全局功能）时弹一次，说明团队会
 * 开多个子会话、并行消耗 token 与时间。用户勾「不再提醒」后不再弹。
 *
 * 为什么不复用 lib/app-prefs.ts 的 APP_PREF_KEYS：那个文件由状态层（A1）拥有、本轮
 * 明确不动，而这里只需要一个「不再提醒」布尔。故直接用 localStorage + 独立 key，
 * 并同样走 SSR / 隐私模式安全的读写（沿用 app-prefs 的失败方向：读不动按「没拒绝过」，
 * 也就是**宁可多提醒一次，也不静默吞掉告知**）。
 */

/** localStorage key：`"1"` = 用户选了「不再提醒」。 */
const COST_NOTICE_DISMISSED_KEY = "pi-agent-teams-cost-dismissed";

function readFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // private mode / quota：静默失败即可，提醒偏好不是关键数据。
  }
}

/** 用户是否选过「不再提醒」。 */
export function isAgentTeamCostNoticeDismissed(): boolean {
  return readFlag(COST_NOTICE_DISMISSED_KEY);
}

/** 是否还需要弹成本确认：用户没选过「不再提醒」就是需要。 */
export function shouldShowAgentTeamCostNotice(): boolean {
  return !isAgentTeamCostNoticeDismissed();
}

/** 记住「不再提醒」：之后 composer / 设置都不再弹。 */
export function dismissAgentTeamCostNotice(): void {
  writeFlag(COST_NOTICE_DISMISSED_KEY, true);
}

/** 清掉「不再提醒」，让弹窗重新出现（调试 / 将来「重新引导」用）。 */
export function resetAgentTeamCostNotice(): void {
  writeFlag(COST_NOTICE_DISMISSED_KEY, false);
}
