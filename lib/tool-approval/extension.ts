/**
 * 命令审批扩展：在 `tool_call` 钩子上按策略要求用户确认危险 shell 命令
 * （对齐 alma.now 的「批准命令」）。
 *
 * 接线约定：
 * - 只拦 shell 类工具（`bash` / `powershell` / `bash_background`，清单的唯一真源是
 *   `policy.ts` 的 `SHELL_TOOLS` / `isShellTool`）；文件类工具、MCP 与自定义工具一律放行。
 * - 命中后走宿主的 **现有** 扩展 UI 管道：`ctx.ui.confirm(title, message)` ——
 *   pi-web 的 ChatWindow 已有 confirm 渲染与排队机制，这里不自建弹窗协议。
 * - `confirm` 返回 false 时返回 `{ block: true, reason }`，模型看到拒绝原因，
 *   命令不执行；返回 true 时不管 input（**绝不修改 event.input**）。
 * - 确认框有超时（默认 10 分钟，`ExtensionUIDialogOptions.timeout`）：超时按**安全侧**
 *   处理 —— 拒绝该命令（block，reason 写明超时），绝不静默放行。
 * - **fail-open**：无 UI（headless / CI / e2e 的子会话）、`ctx.ui` 不可用、`getMode` /
 *   `requiresApproval` 抛异常、`confirm` 抛异常，一律放行。审批器是加法，坏掉时不能把
 *   会话卡死；异常只记一次日志。**超时不是故障**，所以不走 fail-open。
 * - 无人值守运行（定时任务 / autofix）由启动路径注入「无审批」处理（integrator 接线），
 *   本扩展不自行判断宿主类型。
 * - nested calls（codemode 内层 bash）走同一 hook，无需额外处理。
 * - 默认档 off，由设置页决定何时生效（见 lib/tool-approval/settings.ts）。
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { requiresApproval, isShellTool, type ApprovalDecision, type ApprovalMode } from "./policy";
import { readApprovalMode } from "./settings";
import { recordGate } from "../gate-attribution";

/** 确认框标题（服务端文案，语言中立口径见 docs/i18n.md；标题在扩展 UI 卡片上原样展示）。 */
export const APPROVAL_CONFIRM_TITLE = "需要确认的命令";

/** 用户拒绝时回给模型的 reason。 */
export const APPROVAL_REJECTED_REASON = "用户拒绝了该命令";

/**
 * 确认框的超时（默认 10 分钟）。超时按**安全侧**处理：拒绝该命令（block），
 * 释放会话与界面上的对话框，绝不静默放行。
 */
export const APPROVAL_CONFIRM_TIMEOUT_MS = 10 * 60_000;

/** 确认超时时回给模型的 reason。 */
export const APPROVAL_TIMEOUT_REASON = "确认超时，该命令未执行";

