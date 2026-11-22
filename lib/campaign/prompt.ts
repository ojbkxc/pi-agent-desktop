/**
 * Campaign 每项 prompt 组装（纯函数，无 SDK / 无文件系统）。
 *
 * 设计 `docs/agents/fork-long-run-campaign.md` §2。语言中立英文：会话模型不保证
 * 中文能力；objective / item 原句原样嵌入。
 *
 * 口径与 autofix（`lib/autofix/prompt.ts`）一致，只是把「单任务」换成「有序 backlog
 * 里的一项」：
 * - 引擎在每一轮 agent 回合结束后**自己**跑该项的 `verifyCommand`，exit 0 才算这一项
 *   完成——模型自述「做完了」不算数；
 * - 提示明确「不要问用户、不要提交/推送、不要改版本号」，这是无人值守循环；
 * - 第 2 轮起把上一轮验证失败的输出尾部喂回去，避免重复摸索；
 * - 跨项续跑 / Provider 中断恢复时的接续注记由 runner 前置拼接（与 autofix 同）。
 */
import {
  AUTOFIX_ERROR_MAX_CHARS,
  AUTOFIX_OUTPUT_TAIL_MAX_CHARS,
  tailOf,
} from "../autofix/types";

export interface CampaignPromptItem {
  title: string;
  instruction: string;
  acceptance: string;
  verifyCommand: string;
}

export interface CampaignPromptInput {
  /** 项目总目标（战役级，原句嵌入）。 */
  objective: string;
  /** 战役工作目录。 */
  cwd: string;
  /** 当前这一项。 */
  item: CampaignPromptItem;
  /** 本项在 backlog 里的序号（1 起）/ 总数（展示「item k of n」）。 */
  itemIndex: number;
  itemCount: number;
  /** 本项当前轮（1 起）。 */
  round: number;
  /** 本项轮数上限。 */
  maxRounds: number;
  /** 上一轮失败摘要（第 2 轮起非空）。 */
  lastError?: string | null;
  /** 上一轮验证输出尾部（第 2 轮起非空）。 */
  lastOutputTail?: string | null;
}

const RULES = [
  "- The harness runs this item's verification command itself after every one of your turns; only exit code 0 marks the item complete.",
  "- Inspect the code and make the smallest correct change. Run the verification command (or the failing part of it) yourself to see what breaks.",
  "- Do not ask the user anything: no questions, no confirmations. Nobody will answer during this run.",
  "- Do not commit, push, rebase, amend, or change version numbers. Leave the working tree with your change in place.",
  "- If the failure is environmental (missing dependency, credentials, network), stop editing and explain exactly what is missing in your final message.",
];

function itemLine(input: CampaignPromptInput): string {
  return `Backlog item ${input.itemIndex} of ${input.itemCount}: ${input.item.title}`;
}

function roundLine(round: number, maxRounds: number): string {
  return `Round ${round} of ${maxRounds}.`;
}

/** 第一轮（本项的第 1 轮）的完整指令。 */
export function buildCampaignInitialPrompt(input: CampaignPromptInput): string {
  const { item } = input;
  return [
    "You are an autonomous engineering agent working through an ordered project backlog. You run unattended in a loop until this item's verification command passes.",
    "",
    `Overall project objective (verbatim): ${input.objective}`,
    itemLine(input),
    `What to do for this item (verbatim): ${item.instruction}`,
    item.acceptance ? `Acceptance criteria (human-readable): ${item.acceptance}` : "",
    `Working directory: ${input.cwd}`,
    `Verification command (exit 0 = this item is done): ${item.verifyCommand}`,
    roundLine(input.round, input.maxRounds),
    "",
    "Rules:",
    ...RULES,
    "",
    "Start by understanding the current state, then make the change this item asks for.",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** 本项第二轮起：上一轮验证失败的输出 + 继续。 */
export function buildCampaignContinuePrompt(input: CampaignPromptInput): string {
  const tail = input.lastOutputTail ? tailOf(input.lastOutputTail, AUTOFIX_OUTPUT_TAIL_MAX_CHARS) : "";
  const error = input.lastError ? tailOf(input.lastError, AUTOFIX_ERROR_MAX_CHARS) : "";
  return [
    `The verification command still fails for this item. ${roundLine(input.round, input.maxRounds)}`,
    itemLine(input),
    `Verification command: ${input.item.verifyCommand}`,
    error ? `\nLast failure summary:\n${error}` : "",
    tail ? `\nOutput tail from the last verification run:\n\`\`\`\n${tail}\n\`\`\`` : "",
    "",
    "Continue fixing the remaining failures for THIS item only. Same rules: smallest correct change, run the check yourself, no questions, no commits.",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** 按轮次选择 prompt。 */
export function buildCampaignPrompt(input: CampaignPromptInput): string {
  return input.round <= 1 ? buildCampaignInitialPrompt(input) : buildCampaignContinuePrompt(input);
}

/** 会话名：侧边栏/会话列表里能一眼认出这是战役会话。 */
export function campaignSessionName(objective: string): string {
  const firstLine = objective.trim().split(/\r?\n/, 1)[0] ?? "";
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  return `Campaign · ${short || "project"}`;
}
