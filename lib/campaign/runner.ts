/**
 * 「长时自主项目战役（campaign）」驱动引擎（server-only）。
 *
 * 一个战役 = 一句项目总目标 + 一份有序、带依赖的 backlog；runner 逐项推进，每项自带
 * 机器判据（`verifyCommand`，exit 0 = 该项完成）。判据永远在引擎这一侧：模型自称
 * 「做完了」不算数，只有验证命令 exit 0 才算。设计见
 * `docs/agents/fork-long-run-campaign.md` §2/§3/§4。
 *
 * 与 autofix（`lib/autofix/runner.ts`）的关系：驱动结构同形（认领 pid → 跑 agent 回合
 * → 引擎跑验证 → 失败输出喂回 → 轮次封顶），差异在「逐项」：
 * - 每项自带 verifyCommand；一项 exit 0 才落 done，再推进下一项；全部 done → succeeded。
 * - **单项轮次封顶** → 该项 failed → 整个战役 failed（P1 不做 continueOnItemFailure）。
 * - **Provider 中断不消耗轮次**：分类为 suspend 时把 round 退回、战役转 `waiting-provider`，
 *   由本文件的 sweep 接续（复用 `lib/outage/**`，照 autofix 接线）。
 *
 * 安全闸（设计 §6）：会话创建**不**带 `skipToolApproval`，命令审批档由创建时 gate 校验；
 * 这里是无人值守循环，任意命令都要走审批（危险命令命中 DANGEROUS_RULES 仍需确认）。
 *
 * durable store：`<agent dir>/campaigns/<uuid>.json`（见 store.ts）；进度经事件总线广播，
 * 供 API 的 SSE 路由使用（`subscribeCampaignEvents`）。
 *
 * 驱动进程 pid 语义：`campaign.pid` 是**本进程**（Next server）的 pid，不是 agent 会话
 * 进程；pid 活着 ⇒ sweep 绝不判孤儿（长回合可能超过任何心跳阈值）。
 */
import { randomUUID } from "node:crypto";
import { isBlockingExtensionUiRequest } from "../browser-notifications";
import { buildRecoveryNote } from "../keepalive/resume";
import { advanceOutageBudget, initialOutageBudget, isOutageDue } from "../outage/backoff";
import { classifyOutageError } from "../outage/classify";
import {
  cancelOutageRecord,
  createOutageRecord,
  finishOutageRecord,
  getOutageRecord,
  outageSettingsPath,
  readOutageSettings,
  updateOutageRecord,
} from "../outage/store";
import {
  isOutageExpired,
  isOutageSuspendKind,
  outageMaxWaitMs,
  OUTAGE_DEFAULT_MAX_ATTEMPTS,
  type OutageSuspendKind,
} from "../outage/types";
import { isPidAlive } from "../scheduled-tasks/lease";
import type { BlockingExtensionUiRequest, ExtensionUiRequest } from "../types";
import {
  AUTOFIX_ERROR_MAX_CHARS,
  AUTOFIX_OUTPUT_TAIL_MAX_CHARS,
  AUTOFIX_TOOL_NAMES,
  AUTOFIX_TURN_TIMEOUT_MS,
  AUTOFIX_VERIFY_TIMEOUT_MS,
  tailOf,
} from "../autofix/types";
import { runVerifyCommand, type VerifyOutcome } from "../autofix/verify";
import { campaignRuntimeStop, itemRoundExceeded, type CampaignRuntimeStop } from "./gate";
import { buildCampaignPrompt, campaignSessionName } from "./prompt";
import { getCampaign, listCampaigns, updateCampaign } from "./store";
import {
  CAMPAIGN_ERROR_MAX_CHARS,
  CAMPAIGN_STALE_MS,
  availableItems,
  campaignProgress,
  isActiveCampaignStatus,
  isTerminalCampaignStatus,
  isWaitingProviderStatus,
  nextResumeItem,
  type Campaign,
  type CampaignItem,
  type CampaignRound,
  type CampaignStatus,
} from "./types";

/** 自定义会话条目类型：标记「这个会话是战役会话」。 */
export const CAMPAIGN_ENTRY_TYPE = "pi-web:campaign";
/** 进程内同时驱动的战役数上限（=1：同 cwd 多驱动会抢端口/抢测试文件）。 */
const MAX_CONCURRENT_DRIVERS = 1;
/** 战役会话钉的工具集（与 autofix 一致：读 / 改 / 写 / 跑命令）。 */
const CAMPAIGN_TOOL_NAMES: readonly string[] = AUTOFIX_TOOL_NAMES;

// ───────────────────────────── 事件总线（SSE 用） ─────────────────────────────

export type CampaignEvent =
  | { type: "campaign_changed"; campaignId: string; status: CampaignStatus }
  | { type: "campaign_removed"; campaignId: string };

type CampaignEventListener = (event: CampaignEvent) => void;

const LISTENERS_KEY = Symbol.for("pi-web:campaign-listeners");

function campaignListeners(): Set<CampaignEventListener> {
  const holder = globalThis as unknown as Record<symbol, Set<CampaignEventListener> | undefined>;
  return (holder[LISTENERS_KEY] ??= new Set<CampaignEventListener>());
}

export function subscribeCampaignEvents(listener: CampaignEventListener): () => void {
  campaignListeners().add(listener);
  return () => {
    campaignListeners().delete(listener);
  };
}

export function emitCampaignEvent(event: CampaignEvent): void {
  for (const listener of campaignListeners()) {
    try {
      listener(event);
    } catch {
      // 一个坏订阅者不能拖死其它订阅者。
    }
  }
}

