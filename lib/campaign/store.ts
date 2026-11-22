/**
 * 「长时自主项目战役」落盘（server-only）。
 *
 * 位置：`<agent dir>/campaigns/<uuid>.json`（默认 `~/.pi/agent/campaigns/`，
 * 与 autofix / goal / scheduled-tasks 同根；遵守 PI_CODING_AGENT_DIR，测试可注入 agentDir）。
 * 每个战役一份 JSON，`writePrivateFileAtomicSync` 原子写：崩溃/满盘只会留下旧文件或
 * 新文件，绝不会是截断的一半。
 *
 * 所有读写都是同步的：进程内的读-改-写在中间没有 await，不会自我交错；跨进程并发
 * 由 runner 的「认领后复核 pid」处理（照 `lib/autofix/store.ts` 的写法）。
 *
 * 本文件只做结构校验与落盘；git / 审批档 / 成本这些「能不能开跑」的判断在 `gate.ts`。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import {
  CAMPAIGN_DEFAULT_ITEM_MAX_ROUNDS,
  CAMPAIGN_DEFAULT_MAX_ITEMS,
  CAMPAIGN_ERROR_MAX_CHARS,
  CAMPAIGN_ITEM_STATUSES,
  CAMPAIGN_MAX_CAMPAIGNS,
  CAMPAIGN_MAX_ROUND_RECORDS,
  CAMPAIGN_MAX_TOTAL_ROUNDS,
  CAMPAIGN_STATUSES,
  CampaignValidationError,
  campaignInputShapeErrors,
  isActiveCampaignStatus,
  type Campaign,
  type CampaignCreateInput,
  type CampaignItem,
  type CampaignRound,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function campaignDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "campaigns");
}

export function campaignPath(id: string, agentDir: string = getAgentDir()): string {
  if (!UUID_PATTERN.test(id)) throw new Error("Invalid campaign id");
  return join(campaignDir(agentDir), `${id}.json`);
}

// ───────────────────────────── 守卫 ─────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isRound(value: unknown): value is CampaignRound {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.round)
    && isFiniteNumber(value.at)
    && typeof value.status === "string"
    && (value.verifyExitCode === null || isFiniteNumber(value.verifyExitCode))
    && (value.error === undefined || typeof value.error === "string")
    && (value.outputTail === undefined || typeof value.outputTail === "string");
}

/** 磁盘 JSON → CampaignItem 守卫；缺字段/越界一律拒绝（当作不存在）。 */
export function isCampaignItem(value: unknown): value is CampaignItem {
  if (!isRecord(value)) return false;
  const checkpoint = value.checkpoint;
  const checkpointOk = checkpoint === undefined || (
    isRecord(checkpoint)
    && (checkpoint.sha === undefined || typeof checkpoint.sha === "string")
    && (checkpoint.patchPath === undefined || typeof checkpoint.patchPath === "string")
    && isFiniteNumber(checkpoint.at)
  );
  return typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.instruction === "string"
    && typeof value.acceptance === "string"
    && typeof value.verifyCommand === "string"
    && Array.isArray(value.dependsOn)
    && value.dependsOn.every((dependency) => typeof dependency === "string")
    && typeof value.status === "string"
    && (CAMPAIGN_ITEM_STATUSES as readonly string[]).includes(value.status)
    && isFiniteNumber(value.round)
    && isFiniteNumber(value.maxRounds)
    && isFiniteNumber(value.costUsd)
    && checkpointOk
    && (value.lastError === null || typeof value.lastError === "string")
    && Array.isArray(value.rounds)
    && value.rounds.every(isRound);
}

/** 磁盘 JSON → Campaign 守卫；缺字段/越界一律拒绝（当作不存在）。 */
export function isCampaign(value: unknown): value is Campaign {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.id === "string"
    && UUID_PATTERN.test(value.id)
    && typeof value.objective === "string"
    && typeof value.cwd === "string"
    && typeof value.status === "string"
    && (CAMPAIGN_STATUSES as readonly string[]).includes(value.status)
    && Array.isArray(value.items)
    && value.items.every(isCampaignItem)
    && (value.currentItemId === null || typeof value.currentItemId === "string")
    && isFiniteNumber(value.maxTotalRounds)
    && isFiniteNumber(value.maxItems)
    && isFiniteNumber(value.maxTotalCostUsd)
    && isFiniteNumber(value.spentCostUsd)
    && isFiniteNumber(value.totalRounds)
    && isFiniteNumber(value.intervalMs)
    && (value.nextRunAt === undefined || isFiniteNumber(value.nextRunAt))
    && (value.sessionId === null || typeof value.sessionId === "string")
    && (value.pid === null || isFiniteNumber(value.pid))
    && isFiniteNumber(value.startedAt)
    && isFiniteNumber(value.createdAt)
    && isFiniteNumber(value.updatedAt)
    && (value.finishedAt === null || isFiniteNumber(value.finishedAt))
    && (value.lastError === null || typeof value.lastError === "string")
    && (value.truthFile === undefined || typeof value.truthFile === "string");
}

// ───────────────────────────── 读 ─────────────────────────────

