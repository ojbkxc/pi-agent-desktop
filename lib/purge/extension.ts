/**
 * Purge Console data plane for Pi Web — the `pi` extension half of
 * `src/purge/mod.rs`.
 *
 * AIGX rewrites the outgoing request right before the provider call. Pi gives a
 * host two supported seams, and this extension uses only those:
 *
 * - `before_agent_start` returns `{ systemPrompt }`, which the SDK sends as the
 *   request's leading system prompt while the transcript keeps Pi's structured
 *   sections (the same seam `lib/exact-system-prompt.ts` documents).
 * - `context` runs before every LLM call and may return a **new** `messages`
 *   array. The transcript is never mutated, which is exactly what AIGX's
 *   "govern the wire, not the record" rule requires: every request is governed
 *   from its pristine text, so a tool loop that calls the provider five times
 *   still appends the structured suffix once.
 *
 * Settings are read on every event, so saving the console applies to the next
 * request without a session reload. Nothing here is session-scoped: there is no
 * `session_start` handler, because the configuration is global and no state is
 * cached across sessions.
 *
 * 自动套用（`auto_preset`）也走这一条路：模型标识由宿主注入的 `readModel` 每次现读，
 * 命中的预设正文原样拼在治理后的系统提示词上。关掉开关就是零改动。
 */

import type { ContextEvent, ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { readPurgeSettings } from "../purge-settings";
import { composeAutoPreset, resolveAutoPreset } from "./auto-apply";
import { governSystemText, governUserText } from "./governance";
import { BUILTIN_PRESETS } from "./preset-catalog";
import { recordPurgeTurn } from "./stats";
import type { PurgeSettings } from "./types";

export const PURGE_EXTENSION_NAME = "pi-web-purge";

/** `context` messages, typed off the event because the SDK does not export `AgentMessage` from its root. */
type ContextMessage = ContextEvent["messages"][number];

/** Thinking levels low → high. `off` is the floor a request can be clamped down to. */
const THINKING_RANK: Readonly<Record<string, number>> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

function thinkingRank(level: unknown): number | undefined {
  return typeof level === "string" ? THINKING_RANK[level.trim().toLowerCase()] : undefined;
}

export interface PurgeExtensionOptions {
  /** Defaults to reading the `purge` block of Pi Web's settings file on every event. */
  readSettings?: () => PurgeSettings;
  /**
   * 当前会话的模型标识，自动套用预设时用来查目录。
   *
   * 由宿主注入：`before_agent_start` 的事件里没有模型字段，而模型可以在会话中途
   * 被换掉，所以这里必须是每次调用现读的函数，不能是构造时的快照。返回空串或
   * undefined 时自动套用不生效（其余治理照常）。
   */
  readModel?: () => string | undefined;
}

/** The last user text in the request plus a copy-on-write way to replace it. */
interface LastUserText {
  index: number;
  text: string;
  /** A new message object carrying `next`; the one in `messages` is left untouched. */
  withText: (next: string) => ContextMessage;
}

/**
 * Find the newest `role === "user"` message that carries text, scanning backwards.
 *
 * Content may be a plain string or a block array; in the array case the *last*
 * text block is the governed one, and image/tool blocks keep their positions.
 * Messages without usable text are skipped rather than ending the search.
 */
function findLastUserText(messages: readonly ContextMessage[]): LastUserText | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown as { role?: unknown; content?: unknown };
    if (!message || message.role !== "user") continue;
    const content = message.content;

    if (typeof content === "string") {
      if (content.trim().length === 0) continue;
      return {
        index,
        text: content,
        withText: (next) => ({ ...(message as object), content: next }) as unknown as ContextMessage,
      };
    }
    if (!Array.isArray(content)) continue;

    let textIndex = -1;
    let text = "";
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex] as { type?: unknown; text?: unknown } | undefined;
      if (block && block.type === "text" && typeof block.text === "string") {
        textIndex = blockIndex;
        text = block.text;
        break;
      }
    }
    if (textIndex < 0 || text.trim().length === 0) continue;

    return {
      index,
      text,
      withText: (next) => {
        const blocks = content.slice();
        blocks[textIndex] = { ...(blocks[textIndex] as object), text: next };
        return { ...(message as object), content: blocks } as unknown as ContextMessage;
      },
    };
  }
  return undefined;
}

