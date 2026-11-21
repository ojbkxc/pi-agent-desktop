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
import type { AutofixStatus } from "./autofix/types";
import { skillExpansionToCommand } from "./slash-display";

/** Most completed rows the endpoint returns (the mobile home screen's "recent" cap). */
export const ATTENTION_COMPLETED_LIMIT = 20;
/** Titles and previews are bounded so a pasted document cannot bloat every poll. */
export const ATTENTION_TITLE_MAX = 120;
export const ATTENTION_PREVIEW_MAX = 200;
/**
 * Autofix outcomes merged into `completed` per snapshot. They are the rows a
 * person is most likely to act on, so they come first, and a burst of failed
 * runs must not push every ordinary session out of the inbox.
 */
export const ATTENTION_AUTOFIX_LIMIT = 10;
/**
 * Scheduled run outcomes (failed / aborted) merged into `completed` per
 * snapshot — the same treatment autofix gets: capped so a burst of broken cron
 * runs cannot flush every ordinary session out of the inbox.
 */
export const ATTENTION_SCHEDULED_LIMIT = 10;

/** Terminal autofix outcomes worth a row; `succeeded` needs none. */
const INBOX_AUTOFIX_STATUSES: ReadonlySet<AutofixStatus> = new Set(["failed", "exhausted", "stopped"]);

/** Terminal scheduled outcomes worth a row; a run that did not fail needs none. */
const INBOX_SCHEDULED_STATUSES: ReadonlySet<string> = new Set(["failed", "aborted"]);

/** Shared empty default so the scheduled projection allocates no set per call. */
const EMPTY_KEYS: ReadonlySet<string> = new Set();

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

/** The project folder's name for a filesystem path; `undefined` for an empty root. */
function projectNameFromRoot(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const trimmed = root.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || root;
}

/** The project folder's name; a chat has none. */
export function attentionProjectName(session: SessionInfo): string | undefined {
  if (session.workspaceKind === "chat") return undefined;
  return projectNameFromRoot(session.projectRoot || session.cwd);
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

/** The slice of an autofix task the inbox needs (the full record lives in `lib/autofix/types.ts`). */
export interface AttentionAutofixTask {
  id: string;
  task: string;
  cwd: string;
  status: AutofixStatus;
  /** The repair session; a task that never started one has nothing to open. */
  sessionId: string | null;
  updatedAt: number;
  finishedAt: number | null;
}

/**
 * Terminal autofix outcomes as inbox rows. A failed / exhausted / stopped
 * repair is exactly what "Needs you" is for, but its session is a scheduled
 * kind the session list hides, so it would never surface from `sessions`
 * alone. Rows without a session are skipped: the deep link could open nothing,
 * and the task stays visible on the Autofix page.
 */
export function attentionItemsForAutofix(
  tasks: readonly AttentionAutofixTask[],
  now = Date.now(),
): AttentionItem[] {
  const bySession = new Map<string, AttentionItem>();
  for (const task of tasks) {
    if (!INBOX_AUTOFIX_STATUSES.has(task.status)) continue;
    const sessionId = task.sessionId;
    if (!sessionId) continue;
    const stamp = task.finishedAt ?? task.updatedAt;
    const updatedAt = Number.isFinite(stamp) && stamp > 0 ? stamp : now;
    const projectName = projectNameFromRoot(task.cwd);
    const item: AttentionItem = {
      sessionId,
      title: truncate(collapseWhitespace(task.task) || sessionId.slice(0, 12), ATTENTION_TITLE_MAX),
      workspaceKind: "project",
      ...(projectName ? { projectName } : {}),
      kind: "completed",
      updatedAt,
    };
    // One session can be the subject of several tasks; the newest outcome wins.
    const existing = bySession.get(sessionId);
    if (!existing || existing.updatedAt < item.updatedAt) bySession.set(sessionId, item);
  }
  return [...bySession.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
    .slice(0, ATTENTION_AUTOFIX_LIMIT);
}

/** The slice of a scheduled run the inbox needs (the full record lives in `lib/scheduled-tasks/types.ts`). */
export interface AttentionScheduledRun {
  taskId: string;
  /** Run id, used to match an autofix task spawned for this run (see the marker below). */
  runId?: string;
  status: "running" | "succeeded" | "failed" | "aborted" | "skipped";
  /** The run's own session; a run that never started one has nothing to open. */
  sessionId?: string;
  endedAt?: string;
  startedAt?: string;
}

/** The slice of a scheduled task the inbox needs: the taskId → name / cwd lookup. */
export interface AttentionScheduledTask {
  id: string;
  name: string;
  cwd: string;
}

/**
 * The marker the scheduler stamps into an autofix task it spawned for a failed
 * run (`[scheduled:<taskId>:<runId>]`, `lib/scheduled-tasks/scheduler.ts`).
 * Both ids are uuids, so a colon-free match is exact.
 */
const AUTOFIX_SOURCE_MARKER = /\[scheduled:([^:\]\s]+):([^:\]\s]+)\]/;

