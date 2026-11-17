/**
 * 团队成员模型不可用 → 自动换团队里的其他模型继续跑。
 *
 * ── 它解决什么 ─────────────────────────────────────────────────
 * 成员跑着跑着模型用不了了（上游 5xx、连接断、流中断、额度用尽），现状是：
 * outage 模块给**这个会话**建挂起记录、等上游恢复；团队这边只知道「这次 turn 失败了」，
 * 没人会想到「团队里别的成员模型还能用」。整队就卡在那一个坏模型上。
 *
 * 这层补的就是这一步：检测到 provider 故障 → 从团队名册里挑一个别的、有凭据的模型 →
 * 换过去（只换模型串）→ 让它继续干没干完的活。
 *
 * ── 与 outage 的分工（重要） ────────────────────────────────────
 * 换模型优先于挂起等待。一旦本层接手，**必须把该会话的 outage 记录标成 team 域**，
 * 否则 outage scheduler 还会按退避继续给它发续跑提示 —— 两套驱动同时往一个会话灌
 * 消息，重复烧 token、还可能互相打架。见 `lib/outage/scheduler.ts` 对 autofix 的同类处理。
 *
 * ── 三条硬约束 ─────────────────────────────────────────────────
 * 1. **只换模型串**：不搬别的成员的会话、任务、profile、cwd。工具集与 transcript 不变，
 *    所以换完还能接着干（`agent-session.js` 的 setModel 只换 provider/model）。
 * 2. **必须校验凭据**：没有 API key 的模型 `setModel` 会直接抛 "No API key"，
 *    换了等于把成员从「模型挂了」变成「成员彻底跑不了」。
 * 3. **次数上限**：同一个成员最多换 N 次。否则在几个坏模型之间反复横跳，
 *    每次都要付一轮重试成本。
 */

/** 同一个成员最多自动换几次模型。换满就交回团队（nudge lead）。 */
export const MAX_MODEL_FALLBACKS_PER_MEMBER = 2;

/** 续跑提示：明确「继续没做完的部分」，避免模型从头再来一遍。 */
export const MODEL_FALLBACK_RESUME_PROMPT =
  "Your previous model became unavailable, so this session was switched to another model. "
  + "Continue the task from where it stopped — do not restart it from the beginning and do not redo work that is already done. "
  + "If you had already written files or run commands, verify their current state before continuing.";

/** 团队名册里的一个模型候选。 */
export interface ModelCandidate {
  providerId: string;
  modelId: string;
}

export interface ModelFallbackDecisionInput {
  /** 团队成员会话 id。 */
  sessionId: string;
  /** 本次失败的原始错误文本（来自 assistant 消息的 errorMessage）。 */
  errorText: string;
  /** 该成员当前用的模型，会被排除。 */
  current: ModelCandidate | null;
  /** 团队名册里出现过的全部模型（未去重、未过滤）。 */
  roster: readonly ModelCandidate[];
  /**
   * 该模型当前是否有可用凭据。同步判定，便于单测注入；
   * 生产实现见 `buildTeamModelFallbackRuntime`。
   */
  hasAuth: (candidate: ModelCandidate) => boolean;
  /** 这个成员已经自动换过几次。 */
  attemptsSoFar: number;
  /** 次数上限，默认 `MAX_MODEL_FALLBACKS_PER_MEMBER`。 */
  maxAttempts?: number;
  /**
   * 本次故障期间**已经试过、但仍然失败**的模型（含最初那个）。次数上限之外的第二道
   * 防横跳闸：不回切到刚失败的模型（典型坏路径 A→B 再次失败后，别又切回 A）。
   */
  triedSoFar?: readonly ModelCandidate[];
}

export type ModelFallbackDecision =
  | { action: "switch"; candidate: ModelCandidate; reason: "provider-outage" }
  /** 不是 provider 故障：代码错误、用户停手之类，绝不能换模型。 */
  | { action: "skip"; reason: "not-provider-failure" }
  /** 次数用尽：交回团队，由 lead 决定重派/换人。 */
  | { action: "exhausted"; attempts: number }
  /** 没有可用候选（全被排除或全无凭据）。 */
  | { action: "no-candidate"; considered: number };

const keyOf = (candidate: ModelCandidate): string => `${candidate.providerId}\u0000${candidate.modelId}`;

/**
 * 跨 provider 优先：provider 级故障（连接/5xx/额度耗尽）时，同 provider 的另一个模型
 * 大概率同样不可用，换过去等于白烧一轮；组内保持名册顺序（配置顺序稳定，可预期）。
 */
function preferOtherProvider(
  candidates: readonly ModelCandidate[],
  current: ModelCandidate | null,
): ModelCandidate[] {
  if (!current) return [...candidates];
  const other = candidates.filter((candidate) => candidate.providerId !== current.providerId);
  const same = candidates.filter((candidate) => candidate.providerId === current.providerId);
  return [...other, ...same];
}

/** 去重（同名同 provider 只留一个），保持首次出现顺序。 */
export function dedupeModelCandidates(candidates: readonly ModelCandidate[]): ModelCandidate[] {
  const seen = new Set<string>();
  const out: ModelCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate?.providerId || !candidate?.modelId) continue;
    const key = keyOf(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerId: candidate.providerId, modelId: candidate.modelId });
  }
  return out;
}

/**
 * 纯决策：该不该换、换成谁。**不碰 IO**，所有外部事实由调用方注入。
 *
 * 判定顺序（顺序即安全边界）：
 * 1. 从 `errorText` 分类 —— 只有 `suspend: true`（outage / quota）才算 provider 故障。
 *    代码错误、参数错误、401、模型不存在都**不换**（换模型解决不了，还会掩盖真问题）。
 * 2. 次数上限。
 * 3. 候选 = 名册去重 − 当前模型 − 无凭据。
 */
