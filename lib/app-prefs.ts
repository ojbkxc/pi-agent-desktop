/**
 * Unified app preference storage. Backed by localStorage in both the web UI
 * and the Tauri WebView so prefs survive reloads. Theme is additionally mirrored
 * into the desktop app config dir (see `set_ui_theme`) so cold starts keep the
 * choice even if the local server port / origin changes.
 */

export const APP_PREF_KEYS = {
  theme: "pi-theme",
  fonts: "pi-fonts",
  locale: "pi-locale",
  soundEnabled: "pi-sound-enabled",
  quoteSelectionEnabled: "pi-quote-selection-enabled",
  sidebarWidth: "pi-sidebar-width",
  rightPanelWidth: "pi-right-panel-width",
  unreadSessionIds: "pi-web:unread-session-ids",
  /** Project roots moved to the sidebar's Archive group (see lib/archived-projects.ts). */
  archivedProjects: "pi-web:archived-projects",
  /** "1" while the sidebar Archive group is unfolded; folded by default. */
  archiveExpanded: "pi-web:archive-expanded",
  /** Sidebar Projects pane layout: grouped project tree or chronological sessions. */
  projectViewMode: "pi-web:project-view-mode",
  /** Project roots whose session list is folded in the sidebar tree. */
  collapsedProjects: "pi-web:collapsed-projects",
  /** Project root -> additional five-session pages shown past the preview cap. */
  expandedProjects: "pi-web:expanded-projects",
  /** "1" while the sidebar Chats section is folded. */
  collapsedChats: "pi-web:collapsed-chats",
  /**
   * Agent Team 的**全局可用性**开关（Settings › General › Chat），默认 `true`。
   *
   * 键名带 `-v2` 是一次语义迁移：旧键 `pi-agent-teams-enabled` 的语义是「下一条消息用团队」
   * 的单条 armed，旧代码每次发送后都会把它写回 `"false"`（`disarmAgentTeam()`），用户勾/取消
   * 那个旧开关也会落 `"false"`。升级后新代码把同一个键读成「功能是否**全局可用**」，那些遗留的
   * `"false"` 就会把功能静默关掉，composer 上的团队开关随之置灰、点击跳设置——这正是
   * 「点一下就跳到设置」的根因。语义变了就必须换键：旧值一律作废，新键没存过 → 回到默认开。
   *
   * 注意单条 armed 现在是**内存态、不落盘**，由 `hooks/useAgentTeamsEnabled.ts` 的
   * `useAgentTeamsArmed()` 管理；只有这个全局可用性偏好落盘。
   */
  agentTeamsEnabled: "pi-agent-teams-enabled-v2",
  /** Agent Team 一次性发现引导：`"1"` = 引导已展示过（用户看过 / 走完）。 */
  agentTeamsGuideSeen: "pi-agent-teams-guide-seen",
  /** Agent Team 一次性发现引导：`"1"` = 用户主动关闭 / 拒绝过这份引导。 */
  agentTeamsGuideDismissed: "pi-agent-teams-guide-dismissed",
  /** Additional five-chat pages shown past the Chats preview cap. */
  chatSessionPages: "pi-web:chat-session-pages",
  /** Chat session ids pinned to the top of the Chats section. */
  pinnedChats: "pi-web:pinned-chats",
  /** Chat session ids hidden from the Chats section until "Show archived". */
  archivedChats: "pi-web:archived-chats",
  /** Project session ids hidden from their project until "Show archived" (#200). */
  archivedSessions: "pi-web:archived-sessions",
  updateSnooze: "pi-web:update-snooze",
  closeQuits: "pi-desktop-close-quits",
  notifyOnComplete: "pi-desktop-notify-on-complete",
  chatDrafts: "pi-chat-drafts-v1",
  diffViewMode: "pi-diff-view-mode",
  /** Last open session / cwd / file tabs for desktop cold-start restore. */
  workspace: "pi-workspace-v1",
} as const;

export type AppPrefKey = (typeof APP_PREF_KEYS)[keyof typeof APP_PREF_KEYS];

export function getPref(key: AppPrefKey): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setPref(key: AppPrefKey, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / quota
  }
}

export function removePref(key: AppPrefKey): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function getPrefBool(key: AppPrefKey, fallback: boolean): boolean {
  const raw = getPref(key);
  if (raw === null) return fallback;
  return raw === "true";
}

export function setPrefBool(key: AppPrefKey, value: boolean): void {
  setPref(key, String(value));
}

export function getPrefJson<T>(key: AppPrefKey): T | null {
  const raw = getPref(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setPrefJson(key: AppPrefKey, value: unknown): void {
  try {
    setPref(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
