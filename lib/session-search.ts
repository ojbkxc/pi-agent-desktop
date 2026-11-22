import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { getProjectDisplayNames } from "./project-display.ts";
import type { SessionInfo } from "./types";
import { escapeRegExp } from "./text-utils.ts";

const MAX_FILES = 500;
const MAX_RESULTS = 30;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const TIME_BUDGET_MS = 3000;

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  before: string;
  match: string;
  after: string;
  /** Short project label, derived from the session's project root. Optional:
   *  absent when the caller passed a SessionInfo without a projectRoot (e.g. a
   *  client-built transient session). */
  projectName?: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

/**
 * Split a query into literal needles. Whitespace separates words (all of which
 * must match, AND); a double-quoted run is kept together as one phrase, spaces
 * included. Quotes are delimiters, never part of the needle. An unbalanced
 * leading quote keeps its remainder as a phrase.
 */
export function tokenizeSearchQuery(query: string): string[] {
  const needles: string[] = [];
  let index = 0;
  while (index < query.length) {
    while (index < query.length && /\s/.test(query[index])) index += 1;
    if (index >= query.length) break;
    if (query[index] === '"') {
      index += 1;
      const start = index;
      while (index < query.length && query[index] !== '"') index += 1;
      const phrase = query.slice(start, index).trim();
      if (index < query.length) index += 1; // consume the closing quote
      if (phrase) needles.push(phrase);
    } else {
      const start = index;
      while (index < query.length && !/\s/.test(query[index])) index += 1;
      needles.push(query.slice(start, index));
    }
  }
  return needles;
}

// ponytail: scan recent files without an index; add indexing if measured latency warrants it.
export async function searchSessionContents(
  sessions: readonly SessionInfo[],
  query: string,
  requestSignal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  // Tokenize first, then escape every token: literal search, offsets in the original text.
  const matchers = tokenizeSearchQuery(needle).map((token) => new RegExp(escapeRegExp(token), "i"));
  if (matchers.length === 0) return response;
  const projectNames = getProjectDisplayNames(
    [...new Set(sessions.flatMap((session) => (session.projectRoot ? [session.projectRoot] : [])))],
  );
  const deadline = Date.now() + TIME_BUDGET_MS;
  const timeout = AbortSignal.timeout(TIME_BUDGET_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  const candidates = sessions
    .filter((session) => !session.transient && session.path)
    .sort((a, b) => b.modified.localeCompare(a.modified));

  for (const [index, session] of candidates.entries()) {
    if (index >= MAX_FILES || response.results.length >= MAX_RESULTS || signal.aborted || Date.now() >= deadline) {
      response.truncated = true;
      break;
    }
    const stream = createReadStream(session.path, { encoding: "utf8", end: MAX_FILE_BYTES - 1, signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let found = false;
    try {
      for await (const line of lines) {
        if (signal.aborted || Date.now() >= deadline) {
          response.truncated = true;
          break;
        }
        if (line.length > MAX_LINE_CHARS) {
          response.truncated = true;
          continue;
        }
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
        const content: unknown = entry.message.content;
        const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
        const textBlocks = blocks.flatMap((block, blockIndex) => block?.type === "text" && typeof block.text === "string" ? [{ text: block.text as string, blockIndex }] : []);
        const text = textBlocks.map((block) => block.text).join("\n");
        // AND semantics: every needle must occur in this entry. Anchor the
        // snippet on the earliest occurrence so the snippet stays where the
        // user's first word appeared.
        let match: RegExpExecArray | null = null;
        for (const matcher of matchers) {
          const candidate = matcher.exec(text);
          if (!candidate) {
            match = null;
            break;
          }
          if (!match || candidate.index < match.index) match = candidate;
        }
        if (!match) continue;
        const start = match.index;
        const end = start + match[0].length;
        let blockOffset = 0;
        const matchedBlock = textBlocks.find((block) => {
          const blockEnd = blockOffset + block.text.length;
          blockOffset = blockEnd + 1;
          return start <= blockEnd;
        });
        const projectName = session.projectRoot ? projectNames.get(session.projectRoot) : undefined;
        response.results.push({
          session,
          ...(typeof entry.id === "string" ? { entryId: entry.id } : {}),
          blockIndex: matchedBlock!.blockIndex,
          before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
          match: match[0].replace(/\s+/g, " "),
          after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
          ...(projectName ? { projectName } : {}),
        });
        found = true;
        break;
      }
    } catch {
      // Missing/unreadable files and interrupted reads must not hide other results.
      response.truncated = true;
    } finally {
      lines.close();
      stream.destroy();
    }
    if (!found && stream.bytesRead >= MAX_FILE_BYTES) response.truncated = true;
  }
  return response;
}
