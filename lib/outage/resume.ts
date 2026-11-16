/**
 * 把一条挂起记录变成一次续跑动作（server-only）。
 *
 * 三条纪律：
 * 1. **续跑用 followUp 提示，不重发原 prompt**（设计原则 3）：用户消息已在会话
 *    记录里，重发会重复。提示由 `buildRecoveryNote()`（`lib/keepalive/resume.ts:173`，
 *    此前无人调用，这里首次启用）+ 中断说明拼成。
 * 2. **重启后重新 startRpcSession**：wrapper 可能早已被 10 分钟 idle 驱逐；状态在
 *    磁盘上，按 `sessionId` 重新打开即可（`lib/autofix/runner.ts:589` 是同一做法）。
 * 3. **绝不重入**：会话正在跑就跳过这次尝试（下一 tick 再来），不 steer 打断。
 */
import { existsSync } from "node:fs";
import { buildRecoveryNote } from "../keepalive/resume";
import {
  capOutageText,
  OUTAGE_REASON_MAX_CHARS,
  type OutageRecord,
} from "./types";

/** 续跑时优先发的中性英文提示（与 goal 的续跑提示同风格；locale 由 UI 负责）。 */
export function buildOutageResumeNote(record: OutageRecord, now: number): string {
  const minutes = Math.max(1, Math.round((now - record.budget.startedAt) / 60_000));
  const kindLine = record.kind === "quota"
    ? "The provider's usage quota is exhausted again or was unavailable."
    : "The model provider was unavailable.";
  const note = buildRecoveryNote({
    task: null,
    cwd: record.cwd ?? null,
    round: null,
    lastError: record.reason,
  });
  return [
    `[outage] ${kindLine} The previous turn ended before it finished, and this is the automatic resume after about ${minutes} minute(s).`,
    "Do not restart the task from scratch and do not ask the user to retry — pick up exactly where the interrupted turn stopped.",
    note,
  ].join("\n");
}

export interface OutageResumeDeps {
  /** 按会话 id 取活跃 wrapper；返回 undefined 表示需要重开。 */
  getSession(sessionId: string): OutageResumeSession | undefined;
  /** 重新打开会话（重启接续）；返回一个可 send 的 wrapper。 */
  openSession(record: OutageRecord): Promise<OutageResumeSession>;
  /**
   * 轻量探针：确认 provider 已恢复（前 3 次跳过，直接续跑）。
   * 成功返回 true。抛错按「仍不可用」处理。
   */
  probe(record: OutageRecord): Promise<boolean>;
  /** 会话最后一条 user 消息的 entry id（防抢跑校验）。读不到返回 null。 */
  lastUserMessageId(sessionId: string): string | null;
  now(): number;
}

/** resume 需要的最小会话面（`AgentSessionWrapper` 结构满足它）。 */
export interface OutageResumeSession {
  isAlive?(): boolean;
  isRunning?(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
}

export type OutageResumeOutcome =
  | { kind: "skipped"; reason: "not-waiting" | "not-due" | "superseded" | "busy" | "probe-pending" }
  | { kind: "failed"; error: string }
  | { kind: "resumed" };

/**
 * 执行一次续跑尝试的**前置检查**（不做，交给 scheduler 做实际 send，因为调度器
 * 还要在同一处记账 attempts）。这里只给纯判据，让测试可以锁死语义。
 */
export function shouldAttemptResume(
  record: OutageRecord,
  input: { now: number; sessionLastUserMessageId: string | null },
  superseded: (record: OutageRecord, current: string | null) => boolean,
): { attempt: boolean; reason?: "not-waiting" | "not-due" | "superseded" } {
  if (record.status !== "waiting") return { attempt: false, reason: "not-waiting" };
  if (input.now < record.budget.nextAttemptAt) return { attempt: false, reason: "not-due" };
  if (superseded(record, input.sessionLastUserMessageId)) return { attempt: false, reason: "superseded" };
  return { attempt: true };
}

/**
 * 把续跑的文本决定出来：
 * - 原 prompt 已确认落盘（`promptPersisted === true`）或能从会话读到最后一条 user
 *   消息 ⇒ 用 recovery note 作 followUp；
 * - 否则退回原 prompt 文本（`resume.promptText`），按普通 prompt 重发（兜底路径，
 *   理论上不会命中，见 types.ts 的落盘实测说明）。
 */
export function chooseResumeMessage(
  record: OutageRecord,
  input: { now: number; promptPersisted: boolean; hasPromptText: boolean },
): { mode: "followup" | "prompt"; text: string } {
  if (input.promptPersisted || !input.hasPromptText) {
    return { mode: "followup", text: buildOutageResumeNote(record, input.now) };
  }
  return {
    mode: "prompt",
    text: record.resume.promptText ?? buildOutageResumeNote(record, input.now),
  };
}

/** 供 rpc-hook 使用的 reason 摘要（capped）。 */
export function outageReasonText(error: string): string {
  return capOutageText(error || "Provider unavailable", OUTAGE_REASON_MAX_CHARS);
}

/** 会话文件是否存在（重启接续前的廉价检查）。 */
export function outageSessionFileExists(record: OutageRecord): boolean {
  return Boolean(record.sessionFile && existsSync(record.sessionFile));
}