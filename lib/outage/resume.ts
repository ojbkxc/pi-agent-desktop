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
