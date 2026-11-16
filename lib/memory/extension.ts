/**
 * 长期记忆的 pi 扩展：`memory` 工具 + `context_with_system` 注入。
 *
 * - 工具：`memory`（action: add | list | update | delete）。模型自己决定何时读写；
 *   每次 execute 返回的对象都带 `details`（满足本仓「扩展工具必须带 details」的约定）。
 * - 注入：`context_with_system` 在请求前把「长期记忆」清单塞进**首条 system 消息的
 *   `sections`**（SDK 的 section 约定：`<name>…</name>` 自含标题，见
 *   `dist/core/system-prompt.js` 的 buildSystemPromptSections）。只在有记忆时注入，
 *   最多 30 条、每条截断 200 字符并给出总数提示；**只读 messages 的 system 部分，
 *   返回 undefined**，绝不吞掉会话消息。
 *
 * **不在这里注册 builtin**：`lib/pi-extension-builtins.ts` 由 integrator 接线（`pi-memory`）。
 */
import { Type } from "typebox";
import type {
  ContextWithSystemEvent,
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";

/** `context_with_system` 的 messages 元素（SDK 未从根导出 AgentMessage，这里按事件取型）。 */
type ContextMessage = ContextWithSystemEvent["messages"][number];
import {
  MEMORY_INJECT_MAX_CHARS,
  MEMORY_INJECT_MAX_ENTRIES,
  type MemoryEntry,
  type MemoryStore,
  createMemoryStore,
} from "./store";

/** 注入 system prompt 的截面名。 */
export const MEMORY_SECTION = "long-term-memory";
/** 工具名（模型可见）。 */
export const MEMORY_TOOL_NAME = "memory";
/** 隐藏扩展名（`hidden: true`，不占 `builtin:` 名单）。 */
export const MEMORY_EXTENSION_NAME = "pi-web-memory";

export type MemoryToolAction = "add" | "list" | "update" | "delete";

export interface MemoryToolDetails {
  action: MemoryToolAction;
  /** 本次操作后的相关条目（list 为全量，其余为受影响条目）。 */
  entries: MemoryEntry[];
  total: number;
}

export interface MemoryExtensionOptions {
  /** 存储口；缺省走 `createMemoryStore()`（`<agent dir>/pi-web/memory.json`）。 */
  store?: MemoryStore;
  /** 注入闸覆盖（测试用）。 */
  maxEntries?: number;
  maxChars?: number;
}

/** 单条注入行：`- (tag, tag) 正文`，正文截断到 maxChars 个字符。 */
function memoryLine(entry: MemoryEntry, maxChars: number): string {
  const chars = Array.from(entry.text);
  const clipped = chars.length > maxChars ? `${chars.slice(0, maxChars).join("").trimEnd()}…` : entry.text;
  const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
  return `- ${clipped}${tags}`;
}

/**
 * 长期记忆段落。`entries` 为空返回 null（调用方据此不注入）。
 * 只列最近的 `maxEntries` 条（按 updatedAt 倒序），并说明总数，免得模型把清单当全部。
 */
export function buildMemorySection(
  entries: readonly MemoryEntry[],
  maxEntries: number = MEMORY_INJECT_MAX_ENTRIES,
  maxChars: number = MEMORY_INJECT_MAX_CHARS,
): string | null {
  if (entries.length === 0) return null;
  const recent = [...entries]
    .sort((a, b) => (b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt)))
    .slice(0, maxEntries);
  const lines = recent.map((entry) => memoryLine(entry, maxChars));
  const header = [
    "## Long-term memory",
    "Facts the user asked you to remember across sessions. Respect them; do not repeat them back unprompted.",
    `Use the \`${MEMORY_TOOL_NAME}\` tool (action add / list / update / delete) when the user asks you to remember, correct or forget something.`,
  ];
  if (entries.length > recent.length) {
    header.push(`Showing ${recent.length} of ${entries.length} memories (most recently updated first). Use \`${MEMORY_TOOL_NAME}\` action list to see all.`);
  } else {
    header.push(`All ${entries.length} ${entries.length === 1 ? "memory" : "memories"}.`);
  }
  return [...header, ...lines].join("\n");
}

/** 把段落并入首条 system 消息的 sections；无首条 system 或段落为空时原样返回。 */
export function injectMemoryIntoMessages(
  messages: readonly ContextMessage[],
  section: string | null,
): ContextMessage[] {
  if (!section) return messages as ContextMessage[];
  const head = messages[0];
  if (!head || head.role !== "system") return messages as ContextMessage[];
  const next: ContextMessage = {
    ...head,
    sections: { ...(head.sections ?? {}), [MEMORY_SECTION]: section },
  };
  return [next, ...messages.slice(1)];
}

