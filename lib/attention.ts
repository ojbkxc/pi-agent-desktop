/**
 * "Needs you" aggregation: which sessions are parked on a question or approval
 * (`awaiting`), and which ones are worth a look lately (`completed`).
 *
 * The pure part is unit-tested without the pi SDK; the server assembly at the
 * bottom loads session metadata and the live registry lazily, so importing this
 * module from a test never pulls in `lib/rpc-manager.ts`.
 *
 * Wire shape: `lib/attention-types.ts` — pinned, shared with the phone shell.
 */
import type { AgentTaskSnapshot, SessionInfo } from "./types";
import type { AttentionItem, AttentionSnapshot } from "./attention-types";
import { skillExpansionToCommand } from "./slash-display";

/** Most completed rows the endpoint returns (the mobile home screen's "recent" cap). */
export const ATTENTION_COMPLETED_LIMIT = 20;
/** Titles and previews are bounded so a pasted document cannot bloat every poll. */
export const ATTENTION_TITLE_MAX = 120;
export const ATTENTION_PREVIEW_MAX = 200;

/**
 * Rows the sidebar never shows belong in no inbox either: subagent runs report
 * through their parent, scheduled runs live under Scheduled, and a transient
 * session has no JSONL yet.
 */
function isInboxEligible(session: SessionInfo): boolean {
  if (session.transient) return false;
  if (session.relation?.kind === "subagent") return false;
  if (session.relation?.kind === "scheduled") return false;
  return true;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cut at a code-unit boundary that never splits a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Session name, else its first message (skill expansions collapsed), else a short id. */
export function attentionTitle(session: SessionInfo): string {
  const firstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = collapseWhitespace(session.name || firstMessage || "") || session.id.slice(0, 12);
  return truncate(title, ATTENTION_TITLE_MAX);
}

/** The project folder's name; a chat has none. */
export function attentionProjectName(session: SessionInfo): string | undefined {
  if (session.workspaceKind === "chat") return undefined;
  const root = session.projectRoot || session.cwd || "";
  if (!root) return undefined;
  const trimmed = root.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || root;
}

/**
 * Last activity as a positive epoch ms. The phone shell drops a row whose
 * `updatedAt` is not > 0, so an unparseable `modified` falls back to the clock
 * rather than 0.
 */
function updatedAtOf(session: SessionInfo, fallback: number): number {
  const parsed = Date.parse(session.modified);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/** A dialog's prompt, from the same snapshot the Tasks page shows. */
function waitingPreview(snapshot: AgentTaskSnapshot | undefined): string | undefined {
  const prompt = snapshot?.waiting[0]?.prompt;
  if (!prompt) return undefined;
  const preview = truncate(collapseWhitespace(prompt), ATTENTION_PREVIEW_MAX);
  return preview || undefined;
}

export interface BuildAttentionInput {
  /** Every session the sidebar knows about (already merged and project-annotated). */
  sessions: readonly SessionInfo[];
  /** Ids parked on a blocking dialog (`getAwaitingInputRpcSessionIds()`). */
  awaitingSessionIds: readonly string[];
  /** Live per-session snapshots (`getRpcTaskSnapshots()`), for wait time and prompt. */
  taskSnapshots?: readonly AgentTaskSnapshot[];
  /** Clock injection point; defaults to now. */
  now?: number;
  completedLimit?: number;
}

/**
 * Pure projection. Awaiting beats completed (a dialog blocks the run), the
 * longest wait comes first, and completed rows are the newest non-awaiting
 * sessions by `updatedAt`.
 *
 * Unread is deliberately not judged here: only the client knows what the person
 * has already looked at, so it filters `completed` itself.
 */
export function buildAttentionSnapshot({
  sessions,
  awaitingSessionIds,
  taskSnapshots = [],
  now = Date.now(),
  completedLimit = ATTENTION_COMPLETED_LIMIT,
}: BuildAttentionInput): AttentionSnapshot {
  const awaiting = new Set(awaitingSessionIds);
  const snapshotById = new Map(taskSnapshots.map((snapshot) => [snapshot.sessionId, snapshot]));
  const eligible = sessions.filter(isInboxEligible);
  const seen = new Set<string>();

  const awaitingItems: AttentionItem[] = [];
  for (const session of eligible) {
    if (!awaiting.has(session.id)) continue;
    seen.add(session.id);
    const snapshot = snapshotById.get(session.id);
    const startedAt = snapshot?.runStartedAt ?? undefined;
    const preview = waitingPreview(snapshot);
    const projectName = attentionProjectName(session);
    awaitingItems.push({
      sessionId: session.id,
      title: attentionTitle(session),
      workspaceKind: session.workspaceKind === "chat" ? "chat" : "project",
      ...(projectName ? { projectName } : {}),
      kind: "awaiting-input",
      ...(typeof startedAt === "number" ? { awaitingSince: startedAt } : {}),
      updatedAt: updatedAtOf(session, now),
      ...(preview ? { lastMessagePreview: preview } : {}),
    });
  }

  // A runtime session that is waiting but has no catalogue row yet must not
  // vanish from the inbox: list it by id until the next scan fills it in. An id
  // whose row exists but is ineligible (subagent, scheduled, transient) stays
  // out — the sidebar shows no row for it either.
  const catalogued = new Set(sessions.map((session) => session.id));
  for (const sessionId of awaiting) {
    if (seen.has(sessionId) || catalogued.has(sessionId)) continue;
    const snapshot = snapshotById.get(sessionId);
    const startedAt = snapshot?.runStartedAt ?? undefined;
    const preview = waitingPreview(snapshot);
    awaitingItems.push({
      sessionId,
      title: sessionId.slice(0, 12),
      workspaceKind: "project",
      kind: "awaiting-input",
      ...(typeof startedAt === "number" ? { awaitingSince: startedAt } : {}),
      updatedAt: now,
      ...(preview ? { lastMessagePreview: preview } : {}),
    });
  }

  // Longest wait first; a session without a start time falls back to activity.
  awaitingItems.sort((a, b) => (
    (a.awaitingSince ?? a.updatedAt) - (b.awaitingSince ?? b.updatedAt)
    || b.updatedAt - a.updatedAt
    || a.sessionId.localeCompare(b.sessionId)
  ));

  const completed = eligible
    .filter((session) => !awaiting.has(session.id))
    .map((session): AttentionItem => {
      const projectName = attentionProjectName(session);
      return {
        sessionId: session.id,
        title: attentionTitle(session),
        workspaceKind: session.workspaceKind === "chat" ? "chat" : "project",
        ...(projectName ? { projectName } : {}),
        kind: "completed",
        updatedAt: updatedAtOf(session, now),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
    .slice(0, Math.max(0, completedLimit));

  return { awaiting: awaitingItems, completed, generatedAt: now };
}

/**
 * Server assembly for `GET /api/attention`.
 *
 * Both imports are dynamic on purpose: `lib/rpc-manager.ts` and
 * `lib/session-reader.ts` pull in the pi SDK, and the pure projection above is
 * what tests import. `listAllSessions()` is the same 30s cache `/api/sessions`
 * serves, so the inbox poll adds no extra directory scan.
 */
export async function loadAttentionSnapshot(now = Date.now()): Promise<AttentionSnapshot> {
  const [sessionReader, rpcManager] = await Promise.all([
    import("./session-reader"),
    import("./rpc-manager"),
  ]);
  const sessions = await sessionReader.listAllSessions();
  return buildAttentionSnapshot({
    sessions,
    awaitingSessionIds: rpcManager.getAwaitingInputRpcSessionIds(),
    taskSnapshots: rpcManager.getRpcTaskSnapshots(),
    now,
  });
}
