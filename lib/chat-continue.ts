import { createReadStream, createWriteStream } from "fs";
import { createInterface } from "readline";
import { replaceFileAtomicStream } from "./atomic-file.ts";

const DAMAGED = "This chat's transcript is damaged and cannot be continued in a project";

/**
 * Remove the system messages from a copied transcript, joining the entries around them.
 *
 * 这些条目带着 chat 的 system prompt 与工具声明；删掉它们，pi 才会给项目会话
 * 重新生成自己的 prompt 和默认工具集（等同新会话）。
 *
 * 流式两遍（数据/测试审计 A-4）：旧实现 `readFileSync` 整文件进内存再全量重写，
 * 大聊天会同步阻塞事件循环并可能 OOM。第一遍只收集被删系统消息的 id→parentId
 * （数量很少），第二遍逐行重写 parentId 并流式落盘；replaceFileAtomicStream 保证
 * 符号链接目标、权限位、fsync 与失败清理都和字符串版一致。
 *
 * 语义与旧实现逐条对齐：
 * - 只有 `type === "message"` 且 `message.role === "system"` 且 `id` 为字符串的条目被删；
 * - 其它条目原样保留（parentId 指向被删条目时上溯到最近的存活祖先）；
 * - 任何一行无法解析即抛错（transcript 损坏），调用方负责删除半成品。
 */
export async function forgetChatSystemPrompt(file: string): Promise<void> {
  // 第一遍：只记被删系统消息的父子关系。
  const parents = new Map<string, string | null>();
  {
    const input = createReadStream(file, "utf8");
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          throw new Error(DAMAGED);
        }
        const message = entry.message as { role?: string } | undefined;
        if (entry.type === "message" && message?.role === "system" && typeof entry.id === "string") {
          parents.set(entry.id, (entry.parentId as string | null | undefined) ?? null);
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  const survivor = (id: string | null | undefined): string | null => {
    let current = id ?? null;
    while (current !== null && parents.has(current)) current = parents.get(current) ?? null;
    return current;
  };

  // 第二遍：逐行重写，跳过被删系统消息。
  await replaceFileAtomicStream(file, async (tempPath) => {
    // 临时文件已由 helper 创建（wx/0600），写流用 r+ 追加而不是截断。
    const output = createWriteStream(tempPath, { flags: "r+", mode: 0o600 });
    const input = createReadStream(file, "utf8");
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        // 第一遍已证明每行可解析；这里仍防御撕裂行。
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          throw new Error(DAMAGED);
        }
        const message = entry.message as { role?: string } | undefined;
        if (entry.type === "message" && message?.role === "system" && typeof entry.id === "string") continue;
        const next = "parentId" in entry
          ? { ...entry, parentId: survivor(entry.parentId as string | null | undefined) }
          : entry;
        output.write(`${JSON.stringify(next)}\n`);
      }
      await new Promise<void>((resolve, reject) => {
        output.end(() => resolve());
        output.on("error", reject);
      });
    } finally {
      lines.close();
      input.destroy();
      // 失败时不能占着临时文件：helper 会 unlink，Windows 上打开中的文件删不掉。
      if (!output.writableEnded) output.destroy();
    }
  });
}
