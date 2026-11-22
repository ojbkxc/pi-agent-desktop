/**
 * 挂起调度器（server-only）。
 *
 * 仿 `startAutofixSweepLoop`（`lib/autofix/runner.ts:548-569`）：
 * - `globalThis` 持 timer（Next 的 hot-reload 不会叠出第二个循环）；
 * - `unref()`（不阻止进程退出）；
 * - 起始立刻扫一次，之后每 `tickMs` 扫一次；
 * - 由 `instrumentation-node.ts` 启动，`PI_WEB_DISABLE_SCHEDULER=1` 时不启动。
 *
 * 每条记录的处理（`runOutageTick`）：
 * 1. 只推进 `status === "waiting"` 且 `nextAttemptAt <= now` 的记录；
 * 2. 归属：`pid` 活着且不是本进程 ⇒ 跳过（别人拥有）；本进程重启后旧记录
 *    的 pid 已死 ⇒ 可接续（判据见 `classifyOutageRecord`）；
 * 3. 防抢跑：会话最后的 user 消息已不是挂起时那条 ⇒ `superseded`；
 * 4. 两段式探测：前 `OUTAGE_DIRECT_RETRY_ATTEMPTS` 次直接续跑（连接失败不产生
 *    token，成本≈0）；之后先跑轻量探针，成功才续跑；
 * 5. 记账：`advanceOutageBudget` 推进 attempts/nextAttemptAt，双闸触顶 ⇒
 *    `expired`（UI 提示并停止）。
 *
 * 所有副作用都是注入的（`deps`）：单测用假时钟 + 假会话，不会有任何网络/磁盘
 * 写入（store 的 agentDir 也可注入）。
 */
import { advanceOutageBudget, isOutageDue } from "./backoff";
import { chooseResumeMessage } from "./resume";
import {
  finishOutageRecord,
  isOutageSuperseded,
  listOutageRecords,
  outageSettingsPath,
  readOutageSettings,
  updateOutageRecord,
} from "./store";
import {
  classifyOutageRecord,
  isOutageExpired,
  OUTAGE_DIRECT_RETRY_ATTEMPTS,
  OUTAGE_DEFAULT_TICK_MS,
  type OutageRecord,
} from "./types";