/** The `<taskId>:<runId>` a repair task was spawned for, or undefined for a manual repair. */
export function autofixScheduledSourceKey(task: Pick<AttentionAutofixTask, "task">): string | undefined {
  const match = AUTOFIX_SOURCE_MARKER.exec(task.task);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

/**
 * Terminal scheduled-run outcomes as inbox rows. A failed / aborted run is
 * exactly what "Needs you" is for, but its session is a `scheduled` kind the
 * session list hides, so it would never surface from `sessions` alone — the
 * same gap `attentionItemsForAutofix` fills. Rows without a session are
 * skipped (the deep link could open nothing; the run stays on the Scheduled
 * page). The title is the owning task's name, falling back to `#<taskId[:8]>`
 * when the task is gone; a run reused by one session keeps the newest outcome.
 *
 * `coveredRunKeys` holds `<taskId>:<runId>` values whose failed run already got
 * an autofix row. That repair opens its own session, so without this the same
 * failure would land twice — once for the run, once for the repair.
 */
export function attentionItemsForScheduledRuns(
  runs: readonly AttentionScheduledRun[],
  tasks: readonly AttentionScheduledTask[],
  now = Date.now(),
  coveredRunKeys: ReadonlySet<string> = EMPTY_KEYS,
): AttentionItem[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const bySession = new Map<string, AttentionItem>();
  for (const run of runs) {
    if (!INBOX_SCHEDULED_STATUSES.has(run.status)) continue;
    const sessionId = run.sessionId;
    if (!sessionId) continue;
    if (run.runId && coveredRunKeys.has(`${run.taskId}:${run.runId}`)) continue;
    const task = taskById.get(run.taskId);
    const parsed = Date.parse(run.endedAt ?? run.startedAt ?? "");
    const updatedAt = Number.isFinite(parsed) && parsed > 0 ? parsed : now;
    const projectName = projectNameFromRoot(task?.cwd);
    const label = collapseWhitespace(task?.name ?? "") || `#${run.taskId.slice(0, 8)}`;
    const item: AttentionItem = {
      sessionId,
      title: truncate(label, ATTENTION_TITLE_MAX),
      workspaceKind: "project",
      ...(projectName ? { projectName } : {}),
      kind: "completed",
      updatedAt,
    };
    // One session can back several runs; the newest outcome wins.
    const existing = bySession.get(sessionId);
    if (!existing || existing.updatedAt < item.updatedAt) bySession.set(sessionId, item);
  }
  return [...bySession.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
    .slice(0, ATTENTION_SCHEDULED_LIMIT);
}

export interface BuildAttentionInput {
  /** Every session the sidebar knows about (already merged and project-annotated). */
  sessions: readonly SessionInfo[];
  /** Ids parked on a blocking dialog (`getAwaitingInputRpcSessionIds()`). */
  awaitingSessionIds: readonly string[];
  /** Live per-session snapshots (`getRpcTaskSnapshots()`), for wait time and prompt. */
  taskSnapshots?: readonly AgentTaskSnapshot[];
  /** Terminal autofix outcomes; merged above the ordinary completed rows. */
  autofixTasks?: readonly AttentionAutofixTask[];
  /** Terminal scheduled-run outcomes (failed / aborted); merged with autofix rows. */
  scheduledRuns?: readonly AttentionScheduledRun[];
  /** Scheduled tasks, for the run's taskId → title / cwd lookup. */
  scheduledTasks?: readonly AttentionScheduledTask[];
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
  autofixTasks = [],
  scheduledRuns = [],
  scheduledTasks = [],
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

  // Unattended outcomes (autofix repairs + failed scheduled runs) lead the
  // completed list; their sessions would otherwise arrive as anonymous
  // "completed" rows (or not at all, while running). Each source is capped on
  // its own so neither can swamp the other; a session parked on a dialog stays
  // in `awaiting` only — it is still waiting.
  const autofixItems = attentionItemsForAutofix(autofixTasks, now);
  // A repair spawned for a failed run replaces that run's own row: the two have
  // different sessions, so session-id dedupe below cannot see them as one
  // failure. Only repairs that actually produce a row may suppress the run —
  // a repair that never started a session must leave the run's row in place.
  const rowsByAutofixSession = new Set(autofixItems.map((item) => item.sessionId));
  const coveredRunKeys = new Set<string>();
  for (const task of autofixTasks) {
    if (!task.sessionId || !rowsByAutofixSession.has(task.sessionId)) continue;
    const key = autofixScheduledSourceKey(task);
    if (key) coveredRunKeys.add(key);
  }
  const unattended = [
    ...autofixItems,
    ...attentionItemsForScheduledRuns(scheduledRuns, scheduledTasks, now, coveredRunKeys),
  ].filter((item) => !awaiting.has(item.sessionId));

  // A session backing both an autofix task and a scheduled run (or several of
  // either) keeps the newest outcome; then the group is ordered newest-first and
  // bounded by the same completed cap as everything else.
  const unattendedBySession = new Map<string, AttentionItem>();
  for (const item of unattended) {
    const existing = unattendedBySession.get(item.sessionId);
    if (!existing || existing.updatedAt < item.updatedAt) unattendedBySession.set(item.sessionId, item);
  }
  const unattendedItems = [...unattendedBySession.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
    .slice(0, Math.max(0, completedLimit));
  const unattendedIds = new Set(unattendedItems.map((item) => item.sessionId));

  const completed = eligible
    .filter((session) => !awaiting.has(session.id) && !unattendedIds.has(session.id))
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
    .slice(0, Math.max(0, completedLimit - unattendedItems.length));

  return { awaiting: awaitingItems, completed: [...unattendedItems, ...completed], generatedAt: now };
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
  const [sessionReader, rpcManager, autofixStore, scheduledStore] = await Promise.all([
    import("./session-reader"),
    import("./rpc-manager"),
    import("./autofix/store"),
    import("./scheduled-tasks/store"),
  ]);
  const sessions = await sessionReader.listAllSessions();
  // The scheduled store is a plain synchronous JSON read; a corrupt or missing
  // file must degrade to "no scheduled rows", never take the inbox down (500).
  let scheduledRuns: AttentionScheduledRun[] = [];
  let scheduledTasks: AttentionScheduledTask[] = [];
  try {
    scheduledRuns = scheduledStore.listAllRuns();
    scheduledTasks = scheduledStore.listTasks();
  } catch {
    scheduledRuns = [];
    scheduledTasks = [];
  }
  return buildAttentionSnapshot({
    sessions,
    awaitingSessionIds: rpcManager.getAwaitingInputRpcSessionIds(),
    taskSnapshots: rpcManager.getRpcTaskSnapshots(),
    autofixTasks: autofixStore.listAutofixTasks(),
    scheduledRuns,
    scheduledTasks,
    now,
  });
}
