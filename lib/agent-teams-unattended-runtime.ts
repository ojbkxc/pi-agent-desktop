/**
 * 无人值守兜底——集成层（薄）。
 *
 * 把决策核心的「动作列表」落成三件事：把 prompt 投递给 lead 会话（不在就先 revive）、
 * 给用户发通知、把账本写回磁盘。决策本身不在这里，见 lib/agent-teams-unattended.ts。
 *
 * 为什么是「提醒 lead」而不是桌面直接 approve：approve 是 lead 自己的 team_plan 工具；
 * 桌面直接操作 pi-team 内部要踩 M4（config 的 leadSessionId 恒为 'unknown-session'）与
 * H4（幂等静默失败）。让 AI 自己判断边界更本质。
 *
 * 集成点（调度注册、发命令、通知）保持薄，且**默认实现全部惰性 import**——重模块
 * （rpc-manager 会拖进 pi SDK）只在真正要投递时才加载，启动开销近零，也便于单测注入。
 */
import {
  planUnattendedActions,
  describeAction,
  type UnattendedAction,
  type UnattendedState,
} from "./agent-teams-unattended";
import {
  collectUnattendedInput,
  readUnattendedFile,
  unattendedSettingsPath,
  writeUnattendedState,
  type UnattendedInput,
} from "./agent-teams-unattended-store";

export interface DeliveryResult {
  ok: boolean;
  reason?: string;
}

export type NotifyKind = "nudged" | "needs-human" | "exhausted";

export interface NotifyEvent {
  sessionId: string;
  kind: NotifyKind;
  detail: string;
}

export interface SweepDeps {
  now(): number;
  /** 读配置 + 账本；`filePath` 供 writeState 复用。 */
  readState(): { config: ReturnType<typeof readUnattendedFile>["config"]; state: UnattendedState; filePath: string };
  writeState(state: UnattendedState, filePath: string): void;
  collect(): Promise<UnattendedInput>;
  /** 把 prompt 发给 lead 会话；不在则先 revive。 */
  deliver(sessionId: string, message: string): Promise<DeliveryResult>;
  notify(event: NotifyEvent): Promise<void>;
  log(message: string): void;
}

export interface SweepResult {
  actions: number;
  nudged: number;
  failed: number;
  notified: number;
}

const nudgeKey = (action: UnattendedAction): string =>
  action.kind === "nudge-approval" ? `plan:${action.planId}` : `ticket:${action.ticketId}`;

/**
 * 投递一条 prompt 给 lead 会话。
 *
 * 存活 → 直接 send；不在 → 用 resolveSessionPath 找到会话文件后 startRpcSession 复活再发。
 * lead 正在跑（isRunning）则跳过，避免把提醒塞进一次进行中的运行。
 * 任意失败都如实返回 { ok:false, reason }，绝不静默吞掉。
 */
