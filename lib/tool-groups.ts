/**
 * Tool-call grouping, the way cc-haha summarises a turn's tool activity.
 *
 * cc-haha does not render one heavy card per call. It folds a run of tool calls
 * into one line — `读取 2 个文件、运行 1 条命令` — and only shows the individual
 * cards when the line is expanded. The wording table here is copied from its
 * bundle (`toolGroup.*`), and the category rules decide two separate things:
 *
 *   - `toolCategory`: which verb a call folds under in a summary line. Edits
 *     count here even though their card is never folded (the diff is the point
 *     of an edit, so it keeps one-click reach).
 *   - `toolGroupCategory`: whether a call's card may be folded into an inline
 *     summary row. Specialised views (edit diff, apply-patch, codemode, MCP,
 *     subagent) return `null` and render on their own, unchanged.
 */

import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "./tool-names";

export type ToolCategory =
  | "read"
  | "write"
  | "edit"
  | "run"
  | "search"
  | "glob"
  | "fetch"
  | "websearch"
  | "agent"
  | "todo"
  | "task";

export interface ToolSummaryInput {
  toolName: string;
  input?: unknown;
}

export interface ToolSummarySegment {
  category: ToolCategory;
  count: number;
}

/** Tool names that map straight to a category; decorated forms go through the predicates below. */
const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  read: "read",
  bash: "run",
  shell: "run",
  powershell: "run",
  grep: "search",
  glob: "glob",
  find: "glob",
  ls: "glob",
  web_fetch: "fetch",
  webfetch: "fetch",
  web_search: "websearch",
  websearch: "websearch",
  agent: "agent",
  task: "agent",
  subagent: "agent",
  todo_write: "todo",
  todowrite: "todo",
  taskcreate: "task",
  taskupdate: "task",
  tasklist: "task",
  taskget: "task",
};

/**
 * The summary verb bucket for a tool, or `null` when the tool has no verb of
 * its own (an unknown/extension tool, an MCP tool labelled `server/tool`, a
 * `team_create` node, ...). MCP tools are excluded because their label is
 * `server/tool`, which the summary wording cannot express.
 */
export function toolCategory(toolName: string): ToolCategory | null {
  const name = toolName.trim().toLowerCase();
  if (!name) return null;
  if (name.startsWith("mcp__")) return null;
  if (name === "codemode") return null;
  if (isApplyPatchToolName(toolName)) return null;
  if (isEditToolName(toolName)) return "edit";
  if (isWriteToolName(toolName)) return "write";
  return CATEGORY_BY_NAME[name] ?? null;
}

/** Categories whose card folds into an inline summary row. Edit and agent keep their own cards. */
const INLINE_GROUPABLE: ReadonlySet<ToolCategory> = new Set<ToolCategory>([
  "read",
  "write",
  "run",
  "search",
  "glob",
  "fetch",
  "websearch",
  "todo",
  "task",
]);

/**
 * The grouping bucket for a card that may be folded, or `null` when the call
 * must render on its own. Use this — not `toolCategory` — to decide grouping,
 * so the diff / codemode / MCP / subagent views stay one click away.
 */
export function toolGroupCategory(toolName: string): ToolCategory | null {
  const category = toolCategory(toolName);
  return category !== null && INLINE_GROUPABLE.has(category) ? category : null;
}

/** A tool's `file_path`/`path`, for deduping repeated edits to one file. */
function editFilePath(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  for (const key of ["file_path", "path"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * A turn's calls as ordered `{ category, count }` segments.
 *
 * Edits to the same file count once (cc-haha dedupes by `file_path`), so a tool
 * that rewrites one file ten times still reads `edited 1 file`. Unknown and MCP
 * tools are skipped: they have no verb, and inventing one would be wrong.
 */
export function summarizeToolCalls(calls: readonly ToolSummaryInput[]): ToolSummarySegment[] {
  const order: ToolCategory[] = [];
  const counts = new Map<ToolCategory, number>();
  const editedFiles = new Set<string>();

  for (const call of calls) {
    const category = toolCategory(call.toolName);
    if (category === null) continue;
    if (category === "edit") {
      const file = editFilePath(call.input);
      if (file !== null) {
        if (editedFiles.has(file)) continue;
        editedFiles.add(file);
      }
    }
    if (!counts.has(category)) {
      counts.set(category, 0);
      order.push(category);
    }
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return order.map((category) => ({ category, count: counts.get(category) ?? 0 }));
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The short verb shown at the head of one call's card. Agent keeps its raw name. */
const VERB_KEY_BY_CATEGORY: Record<Exclude<ToolCategory, "agent">, string> = {
  read: "toolVerb.read",
  write: "toolVerb.write",
  edit: "toolVerb.edit",
  run: "toolVerb.run",
  search: "toolVerb.search",
  glob: "toolVerb.glob",
  fetch: "toolVerb.fetch",
  websearch: "toolVerb.websearch",
  todo: "toolVerb.todo",
  task: "toolVerb.task",
};

/** The i18n key for a call's leading verb, or `null` to keep the raw tool name (agent). */
export function toolVerbKey(category: ToolCategory | null): string | null {
  if (category === null || category === "agent") return null;
  return VERB_KEY_BY_CATEGORY[category];
}

/** One `{ category, count }` segment as its localised phrase (`读取 2 个文件`). */
export function toolSegmentLabel(segment: ToolSummarySegment, t: Translate): string {
  const { category, count } = segment;
  switch (category) {
    case "read":
      return count === 1 ? t("toolGroup.readOne") : t("toolGroup.readMany", { count });
    case "write":
      return count === 1 ? t("toolGroup.writeOne") : t("toolGroup.writeMany", { count });
    case "edit":
      return count === 1 ? t("toolGroup.editOne") : t("toolGroup.editMany", { count });
    case "run":
      return count === 1 ? t("toolGroup.runOne") : t("toolGroup.runMany", { count });
    case "search":
      return count === 1 ? t("toolGroup.searchOne") : t("toolGroup.searchMany", { count });
    case "glob":
      return t("toolGroup.globFound");
    case "fetch":
      return count === 1 ? t("toolGroup.fetchOne") : t("toolGroup.fetchMany", { count });
    case "websearch":
      return t("toolGroup.webSearch");
    case "agent":
      return count === 1 ? t("toolGroup.agentOne") : t("toolGroup.agentMany", { count });
    case "todo":
      return t("toolGroup.todo");
    case "task":
      return t("toolGroup.task");
  }
}

/** The segments joined by the locale's list separator (`、` / `, `). Empty when nothing matches. */
export function formatToolSummary(segments: readonly ToolSummarySegment[], t: Translate): string {
  return segments.map((segment) => toolSegmentLabel(segment, t)).join(t("toolGroup.separator"));
}
