import type { WorkflowResult } from "./types";

/** workflow 结果 → 模型看到的文本。
 *
 * 首行是结论（跑了几个节点 / 是否被停），然后是脚本的返回值，再是逐节点的结果。
 * 顺序刻意如此：模型先看结论，需要细节时才往下读，避免把几十个节点的全文塞进上下文。
 */
export function formatWorkflowReport(result: WorkflowResult): string {
  const head = result.aborted
    ? `Workflow stopped after ${result.agents} agent(s) (cancelled or over budget).`
    : `Workflow finished with ${result.agents} agent(s) in ${Math.round(result.elapsedMs / 1000)}s.`;
  const lines = [head];
  if (result.phases.length > 0) lines.push(`phases: ${result.phases.join(" → ")}`);
  if (result.value !== undefined && result.value !== null) {
    lines.push("", "script result:", formatValue(result.value));
  }
  const failed = result.results.filter((entry) => entry.text === null);
  if (failed.length > 0) {
    lines.push("", `failed nodes (${failed.length}):`);
    for (const entry of failed) lines.push(`- ${entry.description}: ${entry.error ?? "unknown error"}`);
  }
  if (result.results.length > 0) {
    lines.push("", "node results:");
    for (const entry of result.results) {
      const text = entry.text ?? "";
      const short = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      lines.push(`- ${entry.description}: ${short || "(empty)"}`);
    }
  }
  if (result.logs.length > 0) lines.push("", `logs: ${result.logs.slice(-10).join(" | ")}`);
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