export function decideModelFallback(
  input: ModelFallbackDecisionInput,
  classify: (errorText: string) => { kind: string; suspend: boolean },
): ModelFallbackDecision {
  const classification = classify(input.errorText ?? "");
  if (!classification.suspend) return { action: "skip", reason: "not-provider-failure" };

  const maxAttempts = input.maxAttempts ?? MAX_MODEL_FALLBACKS_PER_MEMBER;
  if (input.attemptsSoFar >= maxAttempts) {
    return { action: "exhausted", attempts: input.attemptsSoFar };
  }

  const excluded = new Set<string>();
  if (input.current) excluded.add(keyOf(input.current));
  for (const tried of input.triedSoFar ?? []) {
    if (tried?.providerId && tried?.modelId) excluded.add(keyOf(tried));
  }
  const candidates = preferOtherProvider(
    dedupeModelCandidates(input.roster)
      .filter((candidate) => !excluded.has(keyOf(candidate)))
      .filter((candidate) => {
        try {
          return input.hasAuth(candidate);
        } catch {
          // 凭据查询本身失败：当作没有，宁可少换也不要换到一个装不上的模型。
          return false;
        }
      }),
    input.current,
  );

  if (candidates.length === 0) {
    return { action: "no-candidate", considered: dedupeModelCandidates(input.roster).length };
  }
  return { action: "switch", candidate: candidates[0]!, reason: "provider-outage" };
}

/** 成员已换次数（进程内；重启后归零可接受——重启本身就是一次人工介入）。 */
declare global {
  var __piTeamModelFallbacks: Map<string, number> | undefined;
  var __piTeamModelFallbackTried: Map<string, Set<string>> | undefined;
}

function fallbackCounts(): Map<string, number> {
  if (!globalThis.__piTeamModelFallbacks) globalThis.__piTeamModelFallbacks = new Map();
  return globalThis.__piTeamModelFallbacks;
}

/** 本次故障期间被试过（换上去仍然失败）的模型键，按会话。 */
function fallbackTried(): Map<string, Set<string>> {
  if (!globalThis.__piTeamModelFallbackTried) globalThis.__piTeamModelFallbackTried = new Map();
  return globalThis.__piTeamModelFallbackTried;
}

export function modelFallbackAttempts(sessionId: string): number {
  return fallbackCounts().get(sessionId) ?? 0;
}

/** 本次故障期间已试过且失败的模型（供决策排除）。 */
export function modelFallbackTried(sessionId: string): ModelCandidate[] {
  const keys = fallbackTried().get(sessionId);
  if (!keys?.size) return [];
  return [...keys].map((key) => {
    const separator = key.indexOf("\u0000");
    return separator < 0
      ? { providerId: key, modelId: "" }
      : { providerId: key.slice(0, separator), modelId: key.slice(separator + 1) };
  });
}

/**
 * 记一次换模型。只记**成功投递的切换**（authoritative 的 attempts 账本）。
 */
export function recordModelFallbackAttempt(sessionId: string): number {
  const next = modelFallbackAttempts(sessionId) + 1;
  fallbackCounts().set(sessionId, next);
  return next;
}

/**
 * 记一个「刚刚在这个会话上失败过的模型」。第一道闸是次数上限，这是第二道：
 * 防止 A 挂了换到 B、B 也挂就切回 A 的来回横跳（每次横跳都要付一整轮上下文成本）。
 * 失败模型是按会话累积的：换成功不清（它确实失败过），成功的一轮也不清（模型自己
 * 恢复后仍不该被当作备用首选）；进程重启后归零。
 */
export function markModelFallbackFailed(sessionId: string, candidate: ModelCandidate | null | undefined): void {
  if (!candidate?.providerId || !candidate?.modelId) return;
  const tried = fallbackTried();
  let set = tried.get(sessionId);
  if (!set) {
    set = new Set();
    tried.set(sessionId, set);
  }
  set.add(keyOf(candidate));
}

/** 测试/诊断用：清掉计数（与已试清单）。 */
export function resetModelFallbackAttempts(sessionId?: string): void {
  if (sessionId === undefined) {
    fallbackCounts().clear();
    fallbackTried().clear();
    return;
  }
  fallbackCounts().delete(sessionId);
  fallbackTried().delete(sessionId);
}

export interface ModelFallbackLeadNudgeInput {
  teamName: string;
  memberSessionId: string;
  memberName?: string | null;
  reason: string;
  attempts: number;
}

/** 无候选/触顶时发给 lead 的提醒（走既有 defaultDeliver 投递链，不新增通知通道）。 */
export function buildLeadNudgePrompt(input: ModelFallbackLeadNudgeInput): string {
  const member = input.memberName ? `成员「${input.memberName}」` : "一名团队成员";
  return [
    "这是系统自动发出的「模型兜底提醒」，不是你本人（用户）发的消息。",
    `团队「${input.teamName}」的${member}（会话 ${input.memberSessionId}）执行时模型服务不可用；系统已自动换模型 ${input.attempts}/${MAX_MODEL_FALLBACKS_PER_MEMBER} 次，无法继续自动切换：${input.reason}。`,
    "请你自己处理，不要再等用户：",
    "1. 若团队里还有其它可用模型，用 team_ticket 把这部分工作重新派给一个能跑的成员（或换模型后再派给本人）。",
    "2. 若团队里本就没有其它可用模型（缺凭据/模型不存在），不要硬试——如实说明需要用户补配置。",
    "3. 完成后用一句话汇报你做了什么。",
  ].join("\n");
}