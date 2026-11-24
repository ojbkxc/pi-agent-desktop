/**
 * rpc-manager 的**唯一**安全接入点（server-only）。
 *
 * ── 给接线成员（rpc-manager 只加一行）─────────────────────────────
 *
 * 挂点：`lib/rpc-manager.ts` 的 `session.subscribe(...)` 里 `agent_settled` 分支
 * （现有 `if (event.type === "agent_settled")` 那段）末尾：
 *
 * ```ts
 * // Provider 中断自愈：只落一条小 JSON，重活由 outage scheduler 异步推进。
 * void onAgentRunSettled({
 *   sessionId: this.sessionId,
 *   outcome: this.lastRunOutcome,
 *   aborted: event.aborted === true,
 *   sessionFile: this.sessionFile || null,
 *   cwd: this.cwd,
 * });
 * ```
 *
 * **不要挂在 `agent_end`**：实测（D:/tmp/probe-landing5.mjs，2026-11-16）SDK 在
 * 每一次自动重试前都会发一次 `agent_end`（连接拒绝场景实测 4 次 `agent_end`
 * 才到 1 次 `agent_settled`）；在那里分类会把一次 14 秒的抖动写成挂起记录。
 * `agent_settled` 只在整轮（含 SDK 重试与 followUp 队列）结束后发一次，且
 * `this.lastRunOutcome` 已收敛。这是与设计文档 §4.1（写的是 agent_end）的
 * **有意偏差**，原因如上。
 *
 * 其余入参**全部可选、由本模块自己从会话文件读取**（`session-probe.ts`，
 * 只读尾部 64 KiB）：
 * - `model`（provider/modelId）缺省时取最后一条 assistant 消息记录上的
 *   `provider` / `model` 字段（pi 的 assistant 消息自带这两个字段）；
 * - `lastUserMessageId` 缺省时取最后一条 user 消息的 entry id；
 * - `promptText` 缺省时取最后一条 user 消息的文本（仅纯文本，不含图片）；
 * - `leafEntryId` 缺省时取文件最后一条 entry 的 id。
 *
 * 语义（**接线必须知道**）：
 * - 返回 `Promise<{suspended, kind?, reason?}>`；**不抛**（内部全 try/catch）。
 *   wiring **不需要**关心返回值（只为日志/测试保留），用 `void` 调用即可；
 *   即使忘了 `void` 也不会 unhandled rejection。
 * - `outcome` 传 `this.lastRunOutcome`：只有 `{status:"failed", error}` 会分类；
 *   `done` / `aborted` 直接返回（成功时清 post-resume 计数）。
 * - `aborted` 必须传 `event.aborted === true`：Stop 语义不变（aborted 不挂起）。
 * - terminal 类（401/403/模型不存在/400）与 transient 类（429 短限流）**不挂起**。
 * - 会话已有 waiting 记录时，本次失败按「恢复后再失败」记账，不新建记录。
 *
 * UI 入口（路由用）：`retryOutageNow()` / `cancelOutage()` / `cancelOutageOnStop()` /
 * `isSessionWaitingForProvider()` / `countWaitingOutages()`。
 */

import {
  cancelOutageRecord,
  createOutageRecord,
  finishOutageRecord,
  getOutageRecord,
  isOutageSuperseded,
  isOutageSuspendedEnabled,
  listOutageRecords,
  outageSettingsPath,
  readOutageSettings,
  updateOutageRecord,
} from "./store";
import { classifyOutageError } from "./classify";
import { initialOutageBudget } from "./backoff";
import {
  ALL_POLICY_MAX_ATTEMPTS,
  applyModelRetryPolicy,
  policyMaxWaitHours,
  type ModelRetryPolicy,
} from "./retry-policy";
import { effectiveModelRetryPolicyForAgentDir, readModelRetryPolicySettings } from "./retry-policy-store";
import { buildOutageResumeNote, outageReasonText } from "./resume";
import {
  readSessionTailFacts,
  readSessionTailFactsFromFile,
  type SessionTailFacts,
} from "./session-probe";
import {
  isOutageSuspendKind,
  OUTAGE_DEFAULT_MAX_ATTEMPTS,
  OUTAGE_MAX_POST_RESUME_FAILURES,
  outageMaxWaitMs,
  type OutageKind,
  type OutageRecord,
  type OutageScope,
  type OutageSuspendKind,
} from "./types";

