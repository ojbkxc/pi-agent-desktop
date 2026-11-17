/**
 * 团队成员模型自动切换的**运行时**（薄接入层）。
 *
 * 决策全在 `lib/agent-teams-model-fallback.ts`（纯函数、可单测）；这里只负责把外部事实
 * 拼起来并执行：读团队名册 → 查每个候选的凭据 → 决策 → 切模型 → 续跑。
 *
 * 落点：`lib/rpc-manager.ts` 的 `agent_settled` 钩子（与 outage 同一个位置）。
 * 顺序很重要 —— **先**尝试换模型，换成了就把 outage 记录摘掉（scope 改成 team），
 * 换不成再让 outage 去挂起等待。反过来做就会两套驱动同时往会话里灌消息。
 */
import { getModelRuntimeWithExtensions } from "./model-runtime";
import {
  decideModelFallback,
  modelFallbackAttempts,
  modelFallbackTried,
  recordModelFallbackAttempt,
  markModelFallbackFailed,
  buildLeadNudgePrompt,
  MAX_MODEL_FALLBACKS_PER_MEMBER,
  MODEL_FALLBACK_RESUME_PROMPT,
  type ModelCandidate,
  type ModelFallbackDecision,
} from "./agent-teams-model-fallback";
import { classifyOutageError } from "./outage/classify";
import { cancelOutageRecord } from "./outage/store";

export interface TeamModelFallbackRuntimeDeps {
  /** 找到包含该会话的团队目录名；不属于任何团队返回 null。 */
  findTeam: (sessionId: string) => Promise<string | null>;
  /** 读团队名册；失败返回 null。 */
  readRoster: (teamName: string) => Promise<Array<{ name?: string; sessionId?: string; runtime?: { providerId?: string; modelId?: string } }> | null>;
  /** 该会话当前生效的模型。 */
  currentModel: (sessionId: string) => Promise<ModelCandidate | null>;
  /**
   * 该模型是否可用：**模型存在 且 provider 有凭据**（与 SDK `AgentSession.setModel`
   * 的前置校验同判据）。两半都缺一不可——只有 auth 没有模型，set_model 会抛
   * "Model not found"；只有模型没有 auth，会抛 "No API key"。
   */
  hasAuth: (candidate: ModelCandidate) => Promise<boolean>;
  /** 对存活会话投 set_model；返回是否真的切成功。 */
  switchModel: (sessionId: string, candidate: ModelCandidate) => Promise<boolean>;
  /** 换完后让成员继续干（投一条续跑提示）。 */
  resume: (sessionId: string, candidate: ModelCandidate) => Promise<void>;
  /** 把该会话的 outage 记录摘掉，防 scheduler 双驱动。 */
  detachOutage: (sessionId: string) => void;
  /** 无候选/触顶时提醒 lead（排除该成员会话自身；解不出 lead 就不投）。 */
  nudgeLead: (teamName: string, memberSessionId: string, message: string) => Promise<void>;
  /** 提醒去重：同一成员会话在**同一段故障**里只提醒一次（换成功一次即清）。 */
  leadNudged: (sessionId: string) => boolean;
  markLeadNudged: (sessionId: string) => void;
  /** 换成功一次就清掉「已试过/已提醒」记录，下一段故障重新算。 */
  clearSessionState: (sessionId: string) => void;
  log: (message: string) => void;
}

export interface TeamModelFallbackResult {
  switched: boolean;
  decision: ModelFallbackDecision;
  to?: ModelCandidate;
}

/**
 * 成员一次失败后调用。**绝不抛**：换模型失败不能影响成员本身的错误上报。
 * 返回 `switched: false` 时调用方应照常走 outage 挂起流程。
 */
