/**
 * 「长时自主项目战役」的**创建校验与运行时硬顶**（server-only）。
 *
 * 两道必须收紧的闸（设计 §5、§6，对照 autofix 现状的差距 #8）：
 * - **成本闸前置**：没有 `maxTotalCostUsd > 0` 的战役一律拒绝——无人值守跨天必须有人给钱袋子。
 * - **安全闸**：强制 git 仓（否则无从 checkpoint/回滚）；命令审批档至少 `dangerous`
 *   （`off` 拒绝），战役会话**不**跳过审批。
 *
 * 形状校验（objective / items / 数值范围 / 依赖拓扑）在 `types.ts` 的
 * `campaignInputShapeErrors`，本文件负责叠加 IO 维度的 git 与审批档检查。
 * 测试可注入 `isGitRepo` / `readApproval`，不必真的跑 git 或读写用户设置。
 */

import { execFileSync } from "node:child_process";
import { readApprovalMode } from "../tool-approval/settings";
import type { ApprovalMode } from "../tool-approval/policy";
import {
  campaignGateExceeded,
  campaignInputShapeErrors,
  type Campaign,
  type CampaignCreateInput,
  type CampaignGateReason,
  type CampaignItem,
} from "./types";

export { campaignGateExceeded, campaignInputShapeErrors };
export type { CampaignGateReason };

/** 战役要求的最低命令审批档：`dangerous`（`all` 更高，`off` 拒绝）。 */
export const CAMPAIGN_MIN_APPROVAL_MODE: ApprovalMode = "dangerous";

/** 审批档强弱（可扩展：新增档位时 TS 会强制在这里补一行）。 */
const APPROVAL_RANK: Record<ApprovalMode, number> = {
  off: 0,
  dangerous: 1,
  all: 2,
};

/** 纯判定：`mode` 是否至少达到 `min` 的强度。 */
export function approvalModeAtLeast(mode: ApprovalMode, min: ApprovalMode): boolean {
  return APPROVAL_RANK[mode] >= APPROVAL_RANK[min];
}

/**
 * cwd 是否是 git 工作树。`git rev-parse --is-inside-work-tree` 成功且输出 `true` 才为真。
 * 同步执行：创建路由本来就要立即给出结论；失败（无 git / 非仓 / 目录不存在）一律 false。
 */
export function isGitRepo(cwd: string): boolean {
  const dir = typeof cwd === "string" ? cwd.trim() : "";
  if (!dir) return false;
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export interface CampaignCreateCheckOptions {
  /** 注入 git 探测（测试用）；缺省 `isGitRepo`。 */
  isGitRepo?: (cwd: string) => boolean;
  /** 注入审批档读取（测试用）；缺省 `readApprovalMode`。 */
  readApproval?: () => ApprovalMode;
}

/**
 * 创建校验：返回稳定的错误码数组（空数组 = 通过）。错误码是 i18n 键
 * `campaign.error.<code>`，路由层据此返回 400 与逐条说明。
 *
 * 覆盖设计要求的四类拒绝：无成本闸（`maxTotalCostUsdRequired`）、非 git
 * （`cwdNotGit`）、数值越界（`*Range` / `itemsOverMaxItems`）、审批档 `off`
 * （`approvalModeTooLow`），外加 objective / item 的形状错误。
 */
export function campaignCreateErrors(
  input: CampaignCreateInput,
  options: CampaignCreateCheckOptions = {},
): string[] {
  const errors = campaignInputShapeErrors(input);
  const checkGit = options.isGitRepo ?? isGitRepo;
  const readApproval = options.readApproval ?? readApprovalMode;

  const cwd = typeof input?.cwd === "string" ? input.cwd.trim() : "";
  // cwd 缺失已经由形状校验报错，不再重复跑 git。
  if (cwd && !checkGit(cwd)) errors.push("cwdNotGit");

  let mode: ApprovalMode;
  try {
    mode = readApproval();
  } catch {
    // 读不动设置按最保守处理（等同 off），与 tool-approval 的 fail-open 口径不同：
    // 这里是「无人值守开跑」，宁可拒绝。
    mode = "off";
  }
  if (!approvalModeAtLeast(mode, CAMPAIGN_MIN_APPROVAL_MODE)) errors.push("approvalModeTooLow");

  return [...new Set(errors)];
}

// ───────────────────────────── 运行时硬顶（纯） ─────────────────────────────

/** 单项是否已耗尽轮次。 */
export function itemRoundExceeded(item: CampaignItem): boolean {
  return item.round >= item.maxRounds;
}

/** 运行时终止原因：三种战役级闸 + 单项轮次耗尽。 */
export type CampaignRuntimeStop = CampaignGateReason | "itemMaxRounds";

/**
 * 纯判定：驱动循环每轮开始前该不该停。战役级闸优先（成本/轮数/项数），
 * 其次看是否有未完成的项撞了本项轮次上限。
 */
export function campaignRuntimeStop(campaign: Campaign, nowMs: number = Date.now()): CampaignRuntimeStop | null {
  const gate = campaignGateExceeded(campaign, nowMs);
  if (gate) return gate;
  const stuck = campaign.items.find(
    (item) => item.status !== "done" && item.status !== "skipped" && itemRoundExceeded(item),
  );
  return stuck ? "itemMaxRounds" : null;
}