export interface AgentRunSettledInput {
  sessionId: string;
  /** `AgentRunOutcome`：`{status:"failed", error}` 才进入分类。 */
  outcome: { status: "done" | "failed" | "aborted"; error?: string };
  /** `event.aborted === true`（Stop）。aborted 不挂起、不续跑。 */
  aborted?: boolean;
  /** 当前 provider/modelId；不传则从会话文件尾部的 assistant 消息推断。 */
  model?: { provider?: string | null; modelId?: string | null } | null;
  /** 会话文件路径（重启接续需要）。 */
  sessionFile?: string | null;
  /** 工作目录。 */
  cwd?: string | null;
  /** 会话最后一条 user 条目的 entry id；不传则从文件读取。 */
  lastUserMessageId?: string | null;
  /** 叶子 entry id；不传则从文件读取。 */
  leafEntryId?: string | null;
  /** 当前跑的那条用户 prompt 原文；不传则从文件读取。 */
  promptText?: string | null;
  /** 作用域；普通会话 "chat"，goal 会话仍是 "chat"（goal 扩展自己会看挂起记录）。 */
  scope?: OutageScope;
  /** 注入点（测试 / 路由复用）；默认读 pi-web 设置、写真实目录。 */
  agentDir?: string;
  now?: number;
}

export interface AgentRunSettledResult {
  suspended: boolean;
  /** 实际分类结果（transient/terminal 也会返回，便于调用方日志）。 */
  kind?: OutageKind | null;
  reason?: string;
}

/**
 * `agent_settled` 后调用一次。**只写记录**，任何重活都由 scheduler 异步做。
 */
export async function onAgentRunSettled(input: AgentRunSettledInput): Promise<AgentRunSettledResult> {
  try {
    return await handleSettled(input);
  } catch (error) {
    console.error("[outage] settle hook failed:", error instanceof Error ? error.message : String(error));
    return { suspended: false };
  }
}

