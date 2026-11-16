/**
 * 长期记忆（long-term memory）的**磁盘存储**：跨会话保留用户可见、可编辑的条目。
 *
 * - 文件：`<agent dir>/pi-web/memory.json`，与 `lib/artifact-settings.ts` 的
 *   `settings.json` 同源同一目录（`getAgentDir()` 派生的 `pi-web/`），但独立成文件：
 *   记忆可能被模型频繁写入，不能和设置文件的读-改-写互相覆盖。
 * - 结构：`{ version: 1, entries: MemoryEntry[] }`；`id` 用 `crypto.randomUUID`。
 * - 约束：`text` 非空、单条 ≤ 4 KB（UTF-8 字节）、最多 200 条；`tags` 最多 10 个、
 *   每个 ≤ 64 字符。越界一律抛 `MemoryValidationError`（不改盘、不静默丢数据）。
 * - 写盘：`writePrivateFileAtomicSync`（tmp+rename，0600），读-改-写整体重试一次；
 *   文件损坏时**抛错而不是当作空文件**，下次写入才不会把用户的记忆整盘抹掉。
 * - 本模块含 `node:fs`，客户端组件不要 import；前端类型自行声明。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";

export const MEMORY_VERSION = 1 as const;
/** 条目上限（超出后拒绝新增，而不是静默淘汰旧记忆）。 */
export const MEMORY_MAX_ENTRIES = 200;
/** 单条正文上限（UTF-8 字节）。 */
export const MEMORY_MAX_TEXT_BYTES = 4096;
export const MEMORY_MAX_TAGS = 10;
export const MEMORY_MAX_TAG_CHARS = 64;
/** 注入 system prompt 的条数 / 每条字符上限（成本闸，见 extension.ts）。 */
export const MEMORY_INJECT_MAX_ENTRIES = 30;
export const MEMORY_INJECT_MAX_CHARS = 200;

export interface MemoryEntry {
  id: string;
  text: string;
  /** ISO-8601（UTC）。 */
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  /** 由模型工具写入时记下来源会话；用户从设置页添加时没有。 */
  sourceSessionId?: string;
}

export interface MemoryFile {
  version: typeof MEMORY_VERSION;
  entries: MemoryEntry[];
}

/** 可预期的输入错误（路由 → 400，工具 → isError）。 */
export class MemoryValidationError extends Error {
  readonly code = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

export function isMemoryValidationError(error: unknown): error is MemoryValidationError {
  return error instanceof MemoryValidationError;
}

/** `<agent dir>/pi-web/memory.json`；与 Pi Web 设置文件同源。 */
export function memoryFilePath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "memory.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 磁盘 JSON → MemoryFile 守卫。坏结构一律抛错，绝不把用户记忆当空文件吞掉。 */
export function asMemoryFile(value: unknown, source = "memory.json"): MemoryFile {
  if (!isRecord(value)) throw new Error(`Invalid memory file ${source}: expected an object`);
  if (value.version !== MEMORY_VERSION) {
    throw new Error(`Invalid memory file ${source}: unsupported version ${JSON.stringify(value.version)}`);
  }
  if (!Array.isArray(value.entries)) {
    throw new Error(`Invalid memory file ${source}: entries must be an array`);
  }
  const entries = value.entries.map((entry, index): MemoryEntry => {
    if (!isRecord(entry)
      || typeof entry.id !== "string" || entry.id.length === 0
      || typeof entry.text !== "string"
      || typeof entry.createdAt !== "string"
      || typeof entry.updatedAt !== "string"
      || (entry.tags !== undefined && !isStringArray(entry.tags))
      || (entry.sourceSessionId !== undefined && typeof entry.sourceSessionId !== "string")) {
      throw new Error(`Invalid memory file ${source}: entry ${index} is malformed`);
    }
    return {
      id: entry.id,
      text: entry.text,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.tags === undefined ? {} : { tags: [...entry.tags] }),
      ...(entry.sourceSessionId === undefined ? {} : { sourceSessionId: entry.sourceSessionId }),
    };
  });
  return { version: MEMORY_VERSION, entries };
}

export function readMemoryFile(filePath = memoryFilePath()): MemoryFile {
  if (!existsSync(filePath)) return { version: MEMORY_VERSION, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid memory file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return asMemoryFile(parsed, filePath);
}

export function writeMemoryFile(file: MemoryFile, filePath = memoryFilePath()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writePrivateFileAtomicSync(filePath, JSON.stringify(file, null, 2));
}

/** 正文归一化：trim、非空、≤ 4 KB。 */
export function normalizeMemoryText(raw: unknown): string {
  if (typeof raw !== "string") throw new MemoryValidationError("text must be a string");
  const text = raw.trim();
  if (!text) throw new MemoryValidationError("text must not be empty");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MEMORY_MAX_TEXT_BYTES) {
    throw new MemoryValidationError(`text must be at most ${MEMORY_MAX_TEXT_BYTES} bytes (got ${bytes})`);
  }
  return text;
}