export async function maybeSwitchTeamMemberModel(
  deps: TeamModelFallbackRuntimeDeps,
  input: { sessionId: string; errorText: string },
): Promise<TeamModelFallbackResult> {
  const skip = (decision: ModelFallbackDecision): TeamModelFallbackResult => ({ switched: false, decision });
  try {
    // 先按错误文本便宜地判一次：绝大多数失败（代码错误、用户停止）在这里就出去了，
    // 不读团队、不查凭据。
    const classification = classifyOutageError(input.errorText ?? "");
    if (!classification.suspend) return skip({ action: "skip", reason: "not-provider-failure" });

    const teamName = await deps.findTeam(input.sessionId);
    if (!teamName) return skip({ action: "skip", reason: "not-provider-failure" });

    const roster = await deps.readRoster(teamName);
    if (!roster) return skip({ action: "skip", reason: "not-provider-failure" });

    // 候选只取模型串，不去重（纯决策里会去重）。
    const candidates: ModelCandidate[] = roster
      .map((member) => ({ providerId: member.runtime?.providerId ?? "", modelId: member.runtime?.modelId ?? "" }))
      .filter((candidate) => candidate.providerId && candidate.modelId);

    const current = await deps.currentModel(input.sessionId);

    // **防横跳（第二道闸）**：刚刚以 provider 故障失败的模型进「已试」清单。没有它，
    // 「A 挂 → 换 B → B 也挂」时决策会把 A 当候选又切回去（current=B 只排 B），
    // 在几个坏模型之间来回横跳、每次烧一整轮上下文。
    markModelFallbackFailed(input.sessionId, current);

    // 凭据查询是异步的；先把在名册里出现过的候选并行问一遍，再交给同步决策。
    const authCache = new Map<string, boolean>();
    await Promise.all(candidates.map(async (candidate) => {
      const key = `${candidate.providerId}\u0000${candidate.modelId}`;
      if (authCache.has(key)) return;
      try {
        authCache.set(key, await deps.hasAuth(candidate));
      } catch {
        authCache.set(key, false);
      }
    }));

    const decision = decideModelFallback({
      sessionId: input.sessionId,
      errorText: input.errorText,
      current,
      roster: candidates,
      hasAuth: (candidate) => authCache.get(`${candidate.providerId}\u0000${candidate.modelId}`) === true,
      attemptsSoFar: modelFallbackAttempts(input.sessionId),
      maxAttempts: MAX_MODEL_FALLBACKS_PER_MEMBER,
      // 本次故障期间换上去又失败过的模型不再重选（次数上限之外的第二道防横跳闸）。
      triedSoFar: modelFallbackTried(input.sessionId),
    }, (text) => classifyOutageError(text));

    if (decision.action !== "switch") {
      // 次数用尽 / 没有可用候选：**不能硬换**。交回既有提醒链让 lead 知道（每个
      // 成员会话每段故障只提醒一次），成员自身的失败上报照常走。
      await nudgeLeadOnce(deps, {
        teamName,
        memberSessionId: input.sessionId,
        memberName: memberNameOf(roster, input.sessionId),
        reason: decision.action === "exhausted" ? "次数上限" : "没有可用候选",
        attempts: modelFallbackAttempts(input.sessionId),
      });
      return skip(decision);
    }

    const switched = await deps.switchModel(input.sessionId, decision.candidate);
    if (!switched) {
      deps.log(`团队模型切换投递失败（${decision.candidate.providerId}/${decision.candidate.modelId}），保持原状`);
      return skip({ action: "no-candidate", considered: candidates.length });
    }

    // 换成功才计一次「切换」。失败过的那几个模型交给 markModelFallbackFailed（由上层
    // 在自己的 settle 钩子里登记），这里不猜。
    recordModelFallbackAttempt(input.sessionId);
    deps.clearSessionState(input.sessionId);
    // **先摘 outage 再续跑**：续跑会立刻触发新 turn，若 scheduler 的 tick 恰好落在
    // 这中间，就会给同一个会话再塞一条续跑提示。
    try {
      deps.detachOutage(input.sessionId);
    } catch (error) {
      deps.log(`摘除 outage 记录失败：${error instanceof Error ? error.message : error}`);
    }
    await deps.resume(input.sessionId, decision.candidate);
    deps.log(
      `成员 ${input.sessionId} 的模型不可用，已切到 ${decision.candidate.providerId}/${decision.candidate.modelId} 并续跑`,
    );
    return { switched: true, decision, to: decision.candidate };
  } catch (error) {
    deps.log(`自动换模型失败（不影响成员自身错误上报）：${error instanceof Error ? error.message : error}`);
    return skip({ action: "skip", reason: "not-provider-failure" });
  }
}

function memberNameOf(
  roster: Array<{ name?: string; sessionId?: string; runtime?: { providerId?: string; modelId?: string } }>,
  sessionId: string,
): string | null {
  for (const member of roster) {
    if (member?.sessionId === sessionId && typeof member.name === "string" && member.name) return member.name;
  }
  return null;
}

/** 「无候选/触顶」提醒：每成员会话每段故障一次；解不出 lead 或投递失败都只记日志。 */
async function nudgeLeadOnce(
  deps: TeamModelFallbackRuntimeDeps,
  input: { teamName: string; memberSessionId: string; memberName: string | null; reason: string; attempts: number },
): Promise<void> {
  try {
    if (deps.leadNudged(input.memberSessionId)) return;
    const message = buildLeadNudgePrompt({
      teamName: input.teamName,
      memberSessionId: input.memberSessionId,
      memberName: input.memberName,
      reason: input.reason,
      attempts: input.attempts,
    });
    await deps.nudgeLead(input.teamName, input.memberSessionId, message);
    deps.markLeadNudged(input.memberSessionId);
  } catch (error) {
    deps.log(`提醒 lead 失败：${error instanceof Error ? error.message : error}`);
  }
}

