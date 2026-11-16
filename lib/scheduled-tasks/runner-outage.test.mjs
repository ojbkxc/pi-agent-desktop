import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { makeDeps } from "./test-helpers.mjs";

/**
 * scheduled 的 Provider 中断接入（设计文档 §4.4）：上游中断/额度耗尽
 * **不计入**「连续失败 5 次停用」（`countsAsFailure: false`），下一个 slot 正常再跑。
 */

const runner = await createJiti(import.meta.url).import("./runner.ts");

const task = (extra = {}) => ({
  id: "00000000-0000-4000-8000-000000000001", name: "Daily review", prompt: "Review the commits", cwd: "/work",
  schedule: { kind: "manual" }, toolPreset: "read-only", maxDurationMin: 30, enabled: true,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", consecutiveFailures: 0, ...extra,
});
const info = { runId: "run-1", trigger: "schedule", scheduledFor: "2026-10-07T09:00:00.000Z" };

/** 直接构造一个返回自定义 errorMessage 的 deps（复用 makeDeps 的骨架）。 */
function customErrorDeps(errorMessage) {
  const base = makeDeps();
  return {
    ...base,
    startSession: async (cwd, options) => {
      const session = {
        sent: [],
        entries: [],
        onEvent(listener) {
          this._listener = listener;
          return () => { this._listener = undefined; };
        },
        async send(command) {
          this.sent.push(command);
          if (command.type === "prompt") {
            queueMicrotask(() => {
              this._listener?.({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage } });
              this._listener?.({ type: "prompt_done" });
            });
          }
          return null;
        },
        inner: { sessionManager: { appendCustomEntry: (customType, data) => session.entries.push({ customType, data }) } },
        destroy() {},
      };
      base.started.push({ session, sessionId: "sess-1", cwd, options });
      return { session, sessionId: "sess-1" };
    },
  };
}

test("provider 中断（5xx）⇒ 不计入连续失败", async () => {
  const outcome = await runner.executeRun(task(), info, customErrorDeps("upstream 503 Service Unavailable"));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.countsAsFailure, false);
});

test("额度耗尽 ⇒ 不计入连续失败", async () => {
  const outcome = await runner.executeRun(task(), info, customErrorDeps("insufficient_quota"));
  assert.equal(outcome.countsAsFailure, false);
});

test("鉴权失效（terminal）⇒ 仍计入失败", async () => {
  const outcome = await runner.executeRun(task(), info, customErrorDeps("401 Unauthorized: invalid api key"));
  assert.equal(outcome.countsAsFailure, true);
});

test("普通任务失败 ⇒ 仍计入失败", async () => {
  const outcome = await runner.executeRun(task(), info, makeDeps({ behavior: () => "error" }));
  assert.equal(outcome.error, "boom");
  assert.equal(outcome.countsAsFailure, true);
});

test("prompt 预检失败（非 provider）⇒ 计入失败", async () => {
  const outcome = await runner.executeRun(task(), info, makeDeps({ behavior: () => "promptError" }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.countsAsFailure, true);
});

test("三次 provider 中断后 consecutiveFailures 不变（scheduler.recordOutcome 口径）", async () => {
  // 直接验证 recordOutcome 的输入契约：countsAsFailure=false 时不增计数。
  const { Scheduler } = await createJiti(import.meta.url).import("./scheduler.ts");
  const { getTask } = await createJiti(import.meta.url).import("./store.ts");
  assert.equal(typeof Scheduler, "function", "Scheduler 导出存在");
  // recordOutcome 是私有方法，通过真实 scheduler 实例与临时 agentDir 验证。
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-sched-outage-"));
  try {
    writeFileSync(join(agentDir, "scheduled-tasks.json"), JSON.stringify({ version: 1, tasks: [task()] }), "utf8");
    const scheduler = new Scheduler({ agentDir });
    for (let i = 0; i < 3; i += 1) {
      scheduler.recordOutcome(task().id, { status: "failed", error: "upstream 503", countsAsFailure: false });
    }
    const after = getTask(task().id, agentDir);
    assert.equal(after.consecutiveFailures, 0, "provider 中断不累计失败");
    assert.equal(after.enabled, true, "不会被自动停用");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});