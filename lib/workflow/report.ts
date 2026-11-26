import type { WorkflowResult } from "./types";

/** workflow 结果 → 模型看到的文本。
 *
 * 首行是结论（跑了几个节点 / 是否被停），然后是脚本的返回值，再是逐节点的结果。
 * 顺序刻意如此：模型先看结论，需要细节时才往下读，避免把几十个节点的全文塞进上下文。
 */
/** 单条文本的上限：够看出「做了什么」，又不至于把上下文撑爆。 */
const ENTRY_LIMIT = 400;
/** 脚本返回值的上限：它能是任意长串（模型爱 return 整段代码或日志）。 */
const VALUE_LIMIT = 1_200;
/** 日志条数上限（尾部；最近的最有用）。 */
const LOG_TAIL = 10;
/** 单条日志上限：一条日志也可能是一整段输出。 */
const LOG_ENTRY_LIMIT = 200;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function formatWorkflowReport(result: WorkflowResult): string {
  const head = result.aborted
    ? `Workflow stopped after ${result.agents} agent(s) (cancelled or over budget).`
    : `Workflow finished with ${result.agents} agent(s) in ${Math.round(result.elapsedMs / 1000)}s.`;
  const lines = [head];
  if (result.phases.length > 0) lines.push(`phases: ${result.phases.join(" → ")}`);
  if (result.value !== undefined && result.value !== null) {
    // 截断：这份文本会被塞进下一轮 worker 的 prompt（ralph）或工具结果里，脚本返回一整段
    // 代码/日志时不该原样带上。
    lines.push("", "script result:", clip(formatValue(result.value), VALUE_LIMIT));
  }
  const failed = result.results.filter((entry) => entry.text === null);
  if (failed.length > 0) {
    lines.push("", `failed nodes (${failed.length}):`);
    for (const entry of failed) lines.push(`- ${entry.description}: ${clip(entry.error ?? "unknown error", ENTRY_LIMIT)}`);
  }
  if (result.results.length > 0) {
    lines.push("", "node results:");
    for (const entry of result.results) {
      const text = entry.text ?? "";
      lines.push(`- ${entry.description}: ${clip(text, ENTRY_LIMIT) || "(empty)"}`);
    }
  }
  if (result.logs.length > 0) {
    // 日志同样要截：单条日志可能是一整段输出，`join` 前不截会把报告撑到几千字
    // （审计实测：单节点 5000 字结果 → 报告 5481 字，节点结果截了、日志没截）。
    const tail = result.logs.slice(-LOG_TAIL).map((entry) => clip(entry, LOG_ENTRY_LIMIT));
    lines.push("", `logs: ${tail.join(" | ")}`);
  }
  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}