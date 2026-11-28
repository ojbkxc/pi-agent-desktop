import type { AgentMessage, UserMessage } from "./types";
import type { ChatDraftImage } from "./draft-store";
import { MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits } from "./image-attachments";
import { userImageDisplayText } from "./user-image-display";

/** One composer-history row: the user's own text, without SDK transport notes,
 * plus the images that were attached to it. */
export interface ComposerHistoryEntry {
  text: string;
  images: ChatDraftImage[];
}

const MAX_HISTORY_ENTRIES = 50;

function historyImages(message: UserMessage): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];
    // Current nested format plus the older flat pi-ai entries.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];
    const image = { data, mimeType };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  }).slice(0, MAX_ATTACHED_IMAGES);
}

function historyText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Build the ↑/history menu from the transcript, newest last.
 *
 * Reuses the same projection as the message bubble so an SDK image resize note
 * never comes back as typed text, and keeps the prompt's images so selecting an
 * earlier image question restores its attachments instead of dropping them.
 * Entries without text survive when they carried images (an image-only prompt);
 * identical prompts are listed once.
 */
export function buildComposerHistory(messages: AgentMessage[], limit = MAX_HISTORY_ENTRIES): ComposerHistoryEntry[] {
  const seen = new Set<string>();
  const history: ComposerHistoryEntry[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const images = historyImages(message as UserMessage);
    const text = userImageDisplayText(historyText(message as UserMessage), images.length).trim();
    if (!text && images.length === 0) continue;
    // Text alone identifies ordinary prompts. Include every image's complete
    // MIME/data payload so same-text prompts with different screenshots remain
    // selectable; a short prefix would incorrectly merge visually different
    // images that share common encoded headers.
    const imageKey = images.map((image) => `${image.mimeType}:${image.data}`).join("\u0001");
    const key = `${text}\u0000${imageKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    history.push({ text, images });
    if (history.length >= limit) break;
  }
  return history.reverse();
}

/**
 * Merge the current session's transcript-derived entries with cross-session
 * server history into the single newest-first list the composer's ↑/↓ walks
 * (ISSUE-11).
 *
 * Ordering mirrors cc-haha's `mergePromptHistoryEntries`: current-session entries
 * (transcript, with their images) come first, then persisted current-session
 * entries not already covered by the transcript, then other sessions in the same
 * project. Duplicates collapse on trimmed text, so a prompt recalled from the
 * server never shadows the richer transcript entry (which carries its images).
 */
export function mergeComposerHistory(params: {
  sessionEntries: readonly ComposerHistoryEntry[];
  serverEntries: readonly { display: string; sessionId?: string }[];
  sessionId?: string | null;
  includeProjectHistory?: boolean;
  limit?: number;
}): ComposerHistoryEntry[] {
  const limit = params.limit ?? MAX_HISTORY_ENTRIES;
  const sessionId = params.sessionId?.trim() || null;
  const result: ComposerHistoryEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: ComposerHistoryEntry): boolean => {
    if (result.length >= limit) return false;
    const text = entry.text.trim();
    if (!text) return false;
    if (seen.has(text)) return false;
    seen.add(text);
    result.push({ text, images: entry.images });
    return true;
  };

  // Phase 1: current-session transcript entries (newest-first, images kept).
  for (const entry of params.sessionEntries) push(entry);

  // Phase 2: persisted current-session entries the transcript did not cover
  // (e.g. older turns beyond the transcript window, or an append that landed
  // after the transcript was built).
  if (sessionId) {
    for (const item of params.serverEntries) {
      if (item.sessionId !== sessionId) continue;
      push({ text: item.display, images: [] });
    }
  }

  // Phase 3: other sessions in the same project.
  if (params.includeProjectHistory) {
    for (const item of params.serverEntries) {
      if (sessionId && item.sessionId === sessionId) continue;
      push({ text: item.display, images: [] });
    }
  }

  return result;
}
