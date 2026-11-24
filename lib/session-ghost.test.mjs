import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 持久化审计 P1-1：外部删掉会话后，路径缓存不过期 → GET 返回 200 的「幽灵会话」。
 *
 * 缓存只由本进程自己失效（删除 / re-parent），于是 `SessionManager.open()` 拿到一个
 * 不存在的路径时不是报错，而是**造一个新的空会话**（保留请求里的显式路径），
 * 返回 200 且 `info.id` 与请求的 id 不同——客户端把一个已删除的会话当空会话渲染。
 *
 * 修法落在读路径上：解析出路径后校验文件存在，不存在就 404。校验**不能**放进
 * `resolveSessionPath` 本身——DELETE 需要靠这个路径去关掉「尚未落盘但已登记」的
 * 会话的运行时（`deleting an unpersisted session …` 用例钉的正是这一点）。
 */
const home = mkdtempSync(join(tmpdir(), "pi-session-ghost-"));
process.env.PI_AGENT_HOME = home;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET } = await jiti.import("../../app/api/sessions/[id]/route.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

const GHOST_ID = "01a20ab5-38e4-745c-810b-015748c11edc";
const MISSING_PATH = join(home, ".pi", "agent", "sessions", "--ghost--", `${GHOST_ID}.jsonl`);

test("a cached path whose file is gone answers 404, not a manufactured empty session", async () => {
  // Exactly the state the old cache produced: an id → path mapping for a file that
  // no longer exists (deleted externally, so nothing invalidated the cache).
  cacheSessionPath(GHOST_ID, MISSING_PATH);
  const response = await GET(
    new Request(`http://localhost/api/sessions/${GHOST_ID}`, { headers: { Host: "localhost" } }),
    { params: Promise.resolve({ id: GHOST_ID }) },
  );
  assert.equal(response.status, 404, "a deleted session must read as gone");
  const body = await response.json();
  assert.equal(body.error, "Session not found");
  invalidateSessionPathCache(GHOST_ID);
});

test("a live wrapper still answers even when its file has not been flushed yet", async () => {
  // The DELETE path depends on resolving an unflushed session; reads of a *live*
  // wrapper must not be turned into 404s by the same file check.
  const previousRegistry = globalThis.__piSessions;
  const id = "01a20ab5-38e4-745c-810b-015748c11edd";
  globalThis.__piSessions = new Map([[
    id,
    {
      isAlive: () => true,
      isRunning: () => false,
      sessionFile: MISSING_PATH,
      inner: {
        sessionManager: {
          getSessionFile: () => MISSING_PATH,
          getEntries: () => [],
          getLeafId: () => null,
          getTree: () => [],
          getSessionName: () => undefined,
        },
        getContextUsage: () => undefined,
      },
    },
  ]]);
  try {
    const response = await GET(
      new Request(`http://localhost/api/sessions/${id}`, { headers: { Host: "localhost" } }),
      { params: Promise.resolve({ id }) },
    );
    assert.notEqual(response.status, 404, "a live wrapper is not a ghost");
  } finally {
    globalThis.__piSessions = previousRegistry;
  }
});