// ───────────────────────────── 依赖（测试可注入） ─────────────────────────────

/** runner 需要的最小会话面（AgentSessionWrapper / 测试桩都满足）。 */
export interface CampaignSessionLike {
  send(command: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  isAlive?(): boolean;
  isRunning?(): boolean;
  inner?: { sessionManager?: { appendCustomEntry?(customType: string, data: unknown): unknown } };
}

export interface OpenedCampaignSession {
  session: CampaignSessionLike;
  sessionId: string;
  /** True when a brand-new session was created (vs. reattached by sessionId). */
  created: boolean;
}

export interface CampaignDeps {
  agentDir?: string;
  now(): number;
  /** 打开（或新建）该战役的会话。 */
  openSession(campaign: Campaign): Promise<OpenedCampaignSession>;
  /** 跑某项的验证命令；exit code 0 = 该项完成。 */
  runVerify(command: string, cwd: string, options: { timeoutMs: number }): Promise<VerifyOutcome>;
  isPidAlive(pid: number): boolean;
  turnTimeoutMs?: number;
  verifyTimeoutMs?: number;
  /**
   * 可选：读战役会话的累计花费（USD）。P1 生产不接（成本闸只在创建前置必填），
   * 留给 P3 的成本运行中闸；注入后 runner 会把 `spentCostUsd` 抬到该值。
   */
  readSessionCost?(sessionId: string): Promise<number>;
  /** 用户停止 / 进程退出时的中止信号。 */
  signal?: AbortSignal;
}

type TurnOutcome =
  | { kind: "ok" }
  | { kind: "error"; error: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "attention"; error: string };

// ───────────────────────────── 进程内驱动表 ─────────────────────────────

interface RunningDriver {
  controller: AbortController;
  promise: Promise<void>;
}

const DRIVERS_KEY = Symbol.for("pi-web:campaign-drivers");

function drivers(): Map<string, RunningDriver> {
  const holder = globalThis as unknown as Record<symbol, Map<string, RunningDriver> | undefined>;
  return (holder[DRIVERS_KEY] ??= new Map<string, RunningDriver>());
}

export function isCampaignDriving(id: string): boolean {
  return drivers().has(id);
}

export function activeCampaignDriverCount(): number {
  return drivers().size;
}

// ───────────────────────────── 启动 / 停止 / 暂停 / 继续 ─────────────────────────────

/**
 * 启动驱动（后台跑，立即返回）。同一战役重复调用返回同一个 promise（幂等）；
 * 战役已被另一活进程驱动时 `runCampaignLoop` 会自行放弃。
 *
 * 测试/e2e 缝：`PI_WEB_DISABLE_CAMPAIGN_DRIVER=1` 时是 no-op（不建会话、不跑 git/验证），
 * 与 autofix 的 `PI_WEB_DISABLE_AUTOFIX_DRIVER` 同口径。
 */
export function startCampaign(
  id: string,
  options: { agentDir?: string; deps?: Partial<CampaignDeps> } = {},
): Promise<void> {
  if (process.env.PI_WEB_DISABLE_CAMPAIGN_DRIVER === "1") return Promise.resolve();
  const running = drivers().get(id);
  if (running) return running.promise;
  const controller = new AbortController();
  const deps = createLiveCampaignDeps({ ...options.deps, agentDir: options.agentDir, signal: controller.signal });
  const promise = runCampaignLoop(id, deps)
    .catch((error) => {
      console.error("[campaign] drive failed:", errorText(error));
    })
    .finally(() => {
      if (drivers().get(id)?.controller === controller) drivers().delete(id);
    });
  drivers().set(id, { controller, promise });
  return promise;
}

/** 用户停止：立刻落 `stopped`（循环每个检查点都会看到），再中止会话与驱动。 */
export async function stopCampaign(
  id: string,
  options: { agentDir?: string } = {},
): Promise<Campaign | undefined> {
  const campaign = getCampaign(id, options.agentDir);
  if (!campaign) return undefined;
  drivers().get(id)?.controller.abort();
  const updated = updateCampaign(
    id,
    (c) => ({ ...c, status: "stopped", pid: null, finishedAt: Date.now() }),
    options.agentDir,
  );
  emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: "stopped" });
  cancelCampaignOutage(updated ?? campaign, options.agentDir);
  await abortLiveCampaignSession(updated ?? campaign);
  return updated;
}

/** 用户暂停：落 `paused`（可 resume，不自动烧钱），中止当前回合。 */
export async function pauseCampaign(
  id: string,
  options: { agentDir?: string } = {},
): Promise<Campaign | undefined> {
  const campaign = getCampaign(id, options.agentDir);
  if (!campaign) return undefined;
  drivers().get(id)?.controller.abort();
  const updated = updateCampaign(
    id,
    (c) => ({ ...c, status: "paused", pid: null, finishedAt: null }),
    options.agentDir,
  );
  emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: "paused" });
  // 暂停期间不再等上游：收掉挂起记录，避免 resume 时误当「恢复轮」。
  cancelCampaignOutage(updated ?? campaign, options.agentDir);
  await abortLiveCampaignSession(updated ?? campaign);
  return updated;
}

/**
 * 手动继续（UI「继续」）：从**第一个非 done 的 available 项**（第 K 项）续跑，
 * 不从头。被选中的项拿一轮全新预算（round=0、rounds 清空）；战役 `totalRounds`
 * 保留（不白送预算）。已 succeeded 的战役原样返回（幂等）。
 */
