/**
 * Ralph 循环：**每轮一个全新的 worker**，没有对话 seed，没有继承上下文。
 *
 * 这不是「同一个 Agent 多跑几轮」的另一种写法，而是刻意反过来：同一个会话跑很多轮，
 * 上下文会一路膨胀到必须压缩，压缩又会丢掉早期细节——长任务的失败通常就从那里开始。
 * Ralph 的做法是把**长期记忆交给共享工作区（文件）**，每轮只给 worker 三样东西：
 * 目标、工作区、上一轮那份**有界的**结构化报告。于是每一轮都从「干净但知情」开始。
 *
 * 停止条件三条（任一成立即停）：
 * 1. 某一轮的报告声明目标已达成（`status: "complete"`）；
 * 2. 轮次预算用完（`maxRounds`）；
 * 3. 同一个阻塞原因**连续**出现（默认 3 次）——那说明再跑也一样，该交回给人。
 *
 * 为什么不设「墙钟」上限：长任务本来就慢，用时间掐断会把「快完成」的一轮砍掉。
 * 时间约束交给调用方的取消信号（用户按停止），轮次与阻塞才是循环自己的刹车。
 */
import type { StartSubagentRequest, SubagentExecution } from "../subagent-extension";
import type { SubagentRunInfo } from "../subagents";

export const RALPH_DEFAULT_MAX_ROUNDS = 8;
export const RALPH_MAX_ROUNDS = 50;
/** 同一个阻塞原因连续出现这么多次就停：再跑也不会变。 */
export const RALPH_REPEAT_BLOCKER_LIMIT = 3;

export interface RalphLoopOptions {
  objective: string;
  context?: string;
  maxRounds?: number;
  subagentType?: string;
  model?: string;
  isolation?: "worktree";
  parentContext: StartSubagentRequest["parentContext"];
  runtime: { start(request: StartSubagentRequest): Promise<SubagentExecution> };
  signal?: AbortSignal;
  /** 每轮结束回调（UI 进度用）。 */
  onRound?: (round: RalphRound) => void;
}

export type RalphRoundStatus = "complete" | "continue" | "blocked" | "failed";

export interface RalphRound {
  index: number;
  status: RalphRoundStatus;
  /** 这一轮的 worker 会话 id（可 `resume`，也可事后翻查）。 */
  sessionId: string;
  /** 从 worker 报告里解出来的三段（有界的结构化摘要）。 */
  report: RalphReport;
  /** 失败原因（status=failed 时有值）。 */
  error?: string;
}

export interface RalphReport {
  /** 这一轮做了什么（一句话）。 */
  did: string;
  /** 下一轮该做什么（一句话）。 */
  next: string;
  /** 阻塞原因；空表示没被卡住。 */
  blocker: string;
  /**
   * worker 明确报告 `STATUS: blocked`。
   *
   * 为什么要单独一个字段：旧实现只读 `complete`，`blocked` 被整条丢掉。worker 按契约写
   * `STATUS: blocked` 但 `BLOCKER:` 留空（契约里写着可以写 `none`）时，`blocker` 是空串、
   * `complete` 是 false ⇒ 循环当成「继续」，一路空转到 `maxRounds`（实测 5 轮全在空转）。
   * `blocked` 是 worker 的**结论**，不该因为缺一句说明就作废。
   */
  blocked: boolean;
  /** 目标是否已达成。 */
  complete: boolean;
}

export interface RalphResult {
  objective: string;
  rounds: RalphRound[];
  /** 为什么停下。 */
  stopReason: "complete" | "rounds" | "blocked" | "cancelled";
  /** 最后一轮报告里的 `next`（人接手时最有用的一句话）。 */
  next: string;
  elapsedMs: number;
}

/** worker 报告里要求的三行（缺行按「没完成、没卡住」处理，绝不猜成完成）。 */
export const RALPH_REPORT_CONTRACT = [
  "STATUS: complete | continue | blocked",
  "DID: <one line: what this round changed>",
  "NEXT: <one line: what the next round should do>",
  "BLOCKER: <one line, or `none`>",
].join("\n");