async function handleSettled(input: AgentRunSettledInput): Promise<AgentRunSettledResult> {
  const now = input.now ?? Date.now();
  const agentDir = input.agentDir;

  // Stop：不写、不续跑。已有记录由用户显式取消（UI）或 Stop 路由调用 cancel。
  if (input.aborted) return { suspended: false };
  if (input.outcome.status !== "failed") {
    // 恢复后跑成功了：清空 post-resume 计数（记录可能在等待中被续跑过）。
    clearPostResumeFailures(input.sessionId, agentDir);
    // **必须结案**。否则记录一直停在 waiting，调度器会按退避档继续给它发续跑提示，
    // 每发一次就触发一轮新 turn（重复烧 token），直到 deadline 耗尽。
    //
    // 本来有一道自愈：续跑提示本身是新的 user 消息，`isOutageSuperseded` 会发现
    // guard.lastUserMessageId 变了而把记录作废。但那道防线在 `lastUserMessageId`
    // 为 null 时恒不成立（挂起时读盘失败就会这样），于是永远不会自愈。
    // 成功是比「猜它被新消息取代」更直接的证据，这里直接收尾。
    const waiting = getOutageRecord(input.sessionId, agentDir);
    if (waiting?.status === "waiting") {
      finishOutageRecord(input.sessionId, "resumed", now, {}, agentDir);
    }
    return { suspended: false };
  }

  const settings = readOutageSettings(outageSettingsPath(agentDir));
  if (!settings.enabled) return { suspended: false };

  // 已有等待中的记录：这是调度器续跑后的一次失败，记账而不是重开。
  const existing = getOutageRecord(input.sessionId, agentDir);
  if (existing?.status === "waiting") {
    return recordPostResumeFailure(existing, input, now, agentDir);
  }

  const errorText = input.outcome.error ?? "";
  const classification = classifyOutageError({ errorText });
  // 按 provider 的重试策略：`all` 档把 terminal/transient 一并升级成可挂起的
  // `outage`（用户选的就是「所有错误都持续重试，直到成功或本轮被停止」）。
  // 判定只用 `input.model?.provider`——它在参数里，不必等下面的会话事实。
  const providerPolicy = effectiveModelRetryPolicyForAgentDir(input.model?.provider, agentDir);
  const policyKind = applyModelRetryPolicy(classification.kind, providerPolicy);
  const policySuspends = classification.suspend || providerPolicy === "all";
  if (!policySuspends || !isOutageSuspendKind(policyKind)) {
    // 无挂起记录时，任何非 suspend 类失败按原样上报（terminal/transient 都不挂起）。
    return { suspended: false, kind: classification.kind };
  }
  const kind: OutageSuspendKind = policyKind;
  if (!isOutageSuspendedEnabled(kind, settings)) return { suspended: false, kind };

  const maxWaitMs = outageMaxWaitMs(kind, settings);
  if (maxWaitMs <= 0) return { suspended: false, kind };
  // `all` 档的等待上限与尝试上限都另有一套（见 lib/outage/retry-policy.ts）：
  // 用户选了「一直重试」，就不该被默认的 6 小时 / 40 次先掐掉。
  const policyHours = policyMaxWaitHours(
    providerPolicy,
    readModelRetryPolicySettings(outageSettingsPath(agentDir)).allMaxWaitHours,
  );
  // `policyHours === 0` 是「不限」：把 deadline 落成 0 哨兵（`isOutageExpired` 判 `> 0`）。
  // `initialOutageBudget` 的 `now + 0` 会得到 now 本身（= 立刻过期），所以这里显式分流。
  const effectiveMaxWaitMs = policyHours === undefined
    ? maxWaitMs
    : policyHours === 0
      ? 0
      : policyHours * 3_600_000;
  const maxAttempts = providerPolicy === "all" ? ALL_POLICY_MAX_ATTEMPTS : OUTAGE_DEFAULT_MAX_ATTEMPTS;

  // 会话事实：显式入参优先，其余从尾部读（拿不到就传 null，不阻塞挂起）。
  const facts: SessionTailFacts | null = input.sessionFile !== undefined && input.sessionFile !== null
    ? readSessionTailFactsFromFile(input.sessionFile)
    : await readSessionTailFacts(input.sessionId).catch(() => null);
  const lastUserMessageId = input.lastUserMessageId !== undefined
    ? input.lastUserMessageId
    : facts?.lastUserMessageId ?? null;
  const promptText = input.promptText !== undefined ? input.promptText : facts?.lastUserText ?? null;
  // prompt 是否已落盘：读到了 entry id 就算已确认；否则把原文存进记录兜底。
  const promptPersisted = Boolean(lastUserMessageId);
  const provider = input.model?.provider ?? facts?.provider ?? null;
  const modelId = input.model?.modelId ?? facts?.modelId ?? null;

  const record = createOutageRecord({
    sessionId: input.sessionId,
    kind,
    reason: outageReasonText(errorText),
    scope: input.scope ?? "chat",
    origin: { provider, modelId },
    resume: {
      mode: "followup",
      // note 落盘时写一份（时间按挂起时刻算）；调度器每次续跑前会按实际等待时长重算。
      note: "",
      ...(typeof promptText === "string" && promptText ? { promptText } : {}),
      promptPersisted,
    },
    budget: initialOutageBudget({
      kind,
      now,
      maxWaitMs: effectiveMaxWaitMs,
      maxAttempts,
    }),
    guard: {
      lastUserMessageId,
      leafEntryId: input.leafEntryId ?? facts?.leafEntryId ?? null,
      sessionUpdatedAt: now,
    },
    sessionFile: input.sessionFile ?? null,
    cwd: input.cwd ?? null,
    now,
  }, agentDir);

  // 首次落盘后再补一份按挂起时刻计算的续跑注记（内容与调度器每次现算的一致）。
  updateOutageRecord(input.sessionId, (current) => ({
    ...current,
    resume: { ...current.resume, note: current.resume.note || buildOutageResumeNote(current, now) },
  }), agentDir);

  return { suspended: true, kind, reason: record.reason };
}

/**
 * 已有等待记录时的失败记账（调度器续跑后的一轮又失败了）：
 * - 仍是 outage/quota ⇒ 回挂起，**不计新预算**（attempts 由调度器推进，这里只更新 reason）；
 * - terminal 或非 outage 连续 3 次 ⇒ 判 failed，收起记录（不再挂起）。
 */