export async function resumeCampaign(
  id: string,
  options: { agentDir?: string } = {},
): Promise<Campaign | undefined> {
  const campaign = getCampaign(id, options.agentDir);
  if (!campaign) return undefined;
  if (campaign.status === "succeeded") return campaign;
  if (isActiveCampaignStatus(campaign.status) && isCampaignDriving(id)) return campaign;
  cancelCampaignOutage(campaign, options.agentDir);
  const next = nextResumeItem(campaign);
  const updated = updateCampaign(
    id,
    (c) => ({
      ...c,
      status: "queued",
      pid: null,
      finishedAt: null,
      currentItemId: next?.id ?? null,
      items: c.items.map((item) => {
        if (next && item.id === next.id) {
          return { ...item, status: "pending", round: 0, rounds: [], lastError: null };
        }
        if (item.status === "running" || item.status === "verifying") {
          return { ...item, status: "pending" };
        }
        return item;
      }),
    }),
    options.agentDir,
  );
  if (updated) {
    emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: "queued" });
    void startCampaign(id, { agentDir: options.agentDir });
  }
  return updated;
}

// ───────────────────────────── 核心循环 ─────────────────────────────

/**
 * 驱动一个战役直到终结。导出供测试注入 deps；生产入口用 `startCampaign`。
 *
 * 认领：把 status 置 running、pid 置本进程，再**复核**落盘结果（跨进程同样发起认领时，
 * 落盘较晚者赢，另一侧看到 pid 不是自己就放弃——照 `driveAutofixTask` 的写法）。
 */
