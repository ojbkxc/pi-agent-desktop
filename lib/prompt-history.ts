import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Cross-session prompt history (ISSUE-11).
 *
 * Pi's composer ↑/↓ recall used to read only the current session's transcript,
 * so a fresh session recalled nothing. This module persists every submitted
 * prompt to `<agentDir>/prompt-history.jsonl` (one JSON line per entry, shared
 * schema with cc-haha's `history.jsonl`) and lists it back scoped by project
 * and/or session — the server side of the cc-haha `promptHistoryApi` contract.
 *
 * The file is append-only: `appendFileSync` with flag `"a"` never truncates, so
 * a crash mid-write leaves at most a partial last line, which `listPromptHistory`
 * skips on parse failure. This is the same append-only pattern pi's
 * `lib/background-jobs/store.ts` and `lib/scheduled-tasks/store.ts` rely on.
 */

export const DEFAULT_PROMPT_HISTORY_LIMIT = 100;
export const MAX_PROMPT_HISTORY_LIMIT = 200;
const MAX_DISPLAY_LENGTH = 100_000;

export type PromptHistoryItem = {
  display: string;
  timestamp: number;
  sessionId?: string;
};

export type ListPromptHistoryOptions = {
  project?: string;
  projectRoot?: string;
  sessionId?: string;
  limit?: number;
  sessionOnly?: boolean;
};

export type AppendPromptHistoryInput = {
  display: string;
  project?: string;
  sessionId?: string;
  timestamp?: number;
};

type HistoryLogEntry = {
  display: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
};

/** `<agentDir>/prompt-history.jsonl` — the shared prompt log. */
export function getPromptHistoryFilePath(): string {
  return join(getAgentDir(), "prompt-history.jsonl");
}

/**
 * Normalize a project path to the canonical comparison key. `resolve` makes the
 * path absolute and platform-correct (so `C:/a/b` and `C:\a\b` match on
 * Windows), `normalize("NFC")` keeps the same Unicode form on both sides.
 */
function normalizeProjectPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return resolve(trimmed).normalize("NFC");
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_PROMPT_HISTORY_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(limit), MAX_PROMPT_HISTORY_LIMIT));
}

function parseLine(line: string): HistoryLogEntry | null {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entry = parsed as HistoryLogEntry;
    if (typeof entry.display !== "string" || entry.display.trim().length === 0) return null;
    return entry;
  } catch {
    // A partial line from a crash mid-append is skipped, not fatal.
    return null;
  }
}

/**
 * Reads prompt history from `<agentDir>/prompt-history.jsonl`, newest-first.
 *
 * Current-session entries come first (newest-first), followed by other sessions
 * in the same project (newest-first), within the bounded `limit` window — the
 * same ordering cc-haha's TUI Up/Down history uses. Fails closed when neither a
 * project nor a session scope is given, so an unscoped request cannot enumerate
 * prompts across every project on disk.
 */
export function listPromptHistory(
  options: ListPromptHistoryOptions = {},
): PromptHistoryItem[] {
  const limit = clampLimit(options.limit);
  const sessionId = options.sessionId?.trim() || undefined;
  const sessionOnly = options.sessionOnly === true;
  const acceptedProjects = new Set<string>();
  const normalizedProject = normalizeProjectPath(options.project);
  const normalizedProjectRoot = normalizeProjectPath(options.projectRoot);
  if (normalizedProject) acceptedProjects.add(normalizedProject);
  if (normalizedProjectRoot) acceptedProjects.add(normalizedProjectRoot);

  if (sessionOnly && !sessionId) return [];
  if (acceptedProjects.size === 0 && !sessionId) return [];

  const currentSessionRaw: HistoryLogEntry[] = [];
  const otherSessionRaw: HistoryLogEntry[] = [];

  try {
    const content = readFileSync(getPromptHistoryFilePath(), "utf8");
    const lines = content.split("\n");
    // Iterate newest-first (the file is append-only, so the tail is newest).
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (!entry) continue;

      const matchesSession = Boolean(sessionId && entry.sessionId === sessionId);
      if (sessionOnly) {
        if (!matchesSession) continue;
      } else if (acceptedProjects.size > 0) {
        const entryProject = typeof entry.project === "string"
          ? normalizeProjectPath(entry.project)
          : null;
        const matchesProject = Boolean(entryProject && acceptedProjects.has(entryProject));
        if (!matchesSession && !matchesProject) continue;
      } else if (sessionId) {
        if (!matchesSession) continue;
      }

      if (matchesSession) currentSessionRaw.push(entry);
      else otherSessionRaw.push(entry);

      if (currentSessionRaw.length + otherSessionRaw.length >= limit) break;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const ordered = [...currentSessionRaw, ...otherSessionRaw].slice(0, limit);
  return ordered.map((entry) => ({
    display: entry.display,
    timestamp: typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : 0,
    ...(typeof entry.sessionId === "string" && entry.sessionId ? { sessionId: entry.sessionId } : {}),
  }));
}

/**
 * Appends a desktop prompt submission to `<agentDir>/prompt-history.jsonl`.
 * Append-only: the file is never rewritten, so a crash cannot truncate prior
 * history. An empty/whitespace display is dropped (nothing worth recalling).
 */
export function appendPromptHistory(input: AppendPromptHistoryInput): void {
  const display = input.display.trimEnd();
  if (!display.trim()) return;

  const cappedDisplay = display.length > MAX_DISPLAY_LENGTH
    ? display.slice(0, MAX_DISPLAY_LENGTH)
    : display;

  const project = normalizeProjectPath(input.project) ?? "";
  const sessionId = input.sessionId?.trim() || undefined;
  const timestamp = typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
    ? input.timestamp
    : Date.now();

  const entry: HistoryLogEntry = {
    display: cappedDisplay,
    timestamp,
    project,
    ...(sessionId ? { sessionId } : {}),
  };

  const path = getPromptHistoryFilePath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}
