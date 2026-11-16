/**
 * 生产依赖组装（server-only）：把 scheduler 的注入点接到真实世界。
 *
 * 唯一调用者是 `instrumentation-node.ts`：
 *
 * ```ts
 * void import("./lib/outage/live").then(({ startLiveOutageScheduler }) => startLiveOutageScheduler());
 * ```
 *
 * 懒加载原则与 autofix 一致：`rpc-manager` / `pi-ai` / `pi-coding-agent` 都靠
 * `await import()` 才进内存，instrumentation 的启动路径保持轻。
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readLastUserMessageEntryId } from "./session-probe";
import { buildOutageProbe } from "./probe";
import {
  startOutageSchedulerLoop,
  type OutageSchedulerDeps,
  type OutageSessionLike,
} from "./scheduler";
import type { OutageRecord } from "./types";

/** 记录里保存的会话文件路径优先；没有就按 id 解析。 */
async function resolveRecordSessionFile(
  record: OutageRecord,
  module: { resolveSessionPath(sessionId: string): Promise<string | null> },
): Promise<string | null> {
  if (record.sessionFile) return record.sessionFile;
  try {
    return await module.resolveSessionPath(record.sessionId);
  } catch {
    return null;
  }
}

export function createLiveOutageDeps(overrides: Partial<OutageSchedulerDeps> = {}): OutageSchedulerDeps {
  return {
    now: () => Date.now(),
    getSession(sessionId) {
      // Lazy so instrumentation can start without loading the session stack.
      const registry = (globalThis as unknown as {
        __piSessions?: Map<string, { isAlive(): boolean; isRunning(): boolean; send(cmd: Record<string, unknown>): Promise<unknown> }>;
      }).__piSessions;
      const session = registry?.get(sessionId);
      if (!session || !session.isAlive()) return undefined;
      return session as unknown as OutageSessionLike;
    },
    async openSession(record) {
      const [{ startRpcSession }, sessionReader] = await Promise.all([
        import("../rpc-manager"),
        import("../session-reader"),
      ]);
      const filePath = await resolveRecordSessionFile(record, sessionReader);
      if (!filePath) {
        throw new Error(`Session file not found for ${record.sessionId}`);
      }
      const { session } = await startRpcSession(record.sessionId, filePath, record.cwd ?? undefined, {
        allowInitialModelFallback: true,
        // 无人值守续跑：没人能点确认，与 autofix 同口径。
        skipToolApproval: true,
      });
      return session as unknown as OutageSessionLike;
    },
    probe(record) {
      return buildOutageProbe(record);
    },
    async lastUserMessageId(sessionId) {
      return readLastUserMessageEntryId(sessionId);
    },
    agentDir: getAgentDir(),
    ...overrides,
  };
}

/** instrumentation 的唯一入口。 */
export function startLiveOutageScheduler(): void {
  startOutageSchedulerLoop(createLiveOutageDeps());
}