// ───────────────────────────── 「已提醒」标记（进程内） ─────────────────────────────

declare global {
  var __piTeamModelFallbackNudged: Map<string, number> | undefined;
}

function nudgedSessions(): Map<string, number> {
  if (!globalThis.__piTeamModelFallbackNudged) globalThis.__piTeamModelFallbackNudged = new Map();
  return globalThis.__piTeamModelFallbackNudged;
}

/** 生产默认实现：所有重模块惰性 import，避免把团队/模型栈拖进启动路径。 */
export async function buildDefaultTeamModelFallbackDeps(): Promise<TeamModelFallbackRuntimeDeps> {
  const { findTeamBySession } = await import("./agent-teams-swimlane-store");
  const { teamDirFor } = await import("./agent-teams-swimlane-store");
  const { readMergedRoster } = await import("./agent-teams-roster");
  const { getRpcSession } = await import("./rpc-manager");

  return {
    findTeam: (sessionId) => findTeamBySession(sessionId),
    readRoster: async (teamName) => {
      try {
        return await readMergedRoster(teamDirFor(teamName));
      } catch {
        return null;
      }
    },
    currentModel: async (sessionId) => {
      // 从会话的 model_change / 最后一条 assistant 消息里取，读不到就不换（拿不准就不动）。
      const { resolveSessionPath } = await import("./session-reader");
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const path = await resolveSessionPath(sessionId);
      if (!path) return null;
      try {
        const manager = SessionManager.open(path);
        const entries = manager.getEntries();
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const entry = entries[i] as { type?: string; provider?: string; modelId?: string; message?: { provider?: string; model?: string } };
          if (entry?.type === "model_change" && entry.provider && entry.modelId) {
            return { providerId: entry.provider, modelId: entry.modelId };
          }
          if (entry?.type === "message" && entry.message?.provider && entry.message?.model) {
            return { providerId: entry.message.provider, modelId: entry.message.model };
          }
        }
      } catch {
        // 读不出来就不换。
      }
      return null;
    },
    hasAuth: async (candidate) => {
      try {
        const modelRuntime = await getModelRuntimeWithExtensions();
        // 模型必须真实存在：否则 set_model 抛 "Model not found"。
        const model = modelRuntime.getModel(candidate.providerId, candidate.modelId);
        if (!model) return false;
        // 与 SDK `AgentSession.setModel` 的前置校验同一判据：`checkAuth(provider)`
        // （agent-session.js:2111）。用 getAuth 会放过「只有 env 变量、没有可用 key」
        // 的情形，set_model 随后抛 "No API key"，白耗一次上限。
        const auth = await modelRuntime.checkAuth(candidate.providerId);
        return Boolean(auth);
      } catch {
        return false;
      }
    },
    switchModel: async (sessionId, candidate) => {
      const wrapper = getRpcSession(sessionId);
      if (!wrapper?.isAlive()) return false;
      try {
        await wrapper.send({ type: "set_model", provider: candidate.providerId, modelId: candidate.modelId });
        return true;
      } catch {
        return false;
      }
    },
    resume: async (sessionId, candidate) => {
      const wrapper = getRpcSession(sessionId);
      if (!wrapper?.isAlive()) return;
      // 续跑提示里写明换到了哪：模型自己知道上下文没变，别因「我换了」而重头检查一遍。
      const message = `[${candidate.providerId}/${candidate.modelId}] ${MODEL_FALLBACK_RESUME_PROMPT}`;
      await wrapper.send({ type: "prompt", message, streamingBehavior: "followUp" });
    },
    detachOutage: (sessionId) => {
      // 删掉记录：outage 只认磁盘记录，没有记录就不会再驱动这个会话。
      // （scope 字段无法"标记跳过"而不改状态机，删除是最直接的断开方式。）
      cancelOutageRecord(sessionId);
    },
    nudgeLead: async (teamName, memberSessionId, message) => {
      const [{ resolveTeamLeadSession }, { defaultDeliver }] = await Promise.all([
        import("./agent-teams-swimlane-store"),
        import("./agent-teams-unattended-runtime"),
      ]);
      const lead = await resolveTeamLeadSession(teamName).catch(() => null);
      // 解不出 lead、或该会话自己就是 lead：不投，避免给 lead 塞一轮自我对话。
      if (!lead || lead === memberSessionId) return;
      const result = await defaultDeliver(lead, message);
      if (!result.ok) throw new Error(result.reason ?? "delivery failed");
    },
    leadNudged: (sessionId) => nudgedSessions().has(sessionId),
    markLeadNudged: (sessionId) => { nudgedSessions().set(sessionId, Date.now()); },
    clearSessionState: (sessionId) => { nudgedSessions().delete(sessionId); },
    log: (message) => console.log(`[teams-model-fallback] ${message}`),
  };
}