/** 读一个战役；缺文件 / 坏 JSON / 守卫不过一律 undefined。 */
export function getCampaign(id: string, agentDir: string = getAgentDir()): Campaign | undefined {
  if (!UUID_PATTERN.test(id)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(campaignPath(id, agentDir), "utf8"));
    return isCampaign(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 全部战役，最新的在前（列表页 / sweep 共用）。坏文件跳过但不删除。 */
export function listCampaigns(agentDir: string = getAgentDir()): Campaign[] {
  let files: string[];
  try {
    files = readdirSync(campaignDir(agentDir));
  } catch {
    return [];
  }
  const campaigns: Campaign[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    if (!UUID_PATTERN.test(id)) continue;
    const campaign = getCampaign(id, agentDir);
    if (campaign) campaigns.push(campaign);
  }
  return campaigns.sort((a, b) => b.createdAt - a.createdAt);
}

// ───────────────────────────── 写 ─────────────────────────────

function capRounds(rounds: CampaignRound[]): CampaignRound[] {
  return rounds.length <= CAMPAIGN_MAX_ROUND_RECORDS
    ? rounds
    : rounds.slice(rounds.length - CAMPAIGN_MAX_ROUND_RECORDS);
}

function capError(error: string | null): string | null {
  if (typeof error !== "string") return null;
  return error.length <= CAMPAIGN_ERROR_MAX_CHARS ? error : `…${error.slice(error.length - CAMPAIGN_ERROR_MAX_CHARS)}`;
}

function prepareForWrite(campaign: Campaign): Campaign {
  return {
    ...campaign,
    version: 1,
    items: campaign.items.map((item) => ({
      ...item,
      rounds: capRounds(item.rounds),
      lastError: capError(item.lastError),
    })),
    lastError: capError(campaign.lastError),
    updatedAt: Number.isFinite(campaign.updatedAt) ? campaign.updatedAt : Date.now(),
  };
}

/**
 * 低层落盘：校验收紧后的对象，原子写入并返回。runner 与 updateCampaign 共用。
 * 校验不过抛 `CampaignValidationError('invalidCampaign')`——这是程序错误，不是用户输入错误。
 */
export function writeCampaign(campaign: Campaign, agentDir: string = getAgentDir()): Campaign {
  const prepared = prepareForWrite(campaign);
  if (!isCampaign(prepared)) {
    throw new CampaignValidationError("Campaign shape is invalid", "invalidCampaign");
  }
  mkdirSync(campaignDir(agentDir), { recursive: true });
  writePrivateFileAtomicSync(
    campaignPath(prepared.id, agentDir),
    `${JSON.stringify(prepared, null, 2)}\n`,
  );
  return prepared;
}

/**
 * 同步读-改-写。`change` 返回新战役；轮次记录与错误长度在这里统一裁剪，
 * `id/version` 不可变，`updatedAt` 刷新。战役不存在返回 undefined（调用方自己决定是不是竞态）。
 */
export function updateCampaign(
  id: string,
  change: (campaign: Campaign) => Campaign,
  agentDir: string = getAgentDir(),
): Campaign | undefined {
  if (!UUID_PATTERN.test(id)) return undefined;
  const current = getCampaign(id, agentDir);
  if (!current) return undefined;
  const next = change(current);
  return writeCampaign({
    ...next,
    id: current.id,
    version: 1,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
  }, agentDir);
}

/**
 * 建一个排队战役（结构校验通过才落盘；git / 审批档由 `campaignCreateErrors` 在路由层做）。
 * 战役数达到上限时拒绝，防止 campaigns 目录无限膨胀。
 */
export function createCampaign(input: CampaignCreateInput, agentDir: string = getAgentDir()): Campaign {
  const errors = campaignInputShapeErrors(input);
  if (errors.length > 0) {
    throw new CampaignValidationError(`Invalid campaign input: ${errors.join(", ")}`, errors[0]);
  }
  if (listCampaigns(agentDir).length >= CAMPAIGN_MAX_CAMPAIGNS) {
    throw new CampaignValidationError(
      `At most ${CAMPAIGN_MAX_CAMPAIGNS} campaigns may exist; delete older ones first`,
      "tooManyCampaigns",
      { max: CAMPAIGN_MAX_CAMPAIGNS },
    );
  }

  const now = Date.now();
  const items: CampaignItem[] = input.items.map((draft, index) => ({
    id: `item-${index + 1}`,
    title: draft.title.trim(),
    instruction: draft.instruction.trim(),
    acceptance: (draft.acceptance ?? "").trim(),
    verifyCommand: draft.verifyCommand.trim(),
    dependsOn: [...(draft.dependsOn ?? [])],
    status: "pending",
    round: 0,
    maxRounds: draft.maxRounds ?? CAMPAIGN_DEFAULT_ITEM_MAX_ROUNDS,
    costUsd: 0,
    lastError: null,
    rounds: [],
  }));

  const truthFile = typeof input.truthFile === "string" ? input.truthFile.trim() : "";

  const created: Campaign = {
    version: 1,
    id: randomUUID(),
    objective: input.objective.trim(),
    cwd: input.cwd.trim(),
    status: "queued",
    items,
    currentItemId: null,
    maxTotalRounds: input.maxTotalRounds ?? CAMPAIGN_MAX_TOTAL_ROUNDS,
    maxItems: input.maxItems ?? CAMPAIGN_DEFAULT_MAX_ITEMS,
    maxTotalCostUsd: input.maxTotalCostUsd,
    spentCostUsd: 0,
    totalRounds: 0,
    intervalMs: input.intervalMs ?? 0,
    sessionId: null,
    pid: null,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    lastError: null,
    ...(truthFile ? { truthFile } : {}),
  };

  return writeCampaign(created, agentDir);
}

export function deleteCampaign(id: string, agentDir: string = getAgentDir()): boolean {
  if (!UUID_PATTERN.test(id)) return false;
  const path = campaignPath(id, agentDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** 供 runner / 列表使用：战役是否正在（或应当）被驱动。 */
export function isActiveCampaign(campaign: Campaign): boolean {
  return isActiveCampaignStatus(campaign.status);
}
