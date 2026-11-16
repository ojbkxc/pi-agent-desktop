/**
 * 后台命令扩展：给模型三个工具 —— `bash_background` / `get_background_job` /
 * `stop_background_job`。
 *
 * 设计取舍（对齐 DeepSeek Super-agent 的异步工具调用）：
 * - `bash_background` **立即返回**，不阻塞 ReAct 循环；命令跑完后结果作为一条
 *   `pi-web:background-job` 自定义消息注入本会话并触发新 turn。
 * - 因此模型必须理解：这个工具的返回值**不是**命令输出。工具描述与返回文案都反复写明
 *   这一点，并给出 job id 与日志路径，好让它自己在需要时用 `get_background_job` 查。
 * - 只注册这三个工具，不改任何既有工具的行为——前台 bash 仍同步等待，语义不变。
 *
 * 只给普通会话（与 memory / tool-approval 同口径）：成员会话与后台无人值守会话没有
 * 用户可交互的 UI，后台 job 的通知投递目标也不一定存在。
 */
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { getBackgroundJob, startJobFromTool, stopJobFromTool } from "./service";
import { BACKGROUND_JOB_MAX_TIMEOUT_SEC, type BackgroundJob } from "./types";

/** InlineExtension 是「纯工厂 | 带名字的对象」的联合；本扩展恒为后者，导出精确类型。 */
export type BackgroundJobsInlineExtension = Extract<InlineExtension, { factory: unknown }>;

export const BACKGROUND_JOBS_EXTENSION_NAME = "pi-background-jobs";

/** 工具返回里统一出现的提醒：模型最容易犯的错是把这个结果当成命令输出。 */
const NOT_OUTPUT_REMINDER =
  "This is NOT the command's output. The command is still running in the background. Its output will arrive later as a separate message in this conversation.";

function jobSummary(job: BackgroundJob): string {
  const parts = [`Job ${job.id}: ${job.status}`];
  if (job.exitCode !== undefined) parts.push(`exit code ${job.exitCode === null ? "none" : job.exitCode}`);
  if (job.signal) parts.push(`signal ${job.signal}`);
  if (job.error) parts.push(job.error);
  parts.push(`command: ${job.command}`);
  parts.push(`log: ${job.outputPath}`);
  return parts.join("\n");
}

export function createBackgroundJobsExtension(): BackgroundJobsInlineExtension {
  return {
    name: BACKGROUND_JOBS_EXTENSION_NAME,
    hidden: true,
    builtin: true,
    replaceable: true,
    factory: (pi: ExtensionAPI) => {
      pi.registerTool(defineTool({
        name: "bash_background",
        label: "Background command",
        description: `Run a shell command in the background and return immediately, so this turn can continue without waiting. Use it for long builds, test suites, dev servers, downloads and anything else that would otherwise block the conversation for minutes.\n\n${NOT_OUTPUT_REMINDER} When it finishes, the output arrives as a separate message carrying the job id and log path.`,
        promptSnippet: "Start a long shell command in the background without blocking the turn",
        promptGuidelines: [
          "Prefer bash_background over bash for anything that may take more than a minute.",
          "Do not re-run the same command while its job is still running; use get_background_job instead.",
        ],
        executionMode: "parallel",
        parameters: Type.Object({
          command: Type.String({ description: "The shell command to run." }),
          label: Type.Optional(Type.String({ description: "Short activity label shown in the UI." })),
          timeout_seconds: Type.Optional(Type.Number({
            description: `Kill the command after this many seconds (default 7200, max ${BACKGROUND_JOB_MAX_TIMEOUT_SEC}).`,
          })),
        }),
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
          try {
            const { job } = startJobFromTool({
              sessionId: ctx.sessionManager.getSessionId(),
              toolCallId,
              command: params.command,
              label: params.label ?? "",
              // 必须用会话的 cwd：进程 cwd 是服务目录，用户说「在当前项目跑」时会跑错地方。
              cwd: ctx.cwd,
              ...(params.timeout_seconds !== undefined ? { timeoutSec: params.timeout_seconds } : {}),
            });
            return {
              content: [{ type: "text", text: `${jobSummary(job)}\n\n${NOT_OUTPUT_REMINDER}` }],
              details: { kind: "pi-web-background-job", jobId: job.id, status: job.status, command: job.command, outputPath: job.outputPath },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "get_background_job",
        label: "Get background job",
        description: "Check one background command: its current status, exit code and the last part of its output. Use it instead of starting the same command twice.",
        parameters: Type.Object({
          job_id: Type.String({ description: "The job id returned by bash_background." }),
        }),
        async execute(_toolCallId, params) {
          try {
            const job = getBackgroundJob(params.job_id);
            if (!job) {
              return { content: [{ type: "text", text: `Background job not found: ${params.job_id}` }], details: undefined, isError: true };
            }
            const tail = job.tail?.trim();
            const body = [`${jobSummary(job)}${tail ? `\n\nLast output:\n${tail}` : ""}`];
            if (job.status === "running") body.push(`\n${NOT_OUTPUT_REMINDER}`);
            return {
              content: [{ type: "text", text: body.join("\n") }],
              details: { kind: "pi-web-background-job", jobId: job.id, status: job.status, command: job.command, outputPath: job.outputPath },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "stop_background_job",
        label: "Stop background job",
        description: "Stop a running background command and its child processes. Returns the job's final record.",
        parameters: Type.Object({
          job_id: Type.String({ description: "The job id returned by bash_background." }),
        }),
        async execute(_toolCallId, params) {
          try {
            const job = stopJobFromTool(params.job_id);
            if (!job) {
              return { content: [{ type: "text", text: `No running background job with id ${params.job_id} (it may have already finished).` }], details: undefined, isError: true };
            }
            return {
              content: [{ type: "text", text: jobSummary(job) }],
              details: { kind: "pi-web-background-job", jobId: job.id, status: job.status, command: job.command, outputPath: job.outputPath },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));
    },
  };
}