function recordPostResumeFailure(
  record: OutageRecord,
  input: AgentRunSettledInput,
  now: number,
  agentDir: string | undefined,
): AgentRunSettledResult {
  const classification = classifyOutageError({ errorText: input.outcome.error ?? "" });
  // 续跑之后的失败也要按同一套策略判定：用户选了 `all` 时，一趟续跑里撞到
  // terminal 不应该就此收摊——那正是「持续重试直到成功或被停止」要覆盖的情形。
  const policy: ModelRetryPolicy = effectiveModelRetryPolicyForAgentDir(input.model?.provider, agentDir);
  const policyKind = applyModelRetryPolicy(classification.kind, policy);
  const suspends = classification.suspend || policy === "all";
  if (suspends && isOutageSuspendKind(policyKind)) {
    const nextKind: OutageSuspendKind = policyKind === "quota" ? "quota" : record.kind;
    updateOutageRecord(record.sessionId, (current) => ({
      ...current,
      kind: nextKind,
      reason: outageReasonText(input.outcome.error ?? current.reason),
      updatedAt: now,
      // 续跑又撞到上游：回到等待（nextAttemptAt 保持调度器算好的值或已过去）。
      status: "waiting",
    }), agentDir);
    return { suspended: true, kind: nextKind, reason: record.reason };
  }

  const failures = (record.postResumeFailures ?? 0) + 1;
  if (policyKind === "terminal" || failures >= OUTAGE_MAX_POST_RESUME_FAILURES) {
    finishOutageRecord(record.sessionId, "failed", now, {
      lastError: outageReasonText(input.outcome.error ?? ""),
    }, agentDir);
    return { suspended: false, kind: classification.kind };
  }
  const next = updateOutageRecord(record.sessionId, (current) => ({
    ...current,
    postResumeFailures: failures,
    updatedAt: now,
  }), agentDir);
  return { suspended: next?.status === "waiting", kind: classification.kind, reason: next?.reason };
}

function clearPostResumeFailures(sessionId: string, agentDir: string | undefined): void {
  const existing = getOutageRecord(sessionId, agentDir);
  if (!existing || (existing.postResumeFailures ?? 0) === 0) return;
  if (existing.status !== "waiting") return;
  updateOutageRecord(sessionId, (current) => ({ ...current, postResumeFailures: 0 }), agentDir);
}

// ───────────────────────────── UI 入口 ─────────────────────────────

/**
 * 「立即重试」：把下一条记录的 nextAttemptAt 拨到现在，调度器下一 tick 就跑。
 * 返回是否找到了记录。不直接续跑——保持「唯一驱动者是 scheduler」。
 */
export function retryOutageNow(sessionId: string, now: number = Date.now(), agentDir?: string): boolean {
  const current = getOutageRecord(sessionId, agentDir);
  if (!current || current.status !== "waiting") return false;
  updateOutageRecord(sessionId, (record) => ({
    ...record,
    budget: { ...record.budget, nextAttemptAt: now },
    updatedAt: record.updatedAt,
  }), agentDir);
  return true;
}

/** 「取消等待」（UI）或 Stop：删记录，不再续跑。返回是否删掉了。 */
export function cancelOutage(sessionId: string, agentDir?: string): boolean {
  return cancelOutageRecord(sessionId, agentDir);
}

/** Stop 时清理：只有用户主动 Stop 才删；scheduler 的 abort 不该走这里。 */
export function cancelOutageOnStop(sessionId: string, agentDir?: string): boolean {
  return cancelOutageRecord(sessionId, agentDir);
}

/** 该会话是否正被挂起等待（goal 扩展 / autofix 判据用）。 */
export function isSessionWaitingForProvider(sessionId: string, agentDir?: string): boolean {
  return getOutageRecord(sessionId, agentDir)?.status === "waiting";
}

/** 当前挂起计数（设置页展示）。 */
export function countWaitingOutages(agentDir?: string): number {
  return listOutageRecords({ agentDir, waitingOnly: true }).length;
}

export { isOutageSuperseded };