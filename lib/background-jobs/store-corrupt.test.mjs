import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// readJob 的损坏记录分支（数据/测试审计 A-5）：坏 JSON 应返回 null（→ 路由 404），
// 而不是把 V8 的 "Unexpected token ..." 原文以 500 抛给客户端。
const agentDir = mkdtempSync(join(tmpdir(), "pi-bgjobs-store-agent-"));
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const store = await jiti.import("./store.ts");

after(() => {
  try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
});

// isJobId 只接受 UUID 形状（id 直接拼进路径，须先校验防目录穿越）。
const JOB_ID = "abc123de-f456-7890-abcd-ef1234567890";

test("a truncated job record reads as null instead of throwing", () => {
  mkdirSync(store.jobsDir(agentDir), { recursive: true });
  writeFileSync(store.jobRecordPath(JOB_ID, agentDir), "{\"id\":\"abc123de-f456-7890-abcd-ef12", "utf8");
  assert.equal(store.readJob(JOB_ID, agentDir), null);
});

test("a well-formed record still reads back", () => {
  const job = {
    version: 1,
    id: JOB_ID,
    sessionId: "session-1",
    toolCallId: "tool-1",
    command: "echo hi",
    cwd: agentDir,
    label: "test",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    exitCode: 0,
    outputPath: store.jobOutputPath(JOB_ID, agentDir),
    outputTruncated: false,
    timeoutSec: 30,
  };
  store.writeJob(job, agentDir);
  const read = store.readJob(JOB_ID, agentDir);
  assert.equal(read?.id, JOB_ID);
  assert.equal(read?.status, "completed");
});

test("a missing record reads as null", () => {
  assert.equal(store.readJob("11111111-2222-3333-4444-555555555555", agentDir), null);
});
