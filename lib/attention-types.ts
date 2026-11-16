/**
 * Shapes shared by the server (`GET /api/attention`) and every client that
 * renders the "Needs you" inbox: the desktop sidebar, the Tasks page and the
 * phone home screen.
 *
 * Pure types only — no Node APIs, no imports. The phone shell bundles this
 * file as-is, so the wire shape is pinned here and must not drift: change it
 * only together with every consumer.
 */

/** Why a session is in the inbox. */
export type AttentionKind = "awaiting-input" | "completed";

export interface AttentionItem {
  sessionId: string;
  /** Session name, else its first message, else a short id. */
  title: string;
  workspaceKind: "chat" | "project";
  /** Project folder name for a project session; absent for a chat. */
  projectName?: string;
  kind: AttentionKind;
  /**
   * Start of the run that is now parked on a dialog (ms since epoch) — the
   * closest signal the server has for "how long has this waited". Absent when
   * it cannot tell; an awaiting item then sorts by `updatedAt`.
   */
  awaitingSince?: number;
  /** Last activity, ms since epoch. */
  updatedAt: number;
  /**
   * What the session is asking (the blocking dialog's prompt), bounded in
   * length. Absent for completed items and for awaiting items with no prompt.
   */
  lastMessagePreview?: string;
}

/** `GET /api/attention` response. */
export interface AttentionSnapshot {
  /** Parked on a question/approval the person must answer, longest-waiting first. */
  awaiting: AttentionItem[];
  /** Newest non-awaiting sessions by `updatedAt`, descending. Unread filtering is the client's job. */
  completed: AttentionItem[];
  generatedAt: number;
}
