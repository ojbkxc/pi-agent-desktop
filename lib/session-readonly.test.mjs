import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 持久化审计 P0 的回归：**只读 GET 不许改会话文件一个字节**。
 *
 * `SessionManager.open()` 传 persist=true：读入一个 legacy（version < 3）文件时
 * 会对它跑 migrateToCurrentVersion → `_rewriteFile()` 截断重写，而且只写回
 * 解析成功的行。于是一个普通 GET 会悄悄丢掉文件里任何一行坏 JSON（实测 387 →
 * 289 字节），并把 header 就地改成 version:3；重写还先归零再写，非原子。
 *
 * 修法：读路径改走 persist=false 的只读构造，迁移在内存里跑
 * （`openReadOnlySessionManager`）。这里钉的正是「读完之后磁盘完全没变」。
 */
const home = mkdtempSync(join(tmpdir(), "pi-session-readonly-"));
process.env.PI_AGENT_HOME = home;
const sessionDir = join(home, ".pi", "agent", "sessions", "--readonly--");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { openReadOnlySessionManager } = await jiti.import("./session-slim-load.ts");
const { openSessionManager } = await jiti.import("./session-reader.ts");

after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

/** A v2 session: legacy header + one unparseable line + one real message. */
function writeLegacySession(name, { version = 2, bom = false } = {}) {
  mkdirSync(sessionDir, { recursive: true });
  const filePath = join(sessionDir, name);
  const lines = [
    JSON.stringify({
      type: "session",
      version,
      id: "01a20ab5-38e4-745c-810b-015748c11edc",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: home,
    }),
    '{"type":"message","message":{"role":"user","content":"hi"', // truncated on purpose
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }),
  ];
  const body = `${bom ? "\uFEFF" : ""}${lines.join("\n")}\n`;
  writeFileSync(filePath, body, "utf8");
  return { filePath, bytes: Buffer.byteLength(body) };
}

test("opening a legacy session for reading does not rewrite or shrink it", () => {
  const { filePath, bytes } = writeLegacySession("legacy.jsonl");
  const before = readFileSync(filePath);
  assert.equal(statSync(filePath).size, bytes);

  const sm = openSessionManager(filePath);
  assert.ok(sm, "the read opens");
  // The message is still visible (migration happened in memory)…
  assert.ok(sm.getEntries().some((entry) => entry.type === "message"), "entries are readable");

  // …and the file is byte-for-byte what it was: bad line included, version untouched.
  const after = readFileSync(filePath);
  assert.equal(statSync(filePath).size, bytes, "the file must not shrink on a read");
  assert.deepEqual(after, before, "a read must not touch a single byte");
  assert.match(after.toString("utf8"), /"version":2/, "the header version stays as it was on disk");
  // The bad line is the middle one; a rewrite would have dropped it (that is exactly
  // what `SessionManager.open()` does: it keeps only the lines it could parse).
  assert.equal(after.toString("utf8").split("\n").filter(Boolean).length, 3, "all three lines survive");
  assert.ok(after.toString("utf8").includes('"content":"hi"'), "the unparseable line is still there");
});

test("the read-only opener applies the migration in memory, not on disk", () => {
  const { filePath } = writeLegacySession("legacy2.jsonl");
  const sm = openReadOnlySessionManager(filePath);
  assert.ok(sm, "a legacy file still opens");
  // The header parsed (the id comes from it) and the message survived the bad line.
  assert.equal(sm.getSessionId(), "01a20ab5-38e4-745c-810b-015748c11edc");
  assert.ok(sm.getEntries().some((entry) => entry.type === "message"), "the readable message is present");
  assert.match(readFileSync(filePath, "utf8"), /"version":2/, "disk version is untouched");
});

test("a mutable open is still allowed to migrate and write", () => {
  const { filePath } = writeLegacySession("legacy3.jsonl");
  openSessionManager(filePath, { mutable: true });
  // The write path is where migration is supposed to land.
  assert.match(readFileSync(filePath, "utf8"), /"version":3/);
});