/**
 * The `before_agent_start` half: govern the system prompt, apply the preset the
 * current model is written for (when that switch is on) and, when asked, clamp an
 * explicit high reasoning level down to `reasoning_floor`.
 *
 * Order matters twice:
 *
 * - 治理（归一化/改写）只跑在宿主提示词上，预设正文随后原样拼接，第三方 prompt
 *   因此永远不会被词表改写成另一个版本。
 * - 自动套用排在治理之后、返回之前：返回的 `systemPrompt` 是整体替换，最后拼上
 *   的那份就是真正发出去的那份。
 *
 * Returns `undefined` when the console is off, so the host sends its own prompt
 * unchanged. Other extensions may also return `systemPrompt` (exact prompt,
 * `pi-purge`); this handler only governs the text it was handed.
 */
function handleBeforeAgentStart(
  pi: ExtensionAPI,
  event: { systemPrompt?: unknown },
  readSettings: () => PurgeSettings,
  readModel: (() => string | undefined) | undefined,
): { systemPrompt: string } | undefined {
  try {
    const settings = readSettings();
    if (!settings || settings.enabled !== true) return undefined;
    if (typeof event.systemPrompt !== "string") return undefined;

    const governed = governSystemText(event.systemPrompt, settings);
    let text = governed.text;
    let autoApplies = 0;
    if (settings.auto_preset) {
      const model = readModel ? readModel() : undefined;
      const hit = resolveAutoPreset(BUILTIN_PRESETS, settings, typeof model === "string" ? model : "");
      if (hit) {
        const composed = composeAutoPreset(text, hit.preset.body, settings.auto_preset_mode);
        if (composed !== text) autoApplies = 1;
        text = composed;
      }
    }

    let clamps = 0;
    if (settings.reduce_reasoning) {
      const current = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
      const currentRank = thinkingRank(current);
      const floorRank = thinkingRank(settings.reasoning_floor);
      // Only ever down-clamp: never raise a request the user made cheaper, never invent a level.
      if (currentRank !== undefined && floorRank !== undefined && currentRank > floorRank) {
        pi.setThinkingLevel(settings.reasoning_floor);
        clamps = 1;
      }
    }

    recordPurgeTurn({
      rewrite_hits: governed.rewrite_hits,
      synonym_hits: governed.synonym_hits,
      skill_hits: governed.skill_hits,
      reasoning_clamps: clamps,
      structured_appends: 0,
      auto_preset_hits: autoApplies,
    });

    return { systemPrompt: text };
  } catch {
    // The governance layer must never take a session down: fall back to the host's prompt.
    return undefined;
  }
}

/**
 * The `context` half: govern the last user text and return a fresh message array.
 *
 * The passed-in array and its message objects are never mutated (the transcript
 * is built from them); the replacement is a shallow copy with one new text.
 */
function handleContext(
  event: ContextEvent,
  readSettings: () => PurgeSettings,
): { messages: ContextMessage[] } | undefined {
  try {
    const settings = readSettings();
    if (!settings || settings.enabled !== true) return undefined;
    if (!Array.isArray(event.messages)) return undefined;

    const target = findLastUserText(event.messages);
    if (!target) return undefined;

    const governed = governUserText(target.text, settings);
    recordPurgeTurn({
      rewrite_hits: governed.rewrite_hits,
      synonym_hits: governed.synonym_hits,
      skill_hits: governed.skill_hits,
      reasoning_clamps: 0,
      structured_appends: governed.structured ? 1 : 0,
    });
    if (governed.text === target.text) return undefined;

    const messages = event.messages.slice();
    messages[target.index] = target.withText(governed.text);
    return { messages };
  } catch {
    return undefined;
  }
}

/**
 * Build the Purge Console extension. Settings are read on every event (the
 * `readSettings` override exists for tests), so a console save takes effect on
 * the next request without restarting the session.
 */
export function createPurgeExtension(options: PurgeExtensionOptions = {}): InlineExtension {
  const readSettings = options.readSettings ?? readPurgeSettings;
  const readModel = options.readModel;
  return {
    name: PURGE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => handleBeforeAgentStart(pi, event, readSettings, readModel));
      pi.on("context", (event) => handleContext(event, readSettings));
    },
  };
}