export async function runCampaignLoop(id: string, deps: CampaignDeps): Promise<void> {
  const agentDir = deps.agentDir;
  const now = () => deps.now();

  let campaign = getCampaign(id, agentDir);
  if (!campaign || !isActiveCampaignStatus(campaign.status)) return;
  if (
    (campaign.status === "running" || campaign.status === "verifying")
    && typeof campaign.pid === "number"
    && campaign.pid !== process.pid
    && deps.isPidAlive(campaign.pid)
  ) {
    return; // 另一活着的进程正在驱动，绝不去抢
  }

  updateCampaign(id, (c) => ({ ...c, status: "running", pid: process.pid }), agentDir);
  const claimed = getCampaign(id, agentDir);
  if (!claimed || claimed.pid !== process.pid || !isActiveCampaignStatus(claimed.status)) return;
  campaign = claimed;
  emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: "running" });

  const turnTimeoutMs = deps.turnTimeoutMs ?? AUTOFIX_TURN_TIMEOUT_MS;
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? AUTOFIX_VERIFY_TIMEOUT_MS;
  // 续跑注记：进程重启/暂停恢复后（已有轮次），首轮让模型先核对真实状态再动手。
  // 与 Provider 中断恢复共用 `buildRecoveryNote`，只注入一次。
  let pendingResumeNote: string | null = campaign.totalRounds > 0
    ? buildRecoveryNote({
        task: campaign.objective,
        cwd: campaign.cwd,
        round: campaign.totalRounds,
        lastError: campaign.lastError,
      })
    : null;

  for (;;) {
    if (deps.signal?.aborted) {
      finishCampaign(id, "stopped", null, deps);
      return;
    }
    // 每一轮都重读：外部（UI / sweep / 删除）可能改了状态。
    campaign = getCampaign(id, agentDir);
    if (!campaign) return;
    if (!isActiveCampaignStatus(campaign.status)) return;

    // ── 过闸（§5/§6）：战役级硬顶 + 单项轮次封顶 ──
    const stop = campaignRuntimeStop(campaign, now());
    if (stop) {
      handleRuntimeStop(id, stop, campaign, deps);
      return;
    }

    // ── 选当前项（续跑时优先接着 currentItemId，否则取 backlog 第一项可用项） ──
    const selection = selectItem(campaign);
    if (selection.kind === "done") {
      finishCampaign(id, "succeeded", null, deps);
      return;
    }
    if (selection.kind === "blocked") {
      finishCampaign(id, "failed", "Every remaining item is blocked by an unfinished dependency", deps);
      return;
    }
    const selected = selection.item;

    const itemIndex = campaign.items.findIndex((item) => item.id === selected.id) + 1;
    const previousItemRound = selected.round;
    const previousTotalRounds = campaign.totalRounds;
    const round = selected.round + 1;

    // 标记本项 running，累加本项轮次与战役总轮次。
    campaign = updateCampaign(id, (c) => ({
      ...c,
      status: "running",
      pid: process.pid,
      currentItemId: selected.id,
      totalRounds: previousTotalRounds + 1,
      items: c.items.map((item) => (item.id === selected.id ? { ...item, status: "running", round } : item)),
    }), agentDir) ?? campaign;
    emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: "running" });
    const item = campaign.items.find((entry) => entry.id === selected.id);
    if (!item) return; // 被外部删除

    // ── 组装 prompt（Provider 恢复注记 + 续跑注记 + 本项指令） ──
    const outage = campaign.sessionId ? getOutageRecord(campaign.sessionId, agentDir) : undefined;
    const outageNote = outage?.status === "waiting"
      ? buildRecoveryNote({
          task: campaign.objective,
          cwd: campaign.cwd,
          round: previousItemRound,
          lastError: outage.reason,
        })
      : null;
    const recovery = [outageNote, pendingResumeNote].filter(Boolean).join("\n\n") || null;
    pendingResumeNote = null;
    const prompt = [
      recovery,
      buildCampaignPrompt({
        objective: campaign.objective,
        cwd: campaign.cwd,
        item: {
          title: item.title,
          instruction: item.instruction,
          acceptance: item.acceptance,
          verifyCommand: item.verifyCommand,
        },
        itemIndex,
        itemCount: campaign.items.length,
        round,
        maxRounds: item.maxRounds,
        lastError: item.lastError,
        lastOutputTail: lastVerifyTail(item),
      }),
    ].filter(Boolean).join("\n\n");

    // ── 打开会话 ──
    let opened: OpenedCampaignSession;
    try {
      opened = await deps.openSession(campaign);
    } catch (error) {
      finishCampaign(id, "failed", `Could not open the campaign session: ${errorText(error)}`, deps);
      return;
    }
    if (opened.sessionId !== campaign.sessionId) {
      campaign = updateCampaign(id, (c) => ({ ...c, sessionId: opened.sessionId }), agentDir) ?? campaign;
    }

    // ── agent 回合 ──
    const turn = await runAgentTurn(opened.session, prompt, { timeoutMs: turnTimeoutMs, signal: deps.signal });
    if (deps.signal?.aborted) {
      finishCampaign(id, "stopped", null, deps);
      return;
    }
    if (turn.kind === "aborted") {
      finishCampaign(id, "stopped", "Stopped while the agent was working", deps);
      return;
    }
    if (turn.kind === "attention") {
      finishCampaign(id, "stopped", turn.error, deps);
      return;
    }
    if (turn.kind !== "ok") {
      const error = turn.kind === "timeout"
        ? `Agent turn timed out after ${Math.round(turnTimeoutMs / 60_000)} minutes`
        : turn.error;
      // Provider 中断：**不消耗轮次**、不判失败——转 waiting-provider，等 outage 退避后由
      // 本文件 sweep 重新驱动。只有 `turn.kind === "error"` 才分类（timeout/aborted/attention
      // 与上游无关）。
      if (turn.kind === "error") {
        const classification = classifyOutageError({ errorText: error });
        if (classification.suspend && isOutageSuspendKind(classification.kind)) {
          const suspended = suspendForProviderOutage(
            id,
            campaign,
            item.id,
            previousItemRound,
            previousTotalRounds,
            classification.kind,
            error,
            deps,
          );
          if (suspended) return;
        }
      }
      recordItemRound(id, item.id, {
        round,
        at: now(),
        status: turn.kind === "timeout" ? "timeout" : "agent-error",
        verifyExitCode: null,
        error: tailOf(error, AUTOFIX_ERROR_MAX_CHARS),
      }, deps);
      if (round >= item.maxRounds) {
        failItem(id, item.id, error, deps);
        finishCampaign(id, "failed", error, deps);
        return;
      }
      continue;
    }

    // 上游恢复、本轮跑通：挂起记录收口（attempts/退避作废，不再续跑该会话）。
    if (campaign.sessionId) finishRunOutageRecord(campaign.sessionId, agentDir);

    // ── 判据：引擎自己跑验证命令（exit 0 = 本项完成） ──
    campaign = updateCampaign(id, (c) => ({
      ...c,
      status: "verifying",
      pid: process.pid,
      items: c.items.map((entry) => (entry.id === item.id ? { ...entry, status: "verifying" } : entry)),
    }), agentDir) ?? campaign;
    emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: "verifying" });
    let verify: VerifyOutcome;
    try {
      verify = await deps.runVerify(item.verifyCommand, campaign.cwd, { timeoutMs: verifyTimeoutMs });
    } catch (error) {
      verify = { exitCode: null, timedOut: false, outputTail: errorText(error), durationMs: 0 };
    }
    if (deps.signal?.aborted) {
      finishCampaign(id, "stopped", null, deps);
      return;
    }

    const passed = !verify.timedOut && verify.exitCode === 0;
    const failure = passed ? null : verifyFailureText(verify);
    recordItemRound(id, item.id, {
      round,
      at: now(),
      status: passed ? "verify-passed" : "verify-failed",
      verifyExitCode: verify.timedOut ? null : verify.exitCode,
      ...(passed
        ? { outputTail: tailOf(verify.outputTail, AUTOFIX_OUTPUT_TAIL_MAX_CHARS) }
        : {
            error: tailOf(failure ?? "Verification failed", AUTOFIX_ERROR_MAX_CHARS),
            outputTail: tailOf(verify.outputTail, AUTOFIX_OUTPUT_TAIL_MAX_CHARS),
          }),
    }, deps);

    // 可选成本累计（P1 生产不接；留给 P3 成本运行中闸）。
    if (deps.readSessionCost && campaign.sessionId) {
      try {
        const total = await deps.readSessionCost(campaign.sessionId);
        if (Number.isFinite(total) && total >= 0) {
          campaign = updateCampaign(
            id,
            (c) => ({ ...c, spentCostUsd: Math.max(c.spentCostUsd, total) }),
            agentDir,
          ) ?? campaign;
        }
      } catch {
        // 成本读取失败不阻断推进。
      }
    }

    if (passed) {
      // 本项 done → 清 currentItemId，下一轮取 backlog 下一项（或全 done → succeeded）。
      campaign = updateCampaign(id, (c) => ({
        ...c,
        status: "running",
        pid: process.pid,
        currentItemId: null,
        items: c.items.map((entry) => (entry.id === item.id ? { ...entry, status: "done" } : entry)),
      }), agentDir) ?? campaign;
      emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: "running" });
      continue;
    }
    if (round >= item.maxRounds) {
      // 本项轮次封顶 → 该项 failed → 战役 failed（P1 不 continueOnItemFailure）。
      failItem(id, item.id, failure ?? "Verification failed", deps);
      finishCampaign(id, "failed", failure ?? "Verification failed", deps);
      return;
    }
    // 否则继续本项下一轮：失败输出已在 rounds 记录里，下一轮 prompt 会带上。
  }
}

