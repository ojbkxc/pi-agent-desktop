/**
 * Pure helpers for the phone shell's home dashboard (relay-shell/shell.ts):
 * the desktop's `GET /api/attention` payload is parsed and turned into row
 * text here, away from the DOM, so `node --test` covers it.
 *
 * The shape mirrors the attention contract the desktop serves:
 *   { awaiting: AttentionItem[], completed: AttentionItem[], generatedAt: number }
 * A payload that is not that shape at all parses to null (the shell says so);
 * one bad row is skipped instead of taking the whole dashboard down.
 */

export type AttentionKind = "awaiting-input" | "completed";

export interface AttentionItem {
  sessionId: string;
  title: string;
  workspaceKind: "chat" | "project";
  projectName?: string;
  kind: AttentionKind;
  awaitingSince?: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface AttentionSnapshot {
  awaiting: AttentionItem[];
  completed: AttentionItem[];
  generatedAt: number;
}

const MAX_ITEMS = 200;
const MAX_PREVIEW = 140;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteStamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** One row, or null when it has no identity to show (missing session id, title, or timestamp). */
export function parseAttentionItem(value: unknown, kind: AttentionKind): AttentionItem | null {
  if (!isRecord(value)) return null;
  const sessionId = nonEmptyText(value.sessionId);
  const title = nonEmptyText(value.title);
  const updatedAt = finiteStamp(value.updatedAt);
  if (!sessionId || !title || updatedAt === undefined) return null;
  const item: AttentionItem = {
    sessionId,
    title,
    // The list decides the kind; a mismatched field is not worth dropping a row over.
    workspaceKind: value.workspaceKind === "chat" ? "chat" : "project",
    kind,
    updatedAt,
  };
  const projectName = nonEmptyText(value.projectName);
  if (projectName) item.projectName = projectName;
  const awaitingSince = finiteStamp(value.awaitingSince);
  if (awaitingSince !== undefined) item.awaitingSince = awaitingSince;
  const preview = nonEmptyText(value.lastMessagePreview);
  if (preview) item.lastMessagePreview = preview;
  return item;
}

function parseList(value: unknown, kind: AttentionKind): AttentionItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: AttentionItem[] = [];
  for (const entry of value.slice(0, MAX_ITEMS)) {
    const item = parseAttentionItem(entry, kind);
    if (item) items.push(item);
  }
  return items;
}

/**
 * The parsed payload, or null when it is not the contract's shape. A session
 * that appears in both lists stays in "needs you" only — it is still waiting,
 * whatever its last run did.
 */
export function parseAttentionResponse(value: unknown): AttentionSnapshot | null {
  if (!isRecord(value)) return null;
  const awaiting = parseList(value.awaiting, "awaiting-input");
  const completed = parseList(value.completed, "completed");
  if (!awaiting || !completed) return null;
  const awaitingIds = new Set(awaiting.map((item) => item.sessionId));
  return {
    awaiting,
    completed: completed.filter((item) => !awaitingIds.has(item.sessionId)),
    generatedAt: finiteStamp(value.generatedAt) ?? 0,
  };
}

/** Title text for a row; the desktop may not have named the session. */
export function attentionItemTitle(item: AttentionItem): string {
  return item.title.replace(/\s+/g, " ").trim() || "(untitled session)";
}

/** One or two lines of the last message, collapsed and capped for a phone row. */
export function attentionPreview(item: AttentionItem): string {
  const line = (item.lastMessagePreview ?? "").replace(/\s+/g, " ").trim();
  return line.length > MAX_PREVIEW ? `${line.slice(0, MAX_PREVIEW - 1)}…` : line;
}

/**
 * Short age text without "ago": "now", "5 min", "2 h", "3 d", or a date for
 * anything older than a week. Pure so the row text is testable.
 */
export function relativeAge(now: number, then: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then <= 0) return "";
  const ms = now - then;
  if (ms < 45_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d`;
  const date = new Date(then);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

/** Second line of a row: where the session lives and when it got here. */
export function attentionItemMeta(item: AttentionItem, now: number): string {
  const parts: string[] = [];
  if (item.workspaceKind === "chat") parts.push("Chat");
  else if (item.projectName) parts.push(item.projectName);
  if (item.kind === "awaiting-input") {
    const age = relativeAge(now, item.awaitingSince ?? item.updatedAt);
    if (age === "now") parts.push("waiting now");
    else if (age) parts.push(`waiting ${age}`);
  } else {
    const age = relativeAge(now, item.updatedAt);
    if (age === "now") parts.push("just now");
    else if (age) parts.push(`${age} ago`);
  }
  return parts.join(" · ");
}

/** The in-app address of one session — the app's own `?session=` deep link. */
export function attentionHref(sessionId: string): string {
  return `/?session=${encodeURIComponent(sessionId)}`;
}