/** 工具返回的条目视图：正文原样、不带多余字段（模型与 details 共用同一形状）。 */
function summarizeEntries(entries: MemoryEntry[], limit = 200): string {
  if (entries.length === 0) return "No memories.";
  return entries.slice(0, limit).map((entry, index) => `${index + 1}. [${entry.id}] ${entry.text}`).join("\n");
}

export function createMemoryExtension(options: MemoryExtensionOptions = {}): InlineExtension {
  const store = options.store ?? createMemoryStore();
  const maxEntries = options.maxEntries ?? MEMORY_INJECT_MAX_ENTRIES;
  const maxChars = options.maxChars ?? MEMORY_INJECT_MAX_CHARS;

  return {
    name: MEMORY_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: MEMORY_TOOL_NAME,
        label: "Memory",
        description: `Read or change the user's long-term memory: short facts kept across sessions. Actions: add (save a new memory), list (show all), update (rewrite one by id), delete (remove one by id). Only store what the user asked you to remember, or a durable preference they stated; never secrets or one-off task details.`,
        promptSnippet: "Save or recall facts the user wants kept across sessions",
        parameters: Type.Object({
          action: Type.Union(
            [Type.Literal("add"), Type.Literal("list"), Type.Literal("update"), Type.Literal("delete")],
            { description: "add: save a new memory. list: show every memory. update: rewrite one by id. delete: remove one by id." },
          ),
          text: Type.Optional(Type.String({
            description: "The memory text (add, update). One self-contained sentence or two; at most 4 KB.",
          })),
          id: Type.Optional(Type.String({ description: "Memory id (update, delete), as shown by list." })),
          tags: Type.Optional(Type.Array(Type.String(), {
            description: "Optional short labels (add, update). At most 10.",
          })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const action = params.action as MemoryToolAction;
          const fail = (text: string, details: MemoryToolDetails): {
            content: { type: "text"; text: string }[];
            details: MemoryToolDetails;
            isError: true;
          } => ({ content: [{ type: "text", text }], details, isError: true });
          try {
            if (action === "list") {
              const entries = store.list();
              const details: MemoryToolDetails = { action, entries, total: entries.length };
              return { content: [{ type: "text", text: summarizeEntries(entries) }], details };
            }
            if (action === "add") {
              const entry = store.add({
                text: params.text,
                tags: params.tags,
                ...(ctx?.sessionManager?.getSessionId?.() ? { sourceSessionId: ctx.sessionManager.getSessionId() } : {}),
              });
              const entries = store.list();
              const details: MemoryToolDetails = { action, entries: [entry], total: entries.length };
              return { content: [{ type: "text", text: `Saved memory ${entry.id}: ${entry.text}` }], details };
            }
            const id = typeof params.id === "string" ? params.id.trim() : "";
            if (!id) {
              return fail(`A memory id is required for ${action}. Call list to see ids.`, { action, entries: [], total: store.list().length });
            }
            if (action === "update") {
              const updated = store.update(id, { text: params.text, tags: params.tags });
              if (!updated) return fail(`No memory with id ${id}.`, { action, entries: [], total: store.list().length });
              const details: MemoryToolDetails = { action, entries: [updated], total: store.list().length };
              return { content: [{ type: "text", text: `Updated memory ${updated.id}: ${updated.text}` }], details };
            }
            const removed = store.remove(id);
            const entries = store.list();
            const details: MemoryToolDetails = { action, entries: removed ? entries : [], total: entries.length };
            return removed
              ? { content: [{ type: "text", text: `Deleted memory ${id}.` }], details }
              : fail(`No memory with id ${id}.`, { action, entries: [], total: entries.length });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return fail(message, { action, entries: [], total: 0 });
          }
        },
      });

      pi.on("context_with_system", (event: ContextWithSystemEvent) => {
        let entries: MemoryEntry[];
        try {
          entries = store.list();
        } catch {
          // 读不动记忆时静默跳过注入：一条坏文件不该拦住请求。
          return undefined;
        }
        const section = buildMemorySection(entries, maxEntries, maxChars);
        if (!section) return undefined;
        const messages = injectMemoryIntoMessages(event.messages, section);
        if (messages === event.messages) return undefined;
        return { messages };
      });
    },
  };
}