async function defaultDeliver(sessionId: string, message: string): Promise<DeliveryResult> {
  try {
    const { getRpcSession, startRpcSession } = await import("./rpc-manager");
    const existing = getRpcSession(sessionId);
    if (existing?.isAlive()) {
      if (existing.isRunning()) return { ok: false, reason: "lead 会话正在运行，跳过以免打断" };
      await existing.send({ type: "prompt", message });
      return { ok: true };
    }
    const { resolveSessionPath } = await import("./session-reader");
    const filePath = await resolveSessionPath(sessionId);
    if (!filePath) return { ok: false, reason: "找不到 lead 会话文件（可能已被删除）" };
    const { session } = await startRpcSession(sessionId, filePath, undefined, {});
    await session.send({ type: "prompt", message });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function defaultNotify(event: NotifyEvent): Promise<void> {
  try {
    const { notifySessionEvent } = await import("./web-push");
    await notifySessionEvent(event.sessionId, {
      kind: event.kind === "needs-human" || event.kind === "exhausted" ? "failed" : "attention",
      detail: event.detail,
      // 独立 tag：兜底提醒不能被随后真正的「会话完成」推送顶掉（两者同一 lead 会话）。
      tag: `teams-fallback:${event.sessionId}`,
    });
  } catch (error) {
    console.error("[teams-fallback] 通知用户失败:", error instanceof Error ? error.message : error);
  }
}

export function defaultSweepDeps(): SweepDeps {
  return {
    now: () => Date.now(),
    readState() {
      const filePath = unattendedSettingsPath();
      const file = readUnattendedFile(filePath);
      return { config: file.config, state: file.state, filePath };
    },
    writeState(state, filePath) {
      writeUnattendedState(state, filePath);
    },
    collect: () => collectUnattendedInput(),
    deliver: defaultDeliver,
    notify: defaultNotify,
    log: (message) => console.log(`[teams-fallback] ${message}`),
  };
}

/**
 * 跑一轮：读 → 决策 → 执行 → 落盘。
 *
 * 落盘时机：只要有动作就写 `next`（即使投递失败也写），否则失败项会每 tick 重发。
 * 投递失败 / 已耗尽重试的动作会写进 `state.manualNeeds` 并发通知，绝不静默放弃。
 */
// ── D3-2 防重入护栏 ──────────────────────────────────────────────────────────
// 一轮 sweep 的 deliver（lead 不在时走 startRpcSession 复活，且 send({type:"prompt"}) 要等
// 扩展绑定与 MCP 服务器连接——rpc-manager 的 prompt 先等 preflight 才返回）与 notify
// （web-push 逐设备串行网络发送）都可能超过 60s 的 tick 间隔——慢的是「复活 lead + 慢 MCP
// 等待 + 慢推送 + 多动作累积」，不是普通轮次时长。账本（approvalNudges/failureNudges/
// manualNeeds）只在循环尾一次性落盘：重入的下一 tick 会读旧账本重复决策，不仅向 lead
// 重复投递同一提醒，后写者还会用旧 next 整体覆盖、抹掉并发轮写进 manualNeeds 的条目。
// 与 lib/scheduled-tasks/scheduler.ts 的 ticking 同法：进行中直接跳过本 tick。
//
// 已知窗口（队长知情、本轮有意不修）：账本循环尾落盘 ⇒ sweep 中途进程退出时已发出的
// 提醒未记账，重启后首个 tick 可能对同一 plan/ticket 重复提醒一次。「逐动作落盘」只能
// 缩小窗口（deliver 之后、writeState 之前的窗口与写入频率无关），要闭合需 write-ahead 的
// attempt 标记 + 陈旧标记升级为人工确认通知，属协议设计，不在本批次。
let sweepInFlight = false;

export async function runUnattendedSweep(deps: SweepDeps = defaultSweepDeps()): Promise<SweepResult> {
  if (sweepInFlight) return { actions: 0, nudged: 0, failed: 0, notified: 0 };
  sweepInFlight = true;
  try {
    return await runUnattendedSweepOnce(deps);
  } finally {
    sweepInFlight = false;
  }
}

async function runUnattendedSweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const { config, state, filePath } = deps.readState();
  const input = await deps.collect();
  const { actions, state: next } = planUnattendedActions({
    now: deps.now(),
    config,
    awaitingPlans: input.awaitingPlans,
    failedAssignments: input.failedAssignments,
    state,
  });

  if (actions.length === 0) return { actions: 0, nudged: 0, failed: 0, notified: 0 };

  const manualNeeds = { ...(next.manualNeeds ?? {}) };
  let nudged = 0;
  let failed = 0;
  let notified = 0;

  for (const action of actions) {
    if (action.kind === "notify-exhausted") {
      notified += 1;
      manualNeeds[nudgeKey(action)] = { at: deps.now(), reason: "失败已达自动重试上限" };
      await deps.notify({ sessionId: action.sessionId, kind: "exhausted", detail: describeAction(action) });
      continue;
    }
    const result = await deps.deliver(action.sessionId, action.prompt);
    if (result.ok) {
      nudged += 1;
      await deps.notify({ sessionId: action.sessionId, kind: "nudged", detail: describeAction(action) });
    } else {
      failed += 1;
      manualNeeds[nudgeKey(action)] = { at: deps.now(), reason: result.reason ?? "投递失败" };
      deps.log(`提醒 lead 失败（${nudgeKey(action)}）：${result.reason ?? "未知原因"}`);
      await deps.notify({
        sessionId: action.sessionId,
        kind: "needs-human",
        detail: `${describeAction(action)}（自动提醒未能送达：${result.reason ?? "未知原因"}，需要你人工处理）`,
      });
    }
  }

  deps.writeState({ ...next, manualNeeds }, filePath);
  deps.log(`本轮动作 ${actions.length}：提醒成功 ${nudged}、失败 ${failed}、仅通知 ${notified}`);
  return { actions: actions.length, nudged, failed, notified };
}

// ─────────────────────────────────────────────────────────────────────────────
// 循环（服务端启动）
// ─────────────────────────────────────────────────────────────────────────────

export const UNATTENDED_SWEEP_INTERVAL_MS = 60_000;

interface SweepLoopHandle {
  stop(): void;
}

const LOOP_KEY = Symbol.for("pi-web:teams-unattended-loop");

/**
 * 并列启动一个小循环（不改 lib/scheduled-tasks/** 内部，也不占用用户的 Scheduled 列表）。
 * 幂等：重复调用返回同一个句柄。timer unref，不拖住进程退出。
 */
export function startUnattendedSweepLoop(intervalMs = UNATTENDED_SWEEP_INTERVAL_MS): SweepLoopHandle {
  const holder = globalThis as unknown as Record<symbol, SweepLoopHandle | undefined>;
  const existing = holder[LOOP_KEY];
  if (existing) return existing;

  const timer = setInterval(() => {
    void runUnattendedSweep().catch((error) => {
      console.error("[teams-fallback] 扫描失败:", error instanceof Error ? error.message : error);
    });
  }, intervalMs);
  timer.unref?.();

  const handle: SweepLoopHandle = {
    stop() {
      clearInterval(timer);
      holder[LOOP_KEY] = undefined;
    },
  };
  holder[LOOP_KEY] = handle;
  return handle;
}
