/**
 * 「长时自主项目战役（campaign）」的**纯类型与纯判定层**。
 *
 * 设计见 `docs/agents/fork-long-run-campaign.md` §1。约束（勿破）：
 * - 本文件**不 import node:fs / pi SDK**：客户端（组件、hook）直接 import 它；
 * - 状态迁移与硬闸判据全部是纯函数，单测直接锁死；
 * - 字段名是 runner / API 的稳定契约，与设计文档 §1 逐字一致。
 *
 * 与 autofix 的关系：一个 campaign = 有序、带依赖的 backlog；每项自带
 * `verifyCommand`（exit 0 才算 done），逐项复用 autofix 的「引擎侧判据」哲学。
 * 轮次记录的形状直接复用 `AutofixRound`，不另造一套（§1）。
 */

import { AUTOFIX_MAX_ROUNDS, AUTOFIX_VERIFY_MAX_LENGTH } from "../autofix/types";
import type { AutofixRound } from "../autofix/types";

// ───────────────────────────── 常量 ─────────────────────────────

/** 单项默认轮次上限：一轮 = 一次 agent 回合 + 一次验证（复用 AUTOFIX_MAX_ROUNDS=20）。 */
export const CAMPAIGN_DEFAULT_ITEM_MAX_ROUNDS = AUTOFIX_MAX_ROUNDS;
/** 单项轮次上限的绝对上限（与 autofix 对齐）。 */
export const CAMPAIGN_ITEM_MAX_ROUNDS_LIMIT = AUTOFIX_MAX_ROUNDS;
/** 默认项数硬顶（防无界 backlog）。 */
export const CAMPAIGN_DEFAULT_MAX_ITEMS = 40;
/** 项数硬顶允许的最大值（创建校验用）。 */
export const CAMPAIGN_MAX_ITEMS_LIMIT = 200;
/** 全战役轮数硬顶的默认值（§1.1 / §6）。 */
export const CAMPAIGN_MAX_TOTAL_ROUNDS = 400;
/** 全战役轮数硬顶允许的最大值（创建校验用）。 */
export const CAMPAIGN_MAX_TOTAL_ROUNDS_LIMIT = 4000;

/** 项目总目标最大长度（字符）。 */
export const CAMPAIGN_OBJECTIVE_MAX_LENGTH = 4000;
/** item 标题最大长度。 */
export const CAMPAIGN_ITEM_TITLE_MAX_LENGTH = 200;
/** item 任务说明最大长度。 */
export const CAMPAIGN_ITEM_INSTRUCTION_MAX_LENGTH = 4000;
/** item 完成判据（人类可读）最大长度。 */
export const CAMPAIGN_ACCEPTANCE_MAX_LENGTH = 2000;
/** item 机器判据命令最大长度（与 autofix 一致）。 */
export const CAMPAIGN_VERIFY_MAX_LENGTH = AUTOFIX_VERIFY_MAX_LENGTH;
/** `lastError` 落盘上限（字符）。 */
export const CAMPAIGN_ERROR_MAX_CHARS = 2000;
/** 每项保留的轮次记录上限（更早的丢弃；与 autofix 一致）。 */
export const CAMPAIGN_MAX_ROUND_RECORDS = 50;
/** 同时存在的战役上限（防止目录无限膨胀）。 */
export const CAMPAIGN_MAX_CAMPAIGNS = 50;
/** 孤儿判定：pid 缺失时，多久没更新才视为「无人驱动」（10 分钟，与 autofix 一致）。 */
export const CAMPAIGN_STALE_MS = 600_000;

// ───────────────────────────── 状态 ─────────────────────────────