// ───────────────────────────── 选项选择 / 收尾辅助 ─────────────────────────────

type ItemSelection = { kind: "work"; item: CampaignItem } | { kind: "done" } | { kind: "blocked" };

/**
 * 选当前要推进的项：
 * 1. `currentItemId` 指向一个未完成的项（pending/running/verifying）→ 接着做它（失败回喂后
 *    仍复用同一项，直到 done/failed）；
 * 2. 否则取 backlog 第一项可用项（`availableItems`：pending 且依赖全 done）；
 * 3. 都没有：全部 done/skipped → done；仍有剩余却被依赖卡住 → blocked。
 */
function selectItem(campaign: Campaign): ItemSelection {
  const current = campaign.currentItemId
    ? campaign.items.find((item) => item.id === campaign.currentItemId)
    : undefined;
  if (current && (current.status === "pending" || current.status === "running" || current.status === "verifying")) {
    return { kind: "work", item: current };
  }
  const available = availableItems(campaign);
  if (available.length > 0) return { kind: "work", item: available[0] };
  const progress = campaignProgress(campaign);
  return progress.remaining === 0 ? { kind: "done" } : { kind: "blocked" };
}

function handleRuntimeStop(id: string, stop: CampaignRuntimeStop, campaign: Campaign, deps: CampaignDeps): void {
  if (stop === "maxTotalCostUsd") {
    finishCampaign(id, "paused", `Cost budget of $${campaign.maxTotalCostUsd} exhausted`, deps);
    return;
  }
  if (stop === "maxTotalRounds" || stop === "maxItems") {
    finishCampaign(id, "failed", `Campaign hard limit reached: ${stop}`, deps);
    return;
  }
  // itemMaxRounds：标记卡住的项 failed，再让整个战役 failed。
  const stuck = campaign.items.find(
    (item) => item.status !== "done" && item.status !== "skipped" && itemRoundExceeded(item),
  );
  if (stuck) failItem(id, stuck.id, stuck.lastError ?? `Item ${stuck.id} hit its round limit`, deps);
  finishCampaign(id, "failed", stuck ? `Item ${stuck.id} hit its round limit` : "An item hit its round limit", deps);
}

function recordItemRound(id: string, itemId: string, round: CampaignRound, deps: CampaignDeps): void {
  const updated = updateCampaign(id, (c) => ({
    ...c,
    items: c.items.map((item) => (item.id === itemId
      ? { ...item, rounds: [...item.rounds, round], lastError: round.error ?? item.lastError }
      : item)),
  }), deps.agentDir);
  if (updated) emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: updated.status });
}

function failItem(id: string, itemId: string, error: string, deps: CampaignDeps): void {
  updateCampaign(id, (c) => ({
    ...c,
    items: c.items.map((item) => (item.id === itemId
      ? { ...item, status: "failed", lastError: tailOf(error, CAMPAIGN_ERROR_MAX_CHARS) }
      : item)),
  }), deps.agentDir);
}

/**
 * 收尾：写终态 + 广播。**若用户已把战役置为另一个终态（paused / stopped），不覆盖**——
 * 暂停/停止在回合中途发生时会与循环自己的 "stopped" 收尾竞争，这里保护用户的意图。
 */
function finishCampaign(id: string, status: CampaignStatus, lastError: string | null, deps: CampaignDeps): void {
  const current = getCampaign(id, deps.agentDir);
  if (!current) return;
  if (isTerminalCampaignStatus(current.status) && current.status !== status) return;
  const updated = updateCampaign(id, (c) => ({
    ...c,
    status,
    pid: null,
    finishedAt: deps.now(),
    ...(lastError ? { lastError: tailOf(lastError, CAMPAIGN_ERROR_MAX_CHARS) } : {}),
  }), deps.agentDir);
  if (updated) emitCampaignEvent({ type: "campaign_changed", campaignId: id, status });
}

// ───────────────────────────── Provider 中断（复用 lib/outage/**） ─────────────────────────────

/**
 * Provider 中断：**不消耗轮次**、不判失败——把本项 round 与战役 totalRounds 退回触发这一轮
 * 之前的数值，战役转 `waiting-provider`，并在该战役会话上落一条 outage 记录。
 *
 * 返回 true 表示已挂起（调用方应停止循环）；false 表示用户关闭了自动等待（settings 关闭 /
 * 额度等待 0），按普通失败轮处理（由调用方记账）。
 *
 * scope 用 `"campaign"`：通用 outage 调度器见到该 scope 会跳过（`scheduler.ts`），由本文件的
 * sweep 自己驱动——它还要跑验证命令并推进项轮次，绝不能让通用调度器去双驱动。
 */
