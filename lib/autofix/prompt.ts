/**
 * 「自动修 Bug」的 prompt 组装（纯函数，无 SDK / 无文件系统）。
 *
 * 语言中立英文：会话模型不保证中文能力；任务说明原句原样嵌入。
 * 设计口径：
 * - 引擎在每一轮 agent 回合结束后**自己**跑验证命令，exit 0 才收工——模型自述
 *   「修好了」不算数（判据回路，见 docs/agents/fork-autofix.md）；
 * - 提示里明确「不要问用户、不要提交/推送、不要改版本号」，因为这是无人值守循环；
 * - 第 2 轮起把上一轮验证失败的输出尾部喂回去，避免重复摸索。
 */
import { AUTOFIX_ERROR_MAX_CHARS, AUTOFIX_OUTPUT_TAIL_MAX_CHARS, tailOf } from "./types";

export interface AutofixPromptInput {
  task: string;
  cwd: string;
  verifyCommand: string;
  /** 当前轮（1 起）。 */
  round: number;
  maxRounds: number;
  /** 上一轮失败摘要（第 2 轮起非空）。 */
  lastError?: string | null;
  /** 上一轮验证输出尾部（第 2 轮起非空）。 */
  lastOutputTail?: string | null;
}

const RULES = [
  "- The harness runs the verification command itself after every one of your turns; only exit code 0 ends the job.",
  "- Inspect the code and make the smallest correct change. Run the verification command (or the failing part of it) yourself to see what breaks.",
  "- Do not ask the user anything: no questions, no confirmations. Nobody will answer during this run.",
  "- Do not commit, push, rebase, amend, or change version numbers. Leave the working tree with your fix in place.",
  "- If the failure is environmental (missing dependency, credentials, network), stop editing and explain exactly what is missing in your final message.",
];

function roundLine(round: number, maxRounds: number): string {
  return `Round ${round} of ${maxRounds}.`;
}

/** 第一轮的完整指令。 */
export function buildAutofixInitialPrompt(input: AutofixPromptInput): string {
  return [
    "You are an autonomous bug-fixing agent. You run unattended in a loop until the verification command passes.",
    "",
    `Task statement from the user (verbatim): ${input.task}`,
    `Working directory: ${input.cwd}`,
    `Verification command: ${input.verifyCommand}`,
    roundLine(input.round, input.maxRounds),
    "",
    "Rules:",
    ...RULES,
    "",
    "Start by reproducing or locating the failure, then fix it.",
  ].join("\n");
}

/** 第二轮起：上一轮验证失败的输出 + 继续修。 */
export function buildAutofixContinuePrompt(input: AutofixPromptInput): string {
  const tail = input.lastOutputTail ? tailOf(input.lastOutputTail, AUTOFIX_OUTPUT_TAIL_MAX_CHARS) : "";
  const error = input.lastError ? tailOf(input.lastError, AUTOFIX_ERROR_MAX_CHARS) : "";
  return [
    `Verification still fails. ${roundLine(input.round, input.maxRounds)}`,
    `Verification command: ${input.verifyCommand}`,
    error ? `\nLast failure summary:\n${error}` : "",
    tail ? `\nOutput tail from the last verification run:\n\`\`\`\n${tail}\n\`\`\`` : "",
    "",
    "Continue fixing the remaining failures. Same rules: smallest correct change, run the check yourself, no questions, no commits.",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** 按轮次选择 prompt。 */
export function buildAutofixPrompt(input: AutofixPromptInput): string {
  return input.round <= 1 ? buildAutofixInitialPrompt(input) : buildAutofixContinuePrompt(input);
}

/** 会话名：侧边栏/会话列表里能一眼认出这是自动修 Bug 的会话。 */
export function autofixSessionName(task: string): string {
  const firstLine = task.trim().split(/\r?\n/, 1)[0] ?? "";
  const short = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  return `Autofix · ${short || "bug fix"}`;
}