export function normalizeRalphRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RALPH_DEFAULT_MAX_ROUNDS;
  const rounded = Math.floor(value);
  if (rounded < 1) return RALPH_DEFAULT_MAX_ROUNDS;
  return Math.min(rounded, RALPH_MAX_ROUNDS);
}

/**
 * 从 worker 的自由文本里读那份契约。
 *
 * 只认**行首标签**（`STATUS:` / `DID:` / `NEXT:` / `BLOCKER:`），大小写不敏感。读不到
 * `STATUS: complete` 就一定按「没完成」处理——把「解析不出来」当成完成，是这条循环最
 * 危险的失败模式（用户以为做完了）。
 */
export function parseRalphReport(text: string): RalphReport {
  const lines = String(text ?? "").split(/\r?\n/);
  const field = (label: string): string => {
    for (const line of lines) {
      const match = /^\s*([A-Z]+)\s*:\s*(.*)$/.exec(line);
      if (!match) continue;
      if (match[1]!.toUpperCase() !== label) continue;
      return match[2]!.trim();
    }
    return "";
  };
  const status = field("STATUS").toLowerCase();
  const blocker = field("BLOCKER");
  return {
    did: field("DID"),
    next: field("NEXT"),
    blocker: /^(none|no|n\/a|-)?$/i.test(blocker) ? "" : blocker,
    // 只有明确写着 complete 才算完成；其它（含空）一律 continue。
    complete: /^complete(d)?$/.test(status),
    // 但 `blocked` 是 worker 的结论，不能因为 BLOCKER 留空就丢掉（见 RalphReport.blocked）。
    blocked: /^blocked$/.test(status),
  };
}

/** 每一轮交给 worker 的 prompt：目标 + 工作区约定 + 上一轮那份有界报告。 */
export function buildRalphPrompt(options: {
  objective: string;
  context?: string;
  round: number;
  maxRounds: number;
  previous?: RalphRound;
}): string {
  const parts = [
    `Objective (immutable, do not restate): ${options.objective}`,
    "",
    `Round ${options.round} of ${options.maxRounds}. You start with **no prior conversation**: everything you need to know is either in the workspace or in the previous round's report below.`,
    "",
    "Working rules:",
    "- The workspace is the memory. Read what previous rounds left behind before you change anything.",
    "- Make the smallest change that moves the objective forward, then verify it.",
    "- Do not restate the objective, do not summarize the workspace.",
  ];
  if (options.context?.trim()) {
    parts.push("", `Standing notes: ${options.context.trim()}`);
  }
  if (options.previous) {
    parts.push(
      "",
      "Previous round report:",
      `- status: ${options.previous.report.complete ? "complete" : "continue"}`,
      `- did: ${options.previous.report.did || "(not reported)"}`,
      `- next: ${options.previous.report.next || "(not reported)"}`,
      `- blocker: ${options.previous.report.blocker || "none"}`,
    );
  }
  parts.push(
    "",
    "Finish your reply with exactly these lines (the loop parses them; anything else is ignored):",
    RALPH_REPORT_CONTRACT,
    "",
    "If the objective is fully met and verified, write `STATUS: complete`. If you cannot proceed, write `STATUS: blocked` and put the reason on BLOCKER.",
  );
  return parts.join("\n");
}