function suspendForProviderOutage(
  id: string,
  campaign: Campaign,
  itemId: string,
  previousItemRound: number,
  previousTotalRounds: number,
  kind: OutageSuspendKind,
  error: string,
  deps: CampaignDeps,
): boolean {
  const agentDir = deps.agentDir;
  const at = deps.now();
  const settings = readOutageSettings(outageSettingsPath(agentDir));
  const maxWaitMs = outageMaxWaitMs(kind, settings);

  // 用户关闭了自动等待（或额度等待设为 0）：按普通失败轮上报，尊重设置。
  if (!settings.enabled || maxWaitMs <= 0) return false;

  const sessionId = campaign.sessionId;
  if (sessionId) {
    const existing = getOutageRecord(sessionId, agentDir);
    let expired = false;
    if (existing?.status === "waiting") {
      const advanced = advanceOutageBudget(existing, at);
      expired = advanced.expired;
      updateOutageRecord(sessionId, () => ({
        ...advanced.record,
        reason: tailOf(error, CAMPAIGN_ERROR_MAX_CHARS),
        lastAttemptAt: at,
        lastError: null,
      }), agentDir);
    } else {
      // 没有等待中的记录（首次挂起，或旧记录已结束）：新建一条。
      createOutageRecord({
        sessionId,
        kind,
        reason: tailOf(error, CAMPAIGN_ERROR_MAX_CHARS),
        // scope="campaign"：通用 outage 调度器见到该 scope 会跳过（`scheduler.ts`），
        // 由 campaign sweep 自己驱动（它还要跑验证命令并推进项轮次），避免双驱动。
        scope: "campaign",
        origin: { provider: null, modelId: null },
        resume: { mode: "followup", note: "Campaign round interrupted by a provider outage." },
        budget: initialOutageBudget({
          kind,
          now: at,
          maxWaitMs,
          maxAttempts: OUTAGE_DEFAULT_MAX_ATTEMPTS,
        }),
        guard: {},
        pid: process.pid,
        now: at,
      }, agentDir);
    }
    if (expired) {
      finishOutageRecord(sessionId, "expired", at, { lastError: tailOf(error, CAMPAIGN_ERROR_MAX_CHARS) }, agentDir);
      failItem(id, itemId, `Provider unavailable for too long: ${error}`, deps);
      finishCampaign(id, "failed", `Provider unavailable for too long: ${error}`, deps);
      return true;
    }
  }

  // 不消耗轮次：退回 round / totalRounds，本项回到 pending（依赖已满足，仍会被选中）。
  updateCampaign(id, (c) => ({
    ...c,
    status: "waiting-provider",
    pid: null,
    totalRounds: previousTotalRounds,
    lastError: tailOf(error, CAMPAIGN_ERROR_MAX_CHARS),
    items: c.items.map((item) => (item.id === itemId ? { ...item, round: previousItemRound, status: "pending" } : item)),
  }), agentDir);
  emitCampaignEvent({ type: "campaign_changed", campaignId: id, status: "waiting-provider" });
  return true;
}

/** 一轮成功跑通 ⇒ 上游已恢复：挂起记录收口为 resumed（不删除，保留排障轨迹）。 */
function finishRunOutageRecord(sessionId: string, agentDir: string | undefined): void {
  const record = getOutageRecord(sessionId, agentDir);
  if (record?.status !== "waiting") return;
  finishOutageRecord(sessionId, "resumed", Date.now(), {}, agentDir);
}

// ───────────────────────────── 接续（sweep 约定出口） ─────────────────────────────

