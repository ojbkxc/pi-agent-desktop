/**
 * 会话只读探针（server-only）：读会话文件里最后一条 user 条目的 entry id。
 *
 * 为什么不用内存 wrapper：调度器可能在 wrapper 已被 10 分钟 idle 驱逐之后运行
 * （正是重启接续的主场景）；此时只有磁盘上的 `.jsonl` 才权威。
 *
 * 读法照 `lib/session-reader.ts` 的 `readLatestSessionEntryId`：只读尾部，
 * 大文件不整读；torn 尾行自动跳过。
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolveSessionPath } from "../session-reader";

/** 尾部探测窗口：64 KiB 足够覆盖若干条消息。 */
const TAIL_BYTES = 64 * 1024;

/** 一次尾部扫描读出的事实（续跑判据与探针都用它）。 */
export interface SessionTailFacts {
  /** 最后一条 user 消息的 entry id（防抢跑守卫）。 */
  lastUserMessageId: string | null;
  /** 最后一条 user 消息的文本（兜底重发；images/附件不带）。 */
  lastUserText: string | null;
  /** 最后一条 assistant 消息记录的 provider（失败来源，探针用）。 */
  provider: string | null;
  /** 最后一条 assistant 消息记录的 model id。 */
  modelId: string | null;
  /** 文件最后一条 entry 的 id（辅助判据）。 */
  leafEntryId: string | null;
}

function userTextOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("");
  return text || null;
}

/**
 * 一次尾部扫描读出续跑所需的全部事实。会话文件不存在/读不到返回全 null。
 * 只读尾部 64 KiB：比整文件解析便宜两个数量级，且调度器每 tick 都会调用。
 */
export function scanSessionTail(filePath: string): SessionTailFacts {
  const empty: SessionTailFacts = {
    lastUserMessageId: null,
    lastUserText: null,
    provider: null,
    modelId: null,
    leafEntryId: null,
  };
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return empty;
  }
  try {
    const size = statSync(filePath).size;
    if (size === 0) return empty;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    if (bytesRead === 0) return empty;
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // 起点不在行首时第一条是半行，丢掉。
    if (start > 0) lines.shift();

    const facts: SessionTailFacts = { ...empty };
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      let entry: {
        type?: unknown;
        id?: unknown;
        message?: { role?: unknown; content?: unknown; provider?: unknown; model?: unknown };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // torn 行 / 非 JSON
      }
      // 反向第一条带 id 的 entry 就是叶子（header 的 id 是 session id，不是 entry）。
      if (facts.leafEntryId === null && entry.type !== "session" && typeof entry.id === "string") {
        facts.leafEntryId = entry.id;
      }
      if (entry.type !== "message") continue;
      const role = entry.message?.role;
      if (role === "user" && facts.lastUserMessageId === null && typeof entry.id === "string") {
        facts.lastUserMessageId = entry.id;
        facts.lastUserText = userTextOf(entry.message?.content);
      } else if (role === "assistant" && facts.provider === null) {
        if (typeof entry.message?.provider === "string") facts.provider = entry.message.provider;
        if (typeof entry.message?.model === "string") facts.modelId = entry.message.model;
      }
      if (facts.lastUserMessageId !== null && facts.provider !== null) break;
    }
    return facts;
  } catch {
    return empty;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** 按会话 id 读最后一条 user 消息的 entry id；会话不存在/读不到返回 null。 */
export async function readLastUserMessageEntryId(sessionId: string): Promise<string | null> {
  const facts = await readSessionTailFacts(sessionId);
  return facts?.lastUserMessageId ?? null;
}

/** 按会话 id 读尾部事实；会话不存在/读不到返回 null。 */
export async function readSessionTailFacts(sessionId: string): Promise<SessionTailFacts | null> {
  try {
    const filePath = await resolveSessionPath(sessionId);
    return filePath ? scanSessionTail(filePath) : null;
  } catch {
    return null;
  }
}

/** 同步知道路径时直接用（rpc-manager 传了 sessionFile 的场景）。 */
export function readSessionTailFactsFromFile(filePath: string | null | undefined): SessionTailFacts | null {
  return filePath ? scanSessionTail(filePath) : null;
}