/** 战役状态：活跃四态 + 暂停 + 三种终态。 */
export const CAMPAIGN_STATUSES = [
  "queued",
  "running",
  "verifying",
  /** 上游不可用：不消耗轮次，等 outage 调度器/下一轮 sweep 重新驱动。 */
  "waiting-provider",
  /** 成本闸触顶 / 用户暂停：可 resume，但不自动烧钱。 */
  "paused",
  "succeeded",
  "failed",
  "stopped",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** 单项状态。 */
export const CAMPAIGN_ITEM_STATUSES = [
  "pending",
  "running",
  "verifying",
  "done",
  "failed",
  "skipped",
] as const;
export type ItemStatus = (typeof CAMPAIGN_ITEM_STATUSES)[number];

/** 一轮的落地记录：直接复用 autofix 的轮次形状（§1）。 */
export type CampaignRound = AutofixRound;

// ───────────────────────────── 数据 ─────────────────────────────

/** 一项 backlog。 */
export interface CampaignItem {
  /** item-1, item-2 …（战役内稳定）。 */
  id: string;
  /** 一句话标题（列表展示）。 */
  title: string;
  /** 给 agent 的该项任务说明。 */
  instruction: string;
  /** 人类可读的完成判据（展示 / 未来裁判兜底）。 */
  acceptance: string;
  /** 机器判据（exit 0 = done）；P1 必填（§1）。 */
  verifyCommand: string;
  /** 前序 item id（DAG；全部 done 才 available）。 */
  dependsOn: string[];
  status: ItemStatus;
  /** 本项已用轮数。 */
  round: number;
  /** 本项轮数上限。 */
  maxRounds: number;
  /** 本项累计花费（USD）。 */
  costUsd: number;
  /** P2：每项 done 后的 git checkpoint。 */
  checkpoint?: { sha?: string; patchPath?: string; at: number };
  lastError: string | null;
  /** 轮次记录（capped 到 CAMPAIGN_MAX_ROUND_RECORDS）。 */
  rounds: CampaignRound[];
}

/** 落盘 v1 的战役。 */
export interface Campaign {
  version: 1;
  /** randomUUID()，文件名即 id。 */
  id: string;
  /** 项目总目标（一句话/一段）。 */
  objective: string;
  /** 战役工作目录（必须是 git 仓）。 */
  cwd: string;
  status: CampaignStatus;
  /** 有序 backlog（顺序=默认执行序；dependsOn 再约束）。 */
  items: CampaignItem[];
  currentItemId: string | null;
  // ── 硬闸（§5、§6）──
  /** 全战役轮数硬顶。 */
  maxTotalRounds: number;
  /** 项数硬顶（防无界）。 */
  maxItems: number;
  /** 成本闸；必须 > 0，否则拒绝启动（§5）。 */
  maxTotalCostUsd: number;
  /** 累计花费（每轮结束后累加）。 */
  spentCostUsd: number;
  totalRounds: number;
  // ── 跨天唤醒（§4）──
  /** 0 = 连续；>0 = 每段之间等待（复用 goal 的语义）。 */
  intervalMs: number;
  nextRunAt?: number;
  // ── 生命期 ──
  /** 战役主会话（每项可复用同一会话，上下文延续）。 */
  sessionId: string | null;
  /** 驱动进程（=Next server），照 autofix 语义。 */
  pid: number | null;
  startedAt: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  lastError: string | null;
  /** P2：项目记忆/笔记文件（§7）。 */
  truthFile?: string;
}

/**
 * 创建战役时的单项草稿：item id 由 store 按顺序生成 `item-<n>`（从 1 起），
 * 因此 `dependsOn` 里的引用写作 `item-1`、`item-2` …。
 */
export interface CampaignItemDraft {
  title: string;
  instruction: string;
  acceptance?: string;
  verifyCommand: string;
  dependsOn?: string[];
  /** 缺省 = CAMPAIGN_DEFAULT_ITEM_MAX_ROUNDS。 */
  maxRounds?: number;
}

/** 创建战役的入参（API 层校验后交给 store）。 */
export interface CampaignCreateInput {
  objective: string;
  cwd: string;
  items: CampaignItemDraft[];
  /** 必填且 > 0（§5 成本闸前置）。 */
  maxTotalCostUsd: number;
  /** 缺省 = CAMPAIGN_DEFAULT_MAX_ITEMS；须 >= items.length。 */
  maxItems?: number;
  /** 缺省 = CAMPAIGN_MAX_TOTAL_ROUNDS。 */
  maxTotalRounds?: number;
  /** 缺省 0（连续推进）。 */
  intervalMs?: number;
  truthFile?: string;
}

// ───────────────────────────── 纯判定 ─────────────────────────────

/** 纯判定：状态是否活跃（可能还需要驱动）。 */
export function isActiveCampaignStatus(status: CampaignStatus): boolean {
  return status === "queued" || status === "running" || status === "verifying" || status === "waiting-provider";
}

/** 纯判定：状态是否已终结。 */
export function isTerminalCampaignStatus(status: CampaignStatus): boolean {
  return !isActiveCampaignStatus(status);
}

/** 纯判定：是否在等上游恢复（由 outage 记录而不是 pid/staleness 决定何时重试）。 */
export function isWaitingProviderStatus(status: CampaignStatus): boolean {
  return status === "waiting-provider";
}

function doneIdsOf(campaign: Campaign): Set<string> {
  const done = new Set<string>();
  for (const item of campaign.items) {
    if (item.status === "done") done.add(item.id);
  }
  return done;
}

/** 纯判定：这一项的依赖是否全部 done（缺失引用的依赖视为未满足，保守处理）。 */
export function dependenciesSatisfied(item: CampaignItem, doneIds: ReadonlySet<string>): boolean {
  return item.dependsOn.every((dependency) => doneIds.has(dependency));
}

/**
 * 可执行项：`status==="pending"` 且 `dependsOn` 全部 done，保持 backlog 原顺序。
 * 口径对齐 `lib/agent-teams-task-layout.ts` 的 blocked/available。
 */
export function availableItems(campaign: Campaign): CampaignItem[] {
  const doneIds = doneIdsOf(campaign);
  return campaign.items.filter((item) => item.status === "pending" && dependenciesSatisfied(item, doneIds));
}

/**
 * resume 时要接着做的第一项：按 backlog 顺序，第一个「未完成/未跳过」且依赖已满足的项。
 * 与 `availableItems` 的差异：这里也包含 `running` / `verifying`（进程重启时停在半途的项）
 * 与 `failed`（用户 resume 时通常想重试失败项），由 runner 决定是否把 failed 重置为 pending。
 */
export function nextResumeItem(campaign: Campaign): CampaignItem | null {
  const doneIds = doneIdsOf(campaign);
  for (const item of campaign.items) {
    if (item.status === "done" || item.status === "skipped") continue;
    if (dependenciesSatisfied(item, doneIds)) return item;
  }
  return null;
}

/** 硬闸触顶原因（§1.1）。 */
export type CampaignGateReason = "maxTotalRounds" | "maxTotalCostUsd" | "maxItems";

/**
 * 硬闸纯判定：轮数触顶 / 成本触顶 / 项数越界 → 返回触顶原因，否则 null。
 * 写法对齐 `lib/goal/goal-store.ts` 的 `goalGateExceeded`。
 *
 * `nowMs` 是为将来「时间维度闸」预留的入参（设计 §1 的签名），当前三种闸与时间无关。
 */
export function campaignGateExceeded(
  campaign: Campaign,
  nowMs: number = Date.now(),
): CampaignGateReason | null {
  void nowMs; // 预留：时间维度闸（如 elapsed 上限）目前未启用。
  if (campaign.totalRounds >= campaign.maxTotalRounds) return "maxTotalRounds";
  if (campaign.spentCostUsd >= campaign.maxTotalCostUsd) return "maxTotalCostUsd";
  if (campaign.items.length > campaign.maxItems) return "maxItems";
  return null;
}

/** UI 进度投影（P1 进度条用）：done / failed / skipped / 剩余。 */
export function campaignProgress(campaign: Campaign): {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  remaining: number;
} {
  let done = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of campaign.items) {
    if (item.status === "done") done += 1;
    else if (item.status === "failed") failed += 1;
    else if (item.status === "skipped") skipped += 1;
  }
  return {
    total: campaign.items.length,
    done,
    failed,
    skipped,
    remaining: campaign.items.length - done - skipped,
  };
}