export interface CampaignResumableOptions {
  now: number;
  staleMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

/**
 * 纯判定：这个战役是否「该由 sweep 接续」。口径与 `isAutofixTaskResumable` 逐字对齐：
 * - 非活跃状态 → false；`waiting-provider` 的重试时机由 outage 记录决定，这里一律不接；
 * - `queued` 且无 owner → true；
 * - pid 非空且进程活着 → false（绝不抢）；pid 已死 → true；
 * - pid 缺失：只有 `updatedAt` 超过 `staleMs` 才 true。
 */
export function isCampaignResumable(campaign: Campaign, options: CampaignResumableOptions): boolean {
  if (!isActiveCampaignStatus(campaign.status)) return false;
  if (isWaitingProviderStatus(campaign.status)) return false;
  if (campaign.status === "queued" && (campaign.pid === null || campaign.pid === undefined)) return true;
  if (typeof campaign.pid === "number") {
    const alive = options.isPidAlive?.(campaign.pid);
    return alive === true ? false : true;
  }
  return options.now - campaign.updatedAt >= (options.staleMs ?? CAMPAIGN_STALE_MS);
}

export interface SweepCampaignsOptions {
  now?: number;
  staleMs?: number;
  agentDir?: string;
}

/**
 * 扫全量战役，把「活跃 + 孤儿」的重新驱动。**不抛错、幂等**（进程级 sweep 直接调用）：
 * - `waiting-provider`：先查 outage 记录（退避/死线），到点即 requeue 为 queued；
 * - 其余活跃态按 `isCampaignResumable` 判孤儿；
 * - 并发上限 MAX_CONCURRENT_DRIVERS：一次最多启动一个（其余保持 queued 等下一 tick）。
 */
export async function sweepCampaigns(
  options: SweepCampaignsOptions = {},
): Promise<{ examined: number; resumed: string[] }> {
  const resumed: string[] = [];
  let examined = 0;
  try {
    const now = options.now ?? Date.now();
    const campaigns = listCampaigns(options.agentDir);
    examined = campaigns.length;
    for (const campaign of campaigns) {
      if (isCampaignDriving(campaign.id)) continue;
      // Provider 中断挂起：重试时机由 outage 记录决定（退避/死线），不是 pid/staleness。
      if (isWaitingProviderStatus(campaign.status)) {
        const record = campaign.sessionId ? getOutageRecord(campaign.sessionId, options.agentDir) : undefined;
        if (!record) {
          finishCampaignInSweep(
            campaign.id,
            "failed",
            campaign.lastError ?? "Provider outage record was removed",
            now,
            options.agentDir,
          );
          continue;
        }
        if (record.status !== "waiting" || isOutageExpired(record, now)) {
          if (record.status === "waiting" && campaign.sessionId) {
            finishOutageRecord(campaign.sessionId, "expired", now, {}, options.agentDir);
          }
          finishCampaignInSweep(
            campaign.id,
            "failed",
            campaign.lastError ?? "Provider unavailable for too long",
            now,
            options.agentDir,
          );
          continue;
        }
        if (!isOutageDue(record, now)) continue; // 退避未到
        const requeued = updateCampaign(
          campaign.id,
          (c) => ({ ...c, status: "queued", pid: null }),
          options.agentDir,
        );
        if (!requeued) continue;
        resumed.push(campaign.id);
        emitCampaignEvent({ type: "campaign_changed", campaignId: campaign.id, status: "queued" });
        continue;
      }
      if (!isCampaignResumable(campaign, { now, staleMs: options.staleMs, isPidAlive })) continue;
      // 释放旧 owner，排队等驱动（queued 是无主状态，任何 tick 都可接）。
      const requeued = updateCampaign(
        campaign.id,
        (c) => ({ ...c, status: "queued", pid: null }),
        options.agentDir,
      );
      if (!requeued) continue;
      resumed.push(campaign.id);
      emitCampaignEvent({ type: "campaign_changed", campaignId: campaign.id, status: "queued" });
    }
    if (resumed.length > 0 && activeCampaignDriverCount() < MAX_CONCURRENT_DRIVERS) {
      // listCampaigns 最新在前：接最老的那个。
      const next = resumed[resumed.length - 1];
      void startCampaign(next, { agentDir: options.agentDir });
    }
  } catch (error) {
    console.error("[campaign] sweep failed:", errorText(error));
  }
  return { examined, resumed };
}

/** sweep 专用的终态收口（不持有 CampaignDeps；只落盘 + 广播）。 */
function finishCampaignInSweep(
  id: string,
  status: CampaignStatus,
  lastError: string | null,
  now: number,
  agentDir: string | undefined,
): void {
  const current = getCampaign(id, agentDir);
  if (!current) return;
  if (isTerminalCampaignStatus(current.status) && current.status !== status) return;
  const updated = updateCampaign(id, (c) => ({
    ...c,
    status,
    pid: null,
    finishedAt: now,
    ...(lastError ? { lastError: tailOf(lastError, CAMPAIGN_ERROR_MAX_CHARS) } : {}),
  }), agentDir);
  if (updated) emitCampaignEvent({ type: "campaign_changed", campaignId: id, status });
}

const SWEEP_KEY = Symbol.for("pi-web:campaign-sweep");

/**
 * 进程级接续循环（instrumentation 启动）：启动立刻扫一次，之后每 tick 一次。
 * 幂等（globalThis 记账）；`PI_WEB_DISABLE_SCHEDULER=1` 时由调用方不启动。
 */
export function startCampaignSweep(options: { tickMs?: number } = {}): void {
  const holder = globalThis as unknown as Record<symbol, { timer: ReturnType<typeof setInterval> } | undefined>;
  if (holder[SWEEP_KEY]) return;
  const tickMs = options.tickMs ?? 60_000;
  let sweeping = false;
  const sweep = (): void => {
    if (sweeping) return;
    sweeping = true;
    void sweepCampaigns()
      .catch((error) => console.error("[campaign] sweep failed:", errorText(error)))
      .finally(() => {
        sweeping = false;
      });
  };
  sweep();
  const timer = setInterval(sweep, tickMs);
  timer.unref?.();
  holder[SWEEP_KEY] = { timer };
}

// ───────────────────────────── 回合 / 辅助 ─────────────────────────────

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 本项最近一次验证失败输出（给下一轮 prompt）。 */
function lastVerifyTail(item: CampaignItem): string | null {
  for (let index = item.rounds.length - 1; index >= 0; index -= 1) {
    const round = item.rounds[index];
    if (round.status === "verify-failed" && round.outputTail) return round.outputTail;
  }
  return null;
}

function verifyFailureText(verify: VerifyOutcome): string {
  if (verify.timedOut) return "Verification timed out";
  return `Verification failed with exit code ${verify.exitCode ?? "unknown"}`;
}

/**
 * 发一轮 prompt 并等这一回合结束（与 autofix `runAgentTurn` 逐字同形）。
 *
 * 结束判据：`prompt_done`（SDK 在回合彻底结束后发；含 retry/续跑管线）。
 * 阻断型扩展对话框（confirm/select/input/editor/custom）在无人值守时没人回答，
 * 直接判 attention 并中止，避免每轮都干等到超时。
 */
function runAgentTurn(
  session: CampaignSessionLike,
  prompt: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve) => {
    let settled = false;
    let lastAssistant: Record<string, unknown> | undefined;
    let promptError: string | undefined;
    let unsubscribe: () => void = () => {};
    const cleanup: { timer?: ReturnType<typeof setTimeout>; onAbort?: () => void } = {};

    const settle = (outcome: TurnOutcome): void => {
      if (settled) return;
      settled = true;
      if (cleanup.timer) clearTimeout(cleanup.timer);
      if (cleanup.onAbort) options.signal?.removeEventListener("abort", cleanup.onAbort);
      unsubscribe();
      resolve(outcome);
    };

    const abortRun = (): void => {
      void session.send({ type: "abort" }).catch(() => undefined);
    };

    unsubscribe = session.onEvent((event) => {
      if (event.type === "extension_ui_request") {
        const request = event as unknown as ExtensionUiRequest;
        if (isBlockingExtensionUiRequest(request)) {
          abortRun();
          settle({
            kind: "attention",
            error: `The agent is waiting for an answer to a "${(request as BlockingExtensionUiRequest).method}" dialog; open the session to continue`,
          });
        }
        return;
      }
      if (event.type === "message_end") {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role === "assistant") lastAssistant = message;
        return;
      }
      if (event.type === "prompt_error") {
        promptError = typeof event.errorMessage === "string" ? event.errorMessage : "Prompt failed";
        return;
      }
      if (event.type !== "prompt_done") return;
      if (promptError) {
        settle({ kind: "error", error: promptError });
        return;
      }
      const stopReason = lastAssistant?.stopReason;
      if (stopReason === "error") {
        settle({
          kind: "error",
          error: typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : "Model request failed",
        });
        return;
      }
      if (stopReason === "aborted") {
        settle({ kind: "aborted" });
        return;
      }
      settle({ kind: "ok" });
    });
    // onEvent 会同步回放 pending 事件（可能在我们拿到退订函数之前就 settle 了）。
    if (settled) {
      unsubscribe();
      return;
    }

