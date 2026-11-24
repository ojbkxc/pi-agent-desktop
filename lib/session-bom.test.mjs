import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 持久化审计 P2-2：**头部带 UTF-8 BOM 的会话整个消失**。
 *
 * `readSessionHeader` 只 `trimEnd()` 就 `JSON.parse`；扫描器同样。BOM 让首行解析
 * 失败 → 文件被判成「没有 session header」→ 从索引与列表里消失、打开时 404。
 * PowerShell 5.1 的 `Out-File -Encoding utf8`、记事本另存、部分同步工具都会写这
 * 三个字节；本仓其它 JSON 读取（settings / credentials / models.json / jsonc）
 * 早就都剥 BOM，只有会话读取没有——口径不一致，而且后果是「会话不见了」。
 */
const home = mkdtempSync(join(tmpdir(), "pi-session-bom-"));
// The scanner reads `getAgentDir()`, so the agent dir is what has to point here —
// `PI_AGENT_HOME` alone would leave it scanning the real session store.
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
const sessionDir = join(home, ".pi", "agent", "sessions", "--bom--");
mkdirSync(sessionDir, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { readSessionHeader } = await jiti.import("./session-reader.ts");
const { listSessionsIncremental } = await jiti.import("./session-list-scanner.ts");

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

const SESSION_ID = "01a20ab5-38e4-745c-810b-015748c11edc";

function writeSession(name, { bom }) {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: SESSION_ID,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: home,
  });
  const message = JSON.stringify({
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
  const body = `${bom ? "\uFEFF" : ""}${header}\n${message}\n`;
  const filePath = join(sessionDir, name);
  writeFileSync(filePath, body, "utf8");
  return filePath;
}

test("readSessionHeader tolerates a UTF-8 BOM in front of the header", () => {
  const withBom = writeSession("bom.jsonl", { bom: true });
  const header = readSessionHeader(withBom);
  assert.ok(header, "a BOM must not make the header unreadable");
  assert.equal(header.id, SESSION_ID);
  assert.equal(header.type, "session");

  // A BOM-less file keeps working (no regression).
  const plain = writeSession("plain.jsonl", { bom: false });
  assert.equal(readSessionHeader(plain)?.id, SESSION_ID);
});

test("the incremental scanner keeps a BOM session in the list instead of dropping it", async () => {
  writeSession("bom2.jsonl", { bom: true });
  const sessions = await listSessionsIncremental();
  const ids = sessions.map((session) => session.id);
  assert.ok(ids.includes(SESSION_ID), `the BOM session must be listed; got ${JSON.stringify(ids)}`);
});

test("a file whose first line is not a session header is still skipped", () => {
  const filePath = join(sessionDir, "not-a-session.jsonl");
  writeFileSync(filePath, `${JSON.stringify({ type: "message", id: "x" })}\n`, "utf8");
  assert.equal(readSessionHeader(filePath), null, "only a session header counts");
});