// ───────────────────────────── 入参形状校验（纯） ─────────────────────────────

/**
 * 创建战役的**纯形状校验**（不含 git / 审批档的 IO 检查，那在 `gate.ts`）。
 * 返回稳定的错误码数组；空数组 = 形状通过。错误码是 i18n 键 `campaign.error.<code>`。
 */
export function campaignInputShapeErrors(input: CampaignCreateInput): string[] {
  const errors = new Set<string>();
  const raw = (input ?? {}) as Partial<CampaignCreateInput>;

  const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
  if (!objective) errors.add("objectiveRequired");
  else if (objective.length > CAMPAIGN_OBJECTIVE_MAX_LENGTH) errors.add("objectiveTooLong");

  const cwd = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
  if (!cwd) errors.add("cwdRequired");

  const cost = raw.maxTotalCostUsd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
    errors.add("maxTotalCostUsdRequired");
  }

  const maxItems = raw.maxItems ?? CAMPAIGN_DEFAULT_MAX_ITEMS;
  const maxItemsValid = Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= CAMPAIGN_MAX_ITEMS_LIMIT;
  if (!maxItemsValid) errors.add("maxItemsRange");

  const maxTotalRounds = raw.maxTotalRounds ?? CAMPAIGN_MAX_TOTAL_ROUNDS;
  const maxTotalRoundsValid = Number.isInteger(maxTotalRounds)
    && maxTotalRounds >= 1
    && maxTotalRounds <= CAMPAIGN_MAX_TOTAL_ROUNDS_LIMIT;
  if (!maxTotalRoundsValid) errors.add("maxTotalRoundsRange");

  if (raw.intervalMs !== undefined) {
    const intervalMs = raw.intervalMs;
    if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < 0) {
      errors.add("intervalMsRange");
    }
  }

  const items = Array.isArray(raw.items) ? raw.items : [];
  if (items.length === 0) errors.add("itemsRequired");
  if (maxItemsValid && items.length > maxItems) errors.add("itemsOverMaxItems");

  const idToIndex = new Map<string, number>();
  items.forEach((_, index) => idToIndex.set(`item-${index + 1}`, index));

  const adjacency: number[][] = Array.from({ length: items.length }, () => []);
  const indegree = new Array<number>(items.length).fill(0);

  items.forEach((item, index) => {
    const draft = (item ?? {}) as Partial<CampaignItemDraft>;

    const title = typeof draft.title === "string" ? draft.title.trim() : "";
    if (!title) errors.add("itemTitleRequired");
    else if (title.length > CAMPAIGN_ITEM_TITLE_MAX_LENGTH) errors.add("itemTitleTooLong");

    const instruction = typeof draft.instruction === "string" ? draft.instruction.trim() : "";
    if (!instruction) errors.add("itemInstructionRequired");
    else if (instruction.length > CAMPAIGN_ITEM_INSTRUCTION_MAX_LENGTH) errors.add("itemInstructionTooLong");

    if (draft.acceptance !== undefined) {
      const acceptance = typeof draft.acceptance === "string" ? draft.acceptance : "";
      if (acceptance.length > CAMPAIGN_ACCEPTANCE_MAX_LENGTH) errors.add("itemAcceptanceTooLong");
    }

    const verifyCommand = typeof draft.verifyCommand === "string" ? draft.verifyCommand.trim() : "";
    if (!verifyCommand) errors.add("itemVerifyRequired");
    else if (verifyCommand.length > CAMPAIGN_VERIFY_MAX_LENGTH) errors.add("itemVerifyTooLong");

    if (draft.maxRounds !== undefined) {
      const itemMaxRounds = draft.maxRounds;
      if (!Number.isInteger(itemMaxRounds) || itemMaxRounds < 1 || itemMaxRounds > CAMPAIGN_ITEM_MAX_ROUNDS_LIMIT) {
        errors.add("itemMaxRoundsRange");
      }
    }

    if (draft.dependsOn !== undefined && !Array.isArray(draft.dependsOn)) {
      errors.add("itemDependsOnInvalid");
      return;
    }
    const dependsOn = Array.isArray(draft.dependsOn) ? draft.dependsOn : [];
    const seen = new Set<number>();
    for (const dependency of dependsOn) {
      const dependencyIndex = typeof dependency === "string" ? idToIndex.get(dependency) : undefined;
      if (dependencyIndex === undefined) {
        errors.add("itemDependsOnUnknown");
        continue;
      }
      if (seen.has(dependencyIndex)) continue; // 重复依赖只算一条边，避免 indegree 虚高
      seen.add(dependencyIndex);
      adjacency[dependencyIndex].push(index);
      indegree[index] += 1;
    }
  });

  // Kahn 拓扑：处理不完 = 存在依赖环。
  if (items.length > 0) {
    const queue: number[] = [];
    for (let index = 0; index < indegree.length; index += 1) {
      if (indegree[index] === 0) queue.push(index);
    }
    let visited = 0;
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      visited += 1;
      for (const next of adjacency[node]) {
        indegree[next] -= 1;
        if (indegree[next] === 0) queue.push(next);
      }
    }
    if (visited < items.length) errors.add("itemDependsOnCycle");
  }

  return [...errors];
}

// ───────────────────────────── 错误 ─────────────────────────────

/**
 * 创建/落盘校验错误。`reason` 是稳定错误码（`campaign.error.<reason>`），`message` 是
 * 英文兜底。用 `name` 判定而不是 `instanceof`（Next 的 bundling 会各带一份类）。
 */
export class CampaignValidationError extends Error {
  readonly code = "validation";
  constructor(
    message: string,
    readonly reason: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "CampaignValidationError";
  }
}

export function isCampaignValidationError(error: unknown): error is CampaignValidationError {
  return typeof error === "object" && error !== null
    && (error as { name?: unknown }).name === "CampaignValidationError";
}