/** `ctx` 在本扩展里用到的最小形状（测试可注入，无需构造整个 ExtensionContext）。 */
export interface ApprovalContextLike {
  hasUI?: boolean;
  ui?: {
    confirm?: (
      title: string,
      message: string,
      opts?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<boolean>;
  };
}

export interface ToolApprovalExtensionOptions {
  /** 当前模式；默认读设置文件。每次 tool_call 都重新读，设置一改下一次调用即生效。 */
  getMode?: () => ApprovalMode;
  /** 异常日志口（默认 console.warn）；测试注入以断言「只记一次」。 */
  log?: (message: string) => void;
  /** 确认超时毫秒数（默认 `APPROVAL_CONFIRM_TIMEOUT_MS`）；测试可缩短。 */
  confirmTimeoutMs?: number;
}

/**
 * 扩展工厂：返回 `(pi) => void` 的注册钩子（与 builtin(...) 的 factory 位兼容）。
 */
export function createToolApprovalExtension(
  options: ToolApprovalExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  let loggedFailure = false;
  const log = options.log ?? ((message: string) => console.warn(message));
  const getMode = options.getMode ?? (() => readApprovalMode());
  const confirmTimeoutMs = options.confirmTimeoutMs ?? APPROVAL_CONFIRM_TIMEOUT_MS;

  const logOnce = (message: string): void => {
    if (loggedFailure) return;
    loggedFailure = true;
    try {
      log(message);
    } catch {
      // 日志本身失败也不影响放行。
    }
  };

  return (pi) => {
    pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
      // 1) 模式：非 shell 工具先放行，避免为其它工具读设置。
      //
      // 必须用 policy 的 isShellTool，**不要在这里再抄一份工具名清单**：抄过一份，
      // 结果是 bash_background 加进 policy 的 SHELL_TOOLS 后仍然完全不经审批
      // （policy 层成了死代码，等于一条绕过审批的后门）。工具名清单只许有一个真源。
      if (!isShellTool(event.toolName)) return undefined;

      let decision: ApprovalDecision;
      try {
        decision = requiresApproval(getMode(), event);
      } catch {
        // 读不到模式或策略本身出错 = off。emitToolCall 不会吞 handler 异常，任何一处
        // 漏抛都会让工具调用失败，所以判定整体也包在 try 里（fail-open）。
        return undefined;
      }
      if (!decision.required) return undefined;

      // 2) UI 可用性：宿主没有真实 UI 时直接放行（headless / CI / e2e）。
      const ui = (ctx as ApprovalContextLike | undefined)?.ui;
      const hasUI = (ctx as ApprovalContextLike | undefined)?.hasUI;
      if (hasUI === false || !ui || typeof ui.confirm !== "function") {
        logOnce(`[tool-approval] no confirmation UI for ${event.toolName}; allowing the command (fail-open)`);
        // 只记录本闸门自己的结论，不参与判定（见 lib/gate-attribution.ts）。
        recordGate({ layer: "tool-approval", decision: "allowed", reason: "fail-open-no-ui" });
        return undefined;
      }

      // 3) 问用户：true 放行，false 拦截；任何异常都放行（fail-open）。
      //
      // 超时按安全侧处理（block）。两层保障：
      // - `opts.timeout` 让宿主的确认框自带倒计时并在到期时自行关闭（宿主把到期
      //   当作 confirm=false 结算，见 lib/rpc-manager.ts 的 requestExtensionUi）；
      // - 本地定时器在**同一个**时间点 abort `opts.signal`（宿主的契约），先把
      //   `timedOut` 置位再 abort，于是无论哪条先到，我们都能把「超时」与
      //   「用户点了拒绝」区分开。宿主 timeout 故意晚 1 秒，本地判定总是先到。
      let timedOut = false;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, confirmTimeoutMs);
      let confirmed: boolean;
      try {
        confirmed = await ui.confirm(APPROVAL_CONFIRM_TITLE, decision.summary, {
          signal: controller.signal,
          timeout: confirmTimeoutMs + 1000,
        });
      } catch (error) {
        logOnce(
          `[tool-approval] confirm failed (${error instanceof Error ? error.message : String(error)}); ` +
          "allowing the command (fail-open)",
        );
        recordGate({ layer: "tool-approval", decision: "allowed", reason: "fail-open-confirm-error" });
        return undefined;
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) {
        recordGate({ layer: "tool-approval", decision: "denied", reason: "timeout" });
        return { block: true, reason: APPROVAL_TIMEOUT_REASON };
      }
      if (confirmed !== true) {
        recordGate({ layer: "tool-approval", decision: "denied", reason: "rejected" });
        return { block: true, reason: APPROVAL_REJECTED_REASON };
      }
      recordGate({ layer: "tool-approval", decision: "allowed", reason: "confirmed" });
      return undefined;
    });
  };
}

/** 供设置页 / API 复用的档位清单（防止 UI 与策略漂移）。 */
export { APPROVAL_MODES, type ApprovalMode } from "./policy";