/**
 * 标签归一化：`undefined`/`null` → 未提供（不改）；数组 → trim、去空、去重（可能为空数组，
 * 表示显式清空）。非字符串、超长、超量一律拒绝。
 */
export function normalizeMemoryTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new MemoryValidationError("tags must be an array of strings");
  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== "string") throw new MemoryValidationError("tags must be an array of strings");
    const trimmed = tag.trim();
    if (!trimmed) continue;
    if (Array.from(trimmed).length > MEMORY_MAX_TAG_CHARS) {
      throw new MemoryValidationError(`each tag must be at most ${MEMORY_MAX_TAG_CHARS} characters`);
    }
    if (!tags.includes(trimmed)) tags.push(trimmed);
  }
  if (tags.length > MEMORY_MAX_TAGS) {
    throw new MemoryValidationError(`at most ${MEMORY_MAX_TAGS} tags per memory`);
  }
  return tags;
}

export interface MemoryEntryInput {
  text: unknown;
  tags?: unknown;
  sourceSessionId?: string;
}

export interface MemoryEntryPatch {
  text?: unknown;
  tags?: unknown;
}

/** 路由与扩展共用的存储口；测试可注入内存实现。 */
export interface MemoryStore {
  readonly filePath: string;
  list(): MemoryEntry[];
  add(input: MemoryEntryInput): MemoryEntry;
  update(id: string, patch: MemoryEntryPatch): MemoryEntry | null;
  remove(id: string): boolean;
}

export interface MemoryStoreOptions {
  /** 默认 `memoryFilePath()`；测试传临时文件。 */
  filePath?: string;
  now?: () => Date;
  newId?: () => string;
}

/** 读-改-写；I/O 或解析失败整体重试一次，输入校验错误不重试。 */
function mutateMemoryFile<T>(
  filePath: string,
  mutate: (file: MemoryFile) => { file: MemoryFile; result: T },
): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { file, result } = mutate(readMemoryFile(filePath));
      writeMemoryFile(file, filePath);
      return result;
    } catch (error) {
      if (error instanceof MemoryValidationError) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const filePath = options.filePath ?? memoryFilePath();
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());

  return {
    filePath,

    list() {
      return readMemoryFile(filePath).entries;
    },

    add(input) {
      const text = normalizeMemoryText(input.text);
      const tags = normalizeMemoryTags(input.tags);
      const sourceSessionId = typeof input.sourceSessionId === "string" && input.sourceSessionId.trim()
        ? input.sourceSessionId
        : undefined;
      return mutateMemoryFile(filePath, (file) => {
        if (file.entries.length >= MEMORY_MAX_ENTRIES) {
          throw new MemoryValidationError(`memory is full: at most ${MEMORY_MAX_ENTRIES} entries`);
        }
        const timestamp = now().toISOString();
        const entry: MemoryEntry = {
          id: newId(),
          text,
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
          ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
        };
        return { file: { version: MEMORY_VERSION, entries: [...file.entries, entry] }, result: entry };
      });
    },

    update(id, patch) {
      const text = patch.text === undefined ? undefined : normalizeMemoryText(patch.text);
      const tags = normalizeMemoryTags(patch.tags);
      if (text === undefined && tags === undefined) {
        throw new MemoryValidationError("nothing to update: give text or tags");
      }
      return mutateMemoryFile(filePath, (file) => {
        const index = file.entries.findIndex((entry) => entry.id === id);
        if (index < 0) return { file, result: null };
        const current = file.entries[index];
        const next: MemoryEntry = { ...current, updatedAt: now().toISOString() };
        if (text !== undefined) next.text = text;
        if (tags !== undefined) {
          if (tags.length > 0) next.tags = tags;
          else delete next.tags;
        }
        const entries = [...file.entries];
        entries[index] = next;
        return { file: { version: MEMORY_VERSION, entries }, result: next };
      });
    },

    remove(id) {
      return mutateMemoryFile(filePath, (file) => {
        const entries = file.entries.filter((entry) => entry.id !== id);
        if (entries.length === file.entries.length) return { file, result: false };
        return { file: { version: MEMORY_VERSION, entries }, result: true };
      });
    },
  };
}