/**
 * pi-agent-desktop 内置接线：把既有 subagent runtime（lib/subagent-runtime.ts 的
 * createSubagentController）适配成 pi-team 扩展要求的 TeamHost。
 *
 * 这是团队扩展与宿主之间的唯一接缝（见 pi-team/src/teamHost.ts）。团队扩展**不重写
 * spawn**：会话创建/续跑/steering 全部委托给这里的 controller。
 *
 * 与 rpc-manager 的耦合只有两处，且都用结构类型描述、不 import 宿主模块：
 *   - 进程级会话注册表 `globalThis.__piSessions`（AgentSessionWrapper 的 Map），
 *     用于 `wake()` 向 idle 成员投递合并消息；
 *   - controller 的 `extensionRuntime.start/resume` 与顶层 `get/steer/abort`。
 *
 * onFinish 不轮询：controller.start/resume 返回的 `completion` Promise 结束即回调，
 * 天然满足「成员完成唤醒等待者」。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemberRunHandle, MemberRunStatus, TeamHost } from "pi-team";
import type { SubagentController } from "./subagent-runtime";
import type { SubagentExecution, StartSubagentRequest } from "./subagent-extension";
import type { SubagentRunInfo } from "./subagents";

/** pi 的 run 状态（lib/types.ts 的 SubagentSessionStatus）映射到团队成员状态。 */
function toMemberStatus(status: SubagentRunInfo["status"]): MemberRunStatus {
  switch (status) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "aborted":
      return status;
    // `starting` / `interrupted` 团队侧没有对应态：未真正跑起来的按 queued，
    // 被打断的按 aborted（终态），避免等待者永远等一个不会到来的结果。
    case "starting":
      return "queued";
    case "interrupted":
      return "aborted";
    default:
      return "running";
  }
}

function toHandle(run: SubagentRunInfo): MemberRunHandle {
  return {
    sessionId: run.sessionId,
    ...(run.sessionPath ? { sessionFile: run.sessionPath } : {}),
    status: toMemberStatus(run.status),
    ...(run.result !== undefined ? { result: run.result } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    description: run.description,
    ...(run.resumed ? { resumed: true } : {}),
  };
}

/** AgentSessionWrapper 里 wake 需要用到的最小结构（不 import lib/rpc-manager，避免环）。 */
interface WakeableSession {
  isAlive?(): boolean;
  isRunning?(): boolean;
  inner?: {
    sendCustomMessage?(
      message: { customType: string; content: string; display: boolean; details?: unknown },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): Promise<void>;
  };
}

function getHostSessions(): Map<string, WakeableSession> | undefined {
  return (globalThis as Record<string, unknown>).__piSessions as Map<string, WakeableSession> | undefined;
}

export interface SubagentTeamHostOptions {
  /** 取得「哪个会话正在执行团队工具」的 SDK 上下文；由内置工厂在 session_start 时填充。 */
  getContext(): ExtensionContext | undefined;
}

/**
 * 把一个已装配好的 subagent controller 适配成 TeamHost。
 * controller 为 undefined 时返回一个降级桥：spawn 明确失败，但团队数据/邮箱仍可用。
 */
export function createSubagentTeamHost(controller: SubagentController, options: SubagentTeamHostOptions): TeamHost {
  const listeners = new Set<(handle: MemberRunHandle) => void>();

  const emitFinish = (run: SubagentRunInfo): void => {
    const handle = toHandle(run);
    for (const listener of listeners) {
      try {
        listener(handle);
      } catch {
        // 监听器异常不得打断派发
      }
    }
  };

  /** 订阅一次运行的完成；返回本次运行的首个句柄。 */
  const attach = (exec: SubagentExecution): MemberRunHandle => {
    exec.completion.then(emitFinish, (error: unknown) => {
      emitFinish({
        ...exec.run,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return toHandle(exec.run);
  };

  const requireContext = (): ExtensionContext => {
    const ctx = options.getContext();
    if (!ctx) throw new Error("团队宿主尚未绑定会话上下文（session 未启动）。");
    return ctx;
  };

  return {
    kind: "subagent",
    async start(request) {
      const parentContext = requireContext();
      const startRequest: StartSubagentRequest = {
        parentContext,
        parentToolCallId: `pi-team:${request.name}`,
        profile: request.profile,
        task: request.task,
        description: request.description,
        runInBackground: request.runInBackground ?? true,
        ...(request.model ? { model: request.model } : {}),
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.isolation ? { isolation: request.isolation } : {}),
        // 成员身份注入：宿主据此在成员会话写入 PI_AGENT_NAME / PI_TEAM_NAME 并注入
        // 身份 system prompt（设计文档 §8.4）。
        ...(request.teamName ? { teamName: request.teamName } : {}),
        ...(request.agentName ? { agentName: request.agentName } : {}),
      };
      return attach(await controller.extensionRuntime.start(startRequest));
    },
    async revive(request) {
      const parentContext = requireContext();
      const task = request.task ?? "继续你之前的任务，并把结果回报给团队。";
      return attach(
        await controller.extensionRuntime.resume({
          parentContext,
          parentToolCallId: `pi-team:${request.name ?? request.sessionId}`,
          sessionId: request.sessionId,
          task,
          description: request.description ?? request.name ?? "复活成员",
          runInBackground: true,
        }),
      );
    },
    async get(sessionId) {
      const run = await controller.get(sessionId);
      return run ? toHandle(run) : null;
    },
    async steer(sessionId, message) {
      await controller.steer(sessionId, message);
    },
    async stop(sessionId) {
      await controller.abort(sessionId);
    },
    async wake({ sessionId, text }) {
      const session = getHostSessions()?.get(sessionId);
      if (!session?.isAlive?.() || !session.inner?.sendCustomMessage) return false;
      // 活跃会话（running 或 idle）都能接：running 时按 followUp 入队，idle 时直接触发新一轮。
      await session.inner.sendCustomMessage(
        { customType: "pi-team:message", content: text, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return true;
    },
    onFinish(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** controller 缺位时的降级桥：spawn 明确失败，邮箱/生命周期仍可用（与 pi-team 的 noop 桥一致语义）。 */
export function createUnavailableTeamHost(): TeamHost {
  return {
    kind: "none",
    async start() {
      throw new Error(
        "pi-agent-desktop 未启用内置子 agent（isBuiltInSubagentsEnabled=false），团队成员无法派发；团队数据与邮箱仍可用。",
      );
    },
    async revive() {
      throw new Error("内置子 agent 未启用，无法复活成员。");
    },
    async get() {
      return null;
    },
    async steer() {
      throw new Error("内置子 agent 未启用，无法向成员发送 steering。");
    },
    async stop() {
      throw new Error("内置子 agent 未启用，无法停止成员。");
    },
    async wake() {
      return false;
    },
    onFinish() {
      return () => {};
    },
  };
}