export async function runRalphLoop(options: RalphLoopOptions): Promise<RalphResult> {
  const objective = String(options.objective ?? "").trim();
  if (!objective) throw new Error("ralph needs a non-empty objective");
  const maxRounds = normalizeRalphRounds(options.maxRounds);
  const startedAt = Date.now();
  const rounds: RalphRound[] = [];
  let blockerRepeats = 0;
  let previousBlocker = "";
  let stopReason: RalphResult["stopReason"] = "rounds";

  for (let index = 1; index <= maxRounds; index += 1) {
    if (options.signal?.aborted) {
      stopReason = "cancelled";
      break;
    }
    const previous = rounds[rounds.length - 1];
    const prompt = buildRalphPrompt({
      objective,
      ...(options.context !== undefined ? { context: options.context } : {}),
      round: index,
      maxRounds,
      ...(previous ? { previous } : {}),
    });

    const execution = await options.runtime.start({
      parentContext: options.parentContext,
      parentToolCallId: `ralph-${index}`,
      profile: options.subagentType ?? "general-purpose",
      task: prompt,
      description: `ralph round ${index}/${maxRounds}`,
      runInBackground: false,
      // **不继承上下文**：这正是这条循环与「同一个会话多跑几轮」的区别。
      inheritContext: false,
      ...(options.model ? { model: options.model } : {}),
      ...(options.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const run: SubagentRunInfo = await execution.completion;

    if (run.status !== "completed") {
      const round: RalphRound = {
        index,
        status: "failed",
        sessionId: run.sessionId,
        report: { did: "", next: "", blocker: "", blocked: false, complete: false },
        error: run.error ?? run.status,
      };
      rounds.push(round);
      options.onRound?.(round);
      stopReason = "blocked";
      break;
    }

    const report = parseRalphReport(run.result ?? "");
    const round: RalphRound = {
      index,
      status: report.complete ? "complete" : (report.blocked || report.blocker) ? "blocked" : "continue",
      sessionId: run.sessionId,
      report,
    };
    rounds.push(round);
    options.onRound?.(round);

    if (report.complete) {
      stopReason = "complete";
      break;
    }
    // worker 写了 `STATUS: blocked` 就是它的结论，直接早停——不管 BLOCKER 有没有给理由
    // （契约允许 `BLOCKER: none`）。旧实现要求 `blocked && !blocker` 才早停，于是 worker
    // 同时写 `STATUS: blocked` 和 `BLOCKER: <reason>` 时落进下面的「连续同 blocker 重复
    // 计数」分支，还要再跑 2 轮同 blocker 才停，与「blocked 是 worker 的结论」这一定位
    // 矛盾。改后：声明 blocked 即停；只有「说 continue 但留了 blocker」才走重复计数。
    if (report.blocked) {
      stopReason = "blocked";
      break;
    }
    if (report.blocker) {
      // 同一个阻塞连续出现 = 再跑也一样；换了阻塞说明还在推进，继续。
      // 比较前归一化：大小写或多余空白变一下就算「换了阻塞」，会让早停永远不触发。
      const normalized = report.blocker.trim().toLowerCase().replace(/\s+/g, " ");
      blockerRepeats = normalized === previousBlocker ? blockerRepeats + 1 : 1;
      previousBlocker = normalized;
      if (blockerRepeats >= RALPH_REPEAT_BLOCKER_LIMIT) {
        stopReason = "blocked";
        break;
      }
    } else {
      blockerRepeats = 0;
      previousBlocker = "";
    }
  }

  const last = rounds[rounds.length - 1];
  return {
    objective,
    rounds,
    stopReason,
    next: last?.report.next ?? "",
    elapsedMs: Date.now() - startedAt,
  };
}

/** 报告文本：首行是结论，然后是逐轮一行，最后是「下一步」。 */
export function formatRalphReport(result: RalphResult): string {
  const head =
    result.stopReason === "complete" ? `Ralph loop completed the objective in ${result.rounds.length} round(s).`
    : result.stopReason === "blocked" ? `Ralph loop stopped after ${result.rounds.length} round(s): blocked.`
    : result.stopReason === "cancelled" ? `Ralph loop was cancelled after ${result.rounds.length} round(s).`
    : `Ralph loop used its ${result.rounds.length}-round budget without completing.`;
  const lines = [head, `objective: ${result.objective}`];
  for (const round of result.rounds) {
    const did = round.report.did || round.error || "(no report)";
    lines.push(`- round ${round.index} [${round.status}] ${did} (session ${round.sessionId})`);
    if (round.report.blocker) lines.push(`  blocker: ${round.report.blocker}`);
  }
  if (result.next) lines.push("", `next: ${result.next}`);
  return lines.join("\n");
}