    if (options.signal?.aborted) {
      settle({ kind: "aborted" });
      return;
    }
    cleanup.onAbort = () => {
      abortRun();
      settle({ kind: "aborted" });
    };
    options.signal?.addEventListener("abort", cleanup.onAbort, { once: true });

    cleanup.timer = setTimeout(() => {
      abortRun();
      settle({ kind: "timeout" });
    }, options.timeoutMs);
    cleanup.timer.unref?.();

    void Promise.resolve()
      .then(() => session.send({ type: "prompt", message: prompt }))
      .catch((error) => settle({ kind: "error", error: errorText(error) }));
  });
}

// ───────────────────────────── 中止 live 会话 / 收掉 outage ─────────────────────────────

async function abortLiveCampaignSession(campaign: Campaign): Promise<void> {
  if (!campaign.sessionId) return;
  try {
    const { getRpcSession } = await import("../rpc-manager");
    const wrapper = getRpcSession(campaign.sessionId);
    if (wrapper?.isAlive() && wrapper.isRunning()) {
      void wrapper.send({ type: "abort" }).catch(() => undefined);
    }
  } catch {
    // A session that is gone needs no abort.
  }
}

function cancelCampaignOutage(campaign: Campaign, agentDir: string | undefined): void {
  if (!campaign.sessionId) return;
  try {
    cancelOutageRecord(campaign.sessionId, agentDir);
  } catch {
    // 记录不存在 / 读不动：没有可取消的。
  }
}

// ───────────────────────────── 生产依赖 ─────────────────────────────

/** 组装生产 deps（rpc-manager 惰性 import，保持启动路径轻）。 */
export function createLiveCampaignDeps(overrides: Partial<CampaignDeps> = {}): CampaignDeps {
  return {
    now: () => Date.now(),
    isPidAlive,
    async openSession(campaign) {
      return openLiveCampaignSession(campaign);
    },
    runVerify(command, cwd, options) {
      return runVerifyCommand(command, cwd, { timeoutMs: options.timeoutMs });
    },
    ...overrides,
  };
}

/**
 * 打开战役会话：已有 sessionId 且进程内存活 → 直接用；有会话文件 → 按 id 重开
 * （对话上下文继续）；都没有 → 新建。新建时钉工具集 + 写标记条目 + 命名会话。
 *
 * **不带 `skipToolApproval`**（与 autofix 的关键差异，安全闸 §6）：战役会话不跳过审批，
 * 危险命令仍要用户确认；无人值守时由 autopilot 的对话框超时取安全默认兜底。
 */
async function openLiveCampaignSession(campaign: Campaign): Promise<OpenedCampaignSession> {
  const [{ getRpcSession, startRpcSession }, { resolveSessionPath, invalidateSessionListCache }, { allowFileRoot }] =
    await Promise.all([
      import("../rpc-manager"),
      import("../session-reader"),
      import("../file-access"),
    ]);
  const toolNames = [...CAMPAIGN_TOOL_NAMES];

  if (campaign.sessionId) {
    const existing = getRpcSession(campaign.sessionId);
    if (existing?.isAlive()) {
      return {
        session: existing as unknown as CampaignSessionLike,
        sessionId: campaign.sessionId,
        created: false,
      };
    }
    const filePath = await resolveSessionPath(campaign.sessionId);
    if (filePath) {
      // 重开时不跳过审批：审批档沿用会话设置（创建时 gate 已保证 ≥ dangerous）。
      const { session } = await startRpcSession(campaign.sessionId, filePath, undefined, { toolNames });
      return { session: session as unknown as CampaignSessionLike, sessionId: campaign.sessionId, created: false };
    }
  }

  const { session, realSessionId } = await startRpcSession(
    `__campaign__${randomUUID()}`,
    "",
    campaign.cwd,
    { toolNames, allowInitialModelFallback: true },
  );
  allowFileRoot(campaign.cwd);
  invalidateSessionListCache();
  try {
    session.inner?.sessionManager?.appendCustomEntry?.(CAMPAIGN_ENTRY_TYPE, {
      version: 1,
      campaignId: campaign.id,
      objective: campaign.objective,
    });
    await session.send({ type: "set_session_name", name: campaignSessionName(campaign.objective) });
  } catch {
    // 命名/标记失败只损失可读性，不影响战役循环。
  }
  return { session: session as unknown as CampaignSessionLike, sessionId: realSessionId, created: true };
}