/** 续跑所需的会话面（`AgentSessionWrapper` 结构满足它）。 */
export interface OutageSessionLike {
  isAlive?(): boolean;
  isRunning?(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
}

export interface OutageSchedulerDeps {
  now(): number;
  /**
   * 按会话 id 取活跃 wrapper。返回 undefined 表示会话不在内存里（被 idle 驱逐
   * 或进程重启过），由 `resume` 负责重开。
   */
  getSession(sessionId: string): OutageSessionLike | undefined;
  /** 重新打开会话（重启接续 / wrapper 已驱逐）。返回可 send 的 wrapper。 */
  openSession(record: OutageRecord): Promise<OutageSessionLike>;
  /** 轻量探针（该 provider 的 1-token 请求或模型列表）。true = 已恢复。 */
  probe(record: OutageRecord): Promise<boolean>;
  /** 会话最后一条 user 消息的 entry id；读不到返回 null。 */
  lastUserMessageId(sessionId: string): Promise<string | null> | string | null;
  /** 落盘目录注入（测试）。undefined = 默认 agent dir。 */
  agentDir?: string;
}

export type OutageTickOutcome =
  | "skipped-owned"
  | "skipped-other-process"
  | "skipped-not-due"
  | "skipped-busy"
  /**
   * scope="autofix" / "campaign" 的记录只是预算/退避账本：驱动者是各自的 sweep（它们还要跑
   * 验证命令并推进轮次），通用调度器绝不能自己去续跑那个会话，否则会双驱动。
   */
  | "skipped-autofix"
  | "skipped-campaign"
  | "superseded"
  | "expired"
  | "probe-unavailable"
  | "resumed"
  | "resume-error";

export interface OutageTickAction {
  sessionId: string;
  outcome: OutageTickOutcome;
  /** 备注（错误摘要 / 探针结果），供日志。 */
  detail?: string;
}

/**
 * 跑一轮扫描。纯「读 → 判定 → 注入副作用 → 落盘」，不启动 timer。
 * 返回本轮每个到期记录的动作（测试与日志用）。
 */
export async function runOutageTick(deps: OutageSchedulerDeps): Promise<OutageTickAction[]> {
  const now = deps.now();
  const settings = readOutageSettings(outageSettingsPath(deps.agentDir));
  const actions: OutageTickAction[] = [];

  // 开关关闭：不推进任何记录（保留它们，用户重新打开即可继续）。
  if (!settings.enabled) return actions;

  const waiting = listOutageRecords({ agentDir: deps.agentDir, waitingOnly: true });
  for (const record of waiting) {
    try {
      actions.push(await handleRecord(record, deps, now));
    } catch (error) {
      actions.push({
        sessionId: record.sessionId,
        outcome: "resume-error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return actions;
}

async function handleRecord(
  record: OutageRecord,
  deps: OutageSchedulerDeps,
  now: number,
): Promise<OutageTickAction> {
  const sessionId = record.sessionId;
  // autofix 自己驱动（每轮还要跑验证命令），通用调度器只读不动。
  if (record.scope === "autofix") return { sessionId, outcome: "skipped-autofix" };
  // campaign 同理：由 campaign sweep 驱动（逐项推进 + 验证），通用调度器不抢。
  if (record.scope === "campaign") return { sessionId, outcome: "skipped-campaign" };

  // 归属判定：别的活进程拥有 ⇒ 不抢；本进程重启后旧 pid 已死 ⇒ 接续。
  //
  // **必须在「到期」判定之前**：别的活进程的记录由它自己推进（包括清过期），
  // 本进程替它清会产生两个进程同写一份记录的竞态。
  const disposition = classifyOutageRecord(record, { now });
  if (disposition === "owned" && record.pid !== process.pid) {
    return { sessionId, outcome: "skipped-other-process" };
  }
  if (!(disposition === "resumable" || (disposition === "owned" && record.pid === process.pid))) {
    return { sessionId, outcome: "skipped-owned" };
  }

  // 双闸（次数/死线）：即使没到 nextAttemptAt，也要在 tick 里清掉过期的记录。
  //
  // **必须排在 `isOutageDue` 之前**：退避档会一路推到 30 分钟，而 deadline 可能更早到；
  // 先判 due 的话，过期记录要等退避到点才转 expired，这段时间它会一直显示「等待中」。
  if (isOutageExpired(record, now)) {
    finishOutageRecord(sessionId, "expired", now, {}, deps.agentDir);
    return { sessionId, outcome: "expired" };
  }

  if (!isOutageDue(record, now)) return { sessionId, outcome: "skipped-not-due" };

  // 防抢跑：用户中途发了新消息 ⇒ 记录作废。
  const lastUser = await deps.lastUserMessageId(sessionId);
  if (isOutageSuperseded(record, lastUser)) {
    finishOutageRecord(sessionId, "superseded", now, {}, deps.agentDir);
    return { sessionId, outcome: "superseded" };
  }

  // 会话正在跑（用户自己刚发了消息且 preflight 已接受）：跳过，下一 tick 再看。
  const live = deps.getSession(sessionId);
  if (live?.isRunning?.()) return { sessionId, outcome: "skipped-busy" };

  // 两段式探测：前 3 次直接续跑；之后先探针。
  const directRetry = record.budget.attempts < OUTAGE_DIRECT_RETRY_ATTEMPTS;
  if (!directRetry) {
    let available = false;
    try {
      available = await deps.probe(record);
    } catch {
      available = false;
    }
    if (!available) {
      // 探针失败也算一次尝试（避免无限探针）；真到顶就 expired。
      const advanced = advanceOutageBudget(record, now);
      if (advanced.expired) {
        finishOutageRecord(sessionId, "expired", now, { lastError: "Provider still unavailable" }, deps.agentDir);
        return { sessionId, outcome: "expired" };
      }
      updateOutageRecord(sessionId, () => ({ ...advanced.record, lastAttemptAt: now, lastError: "Provider still unavailable" }), deps.agentDir);
      return { sessionId, outcome: "probe-unavailable" };
    }
  }

  // 续跑：优先复用活跃 wrapper；不在内存就按记录重开（重启接续）。
  // openSession 抛错也按一次失败尝试记账（会话文件没了不是上游恢复的证据）。
  let session: OutageSessionLike;
  try {
    session = live ?? (await deps.openSession(record));
  } catch (error) {
    const advanced = advanceOutageBudget(record, now);
    const detail = error instanceof Error ? error.message : String(error);
    if (advanced.expired) {
      finishOutageRecord(sessionId, "expired", now, { lastError: detail }, deps.agentDir);
      return { sessionId, outcome: "expired", detail };
    }
    updateOutageRecord(sessionId, () => ({ ...advanced.record, lastAttemptAt: now, lastError: detail }), deps.agentDir);
    return { sessionId, outcome: "resume-error", detail };
  }
  const message = chooseResumeMessage(record, {
    now,
    promptPersisted: record.resume.promptPersisted === true || Boolean(lastUser),
    hasPromptText: typeof record.resume.promptText === "string" && record.resume.promptText.length > 0,
  });
  try {
    // 必须发 `prompt`，不能发 `follow_up`：SDK 1.5.0 的 `agent.followUp()` 只把消息
    // 压进 followUpQueue（pi-agent-core/dist/agent.js:191），**空闲会话不会因此启动
    // 一轮**——挂起记录恰恰产生在 turn 已结束之后，此时会话必然空闲，发 follow_up
    // 等于永久排队、永远不会恢复（验收实测：idle + followUp ⇒ runs=0）。
    // `prompt` 在空闲时直接开跑；若会话此刻恰好在 streaming，SDK 要求显式
    // streamingBehavior，于是带上 "followUp" 排到本轮之后，两种状态都能续上。
    // 与同仓 composerQueue（lib/rpc-manager.ts:531）和 goal 的续跑同一口径。
    await session.send({
      type: "prompt",
      message: message.text,
      streamingBehavior: "followUp",
    });
  } catch (error) {
    const advanced = advanceOutageBudget(record, now);
    const detail = error instanceof Error ? error.message : String(error);
    if (advanced.expired) {
      finishOutageRecord(sessionId, "expired", now, { lastError: detail }, deps.agentDir);
      return { sessionId, outcome: "expired", detail };
    }
    updateOutageRecord(sessionId, () => ({ ...advanced.record, lastAttemptAt: now, lastError: detail }), deps.agentDir);
    return { sessionId, outcome: "resume-error", detail };
  }

  // 续跑成功发出：attempts + 1、排下一次。**记录不删**——它还在 waiting，
  // 下一次 `agent_settled` 若又失败会由 rpc-hook 记账；若成功则由 hook 清计数。
  // 但为了避免同一轮被再次续跑（followUp 只消费一次，send 成功即表示已提交），
  // 把 nextAttemptAt 推到下一个退避档；若这一轮真的再失败，hook 会把它拨回 now。
  const advanced = advanceOutageBudget(record, now);
  if (advanced.expired) {
    // 已到最后一次：发出去就不再排下一次，但仍保留 waiting 等这轮结果。
    updateOutageRecord(sessionId, () => ({ ...advanced.record, lastAttemptAt: now }), deps.agentDir);
  } else {
    updateOutageRecord(sessionId, () => ({ ...advanced.record, lastAttemptAt: now, lastError: null }), deps.agentDir);
  }
  return { sessionId, outcome: "resumed" };
}

// ───────────────────────────── timer 生命周期 ─────────────────────────────

const LOOP_KEY: symbol = Symbol.for("pi-web:outage-sweep");

interface OutageLoopHandle {
  timer: ReturnType<typeof setInterval>;
  ticking: { value: boolean };
}

/**
 * 进程级调度循环（instrumentation 启动）。幂等；`tickMs` 默认 30s。
 * `PI_WEB_DISABLE_SCHEDULER=1` 由调用方判断（照 autofix 的写法）。
 */
export function startOutageSchedulerLoop(
  deps: Omit<OutageSchedulerDeps, "now"> & { now?: () => number; tickMs?: number },
): void {
  const holder = globalThis as unknown as Record<symbol, OutageLoopHandle | undefined>;
  if (holder[LOOP_KEY]) return;
  const tickMs = deps.tickMs ?? OUTAGE_DEFAULT_TICK_MS;
  const now = deps.now ?? (() => Date.now());
  const ticking = { value: false };
  const tick = (): void => {
    if (ticking.value) return;
    ticking.value = true;
    void runOutageTick({ ...deps, now })
      .catch((error) => console.error("[outage] sweep failed:", error instanceof Error ? error.message : error))
      .finally(() => {
        ticking.value = false;
      });
  };
  tick();
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  holder[LOOP_KEY] = { timer, ticking };
}