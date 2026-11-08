/**
 * 团队成员加/删编排（#54，服务端可测核心；deps 全注入，纯模块不 import pi-team）。
 *
 * 数据层事实（实现依据，勿凭印象改动）：
 * - pi-team 没有加/删成员工具；名册唯一权威 = config.json。
 * - 桌面加成员 = 复刻 pi-team team_create 的 spawn+adopt 顺序（teamTools.js:294-307）：
 *   名册写入走 mutateTeamConfigFile（per-team 队列 + config.json.lock 上游同款锁），
 *   锁内 async 完成「重名判定 + per-team 配额 + 追加」——重名判定必须在追加之前
 *   （lead 复审：不能先写再 409）；随后 host.start → lifecycle.adopt（漏 adopt 则
 *   配额/泳道/唤醒三者全错）。
 * - **aborted 在本 pi-team 不是不可复活 tombstone**（teamLifecycle.js:181「保留
 *   sessionFile 以便日后 ensureLive 复活」）；**ensureLive 是唯一 revive 编排**
 *   （parked/aborted 都走宿主桥 revive，并发按成员名合并，回 idle + arm TTL）；
 *   `#revive` 对无 sessionId 条目抛「没有可复活的会话」⇒ 捕获后改走新 start。
 *   ensureLive 内部已把 sessionId/status 更新进 lifecycle（#apply），无需外部再 adopt。
 * - release 吞掉 host.stop 异常（teamLifecycle.js:181-199）⇒ 「parked + generation
 *   前进」只证明记了账，不证明会话真停——删成员必须 probeRunning 真探，且
 *   **先 release+probe 全成功 ⇒ 再进临界区移名册**（先移再探会在长跑期间制造孤儿）。
 * - 全局配额口径对齐 pi-team countActiveWorkers（teamTools.js:34-50：数名册非 lead
 *   成员，坏目录跳过）；pi-team 侧 checkSpawnLimits 读盘但非原子——桌面 `.quota.lock`
 *   只串行自己的写者，残余如实，不宣称完全防护。
 */

import { enqueueTeamMutation, withTeamConfigLock } from "./agent-teams-swimlane-store";

/** 409 语义（上限/冲突/在跑）。 */
export class MemberConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberConflictError";
  }
}

/** 404 语义（团队/成员不存在）。 */
export class MemberNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberNotFoundError";
  }
}

export interface AddMemberInput {
  name: string;
  agentType?: string;
  prompt?: string;
  model?: string;
}

export type AddMemberStatus = "spawned" | "respawned" | "failed";

export interface AddMemberResult {
  name: string;
  agentId?: string;
  status: AddMemberStatus;
  sessionId?: string;
  warning?: string;
  reason?: string;
}

export interface RemoveMemberResult {
  name: string;
  status: "removed" | "failed";
  sessionId?: string;
  warning?: string;
  reason?: string;
}

export interface LifecyclePort {
  get(name: string): Promise<{ status?: string; sessionId?: string; sessionFile?: string; generation?: number } | undefined>;
  adopt(name: string, info: { sessionId?: string; sessionFile?: string }): Promise<unknown>;
  release(name: string, options: { tombstone: boolean }): Promise<{ status?: string; generation?: number; sessionId?: string }>;
  ensureLive(name: string): Promise<{ sessionId?: string; sessionFile?: string }>;
}

export interface MembersDeps {
  teamDir: string;
  rawTeamName: string;
  /** per-team 上限（route 从 readTeamQuotaLimits 装配；临界区内复核用）。 */
  quotaPerTeamLimit: number;
  now(): number;
  uuid(): string;
  /** swimlane-store 导出的原语：per-team 队列 + config.json.lock + 锁内重读。 */
  mutateConfig<T>(mutation: {
    unreadableError: string;
    mutate: (config: Record<string, unknown>) =>
      | { value: T; next: Record<string, unknown> | null }
      | Promise<{ value: T; next: Record<string, unknown> | null }>;
  }): Promise<T>;
  /** 名册条目的 JSON 快照（删除冲突检测）。 */
  snapshotEntry(entry: unknown): string;
  /**
   * 从名册算 lead 名集合（可靠链，与 store resolveLeadNames 同口径：leadSessionId→
   * member.sessionId 命中优先、名字常量回退、首位兜底）。per-team 配额计数用它排除
   * lead——改名 lead 不再虚占（lead 退回②）。必注入。
   */
  leadNamesOf(members: readonly Record<string, unknown>[]): Set<string>;
  lifecycle(): LifecyclePort;
  /** 进程内是否已有该团队 lifecycle 实例（remove 决定是否需要 release）。 */
  hasLifecycleInstance(): boolean;
  /** TeamHost.start（宿主内部 requireContext；lead 会话从未启动会抛）。 */
  start(request: {
    name: string;
    profile: string;
    task: string;
    description: string;
    teamName: string;
    agentName: string;
    model?: string;
    runInBackground: boolean;
  }): Promise<{ sessionId: string; sessionFile?: string }>;
  stopSession(sessionId: string): Promise<void>;
  probeRunning(sessionId: string): Promise<boolean>;
  /** 复活/新派后递任务（bus.send，from:"human" 由 route 装配）。 */
  deliverText(to: string, body: string, summary: string): Promise<void>;
}

/** 名册追加条目形态（口径照 pi-team teamTools.js:263-268）。 */
function buildRosterEntry(input: AddMemberInput, agentId: string, now: number): Record<string, unknown> {
  return {
    agentId,
    name: input.name,
    ...(input.agentType ? { agentType: input.agentType } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.model ? { model: input.model } : {}),
    joinedAt: now,
    cwd: process.cwd(),
    subscriptions: [],
  };
}

function isMemberObject(item: unknown): item is Record<string, unknown> {
  return !!item && typeof item === "object" && !Array.isArray(item);
}

function memberName(item: Record<string, unknown>): string {
  return typeof item.name === "string" ? item.name : "";
}

/**
 * start/ensureLive 失败后恢复名册：原条目不存在 ⇒ 摘除刚加的；存在 ⇒ 恢复原内容；
 * 被并发改写 ⇒ 不覆盖、如实冲突。
 *
 * ⚠️ 必须用 `withTeamConfigLock`（裸文件锁），**不能用 deps.mutateConfig**——本函数
 * 只在 `team:<dir>` 队列 task 内部被调用，mutateTeamConfigFile 会把回滚任务再排到
 * 同 key 队列尾：外层 task 在等回滚、回滚在等外层让队列 ⇒ 死锁（lead 实测 6 cancelled
 * 的根因）。同 key 队列嵌套禁止；回滚在持锁的 task 内直接做文件锁临界区是安全的
 * （文件锁本身可重入——同进程同 promise 链内的锁顺序固定，不构成环）。
 */
async function restoreRosterEntry(
  deps: MembersDeps,
  name: string,
  originalJson: string | null,
  originalEntry: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  try {
    await withTeamConfigLock(
      deps.teamDir,
      (config) => {
        const members = config.members;
        if (!Array.isArray(members)) return { value: undefined, next: null };
        const index = members.findIndex((item) => isMemberObject(item) && memberName(item) === name);
        if (index < 0) {
          if (originalEntry) members.push(originalEntry);
          return { value: undefined, next: originalEntry ? config : null };
        }
        // 名字还在：若是刚加的条目（无原快照）⇒ 摘除；否则是被并发改写的原条目 ⇒ 不覆盖。
        if (!originalJson) {
          members.splice(index, 1);
          return { value: undefined, next: config };
        }
        return { value: undefined, next: null };
      },
      "config.json 在回滚成员名册时不可读",
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 加成员（对外入口）：整体进本团队 `team:<dir>` 共享队列（lead 裁定：同团队所有
 * 编排串行；内部 config 临界区走 withTeamConfigLock——同 key 队列嵌套会死锁，严禁
 * 在队列 task 内再走 mutateTeamConfigFile）。全局配额预检由 route 在 `.quota.lock`
 * 内包整个循环完成。
 */
export function addTeamMember(deps: MembersDeps, input: AddMemberInput): Promise<AddMemberResult> {
  return enqueueTeamMutation(`team:${deps.teamDir}`, () => addTeamMemberCore(deps, input));
}

async function addTeamMemberCore(deps: MembersDeps, input: AddMemberInput): Promise<AddMemberResult> {
  const name = input.name;
  let originalJson: string | null = null;
  let originalEntry: Record<string, unknown> | undefined;
  /** 本函数内成功启动的会话（补偿回收用；函数局部，绝不模块级——并发请求互踩）。 */
  let startedSessionId: string | undefined;
  let usedStart = false;

  const staged = await withTeamConfigLock<{ mode: "spawn" | "respawn"; agentId?: string; sessionId?: string; status?: string }>(
    deps.teamDir,
    async (config) => {
      const members = config.members;
      if (!Array.isArray(members)) throw new MemberConflictError("config.json 的 members 不是数组");
      const sameNameIndex = members.findIndex((item) => isMemberObject(item) && memberName(item) === name);
      const sameName = sameNameIndex >= 0 ? members[sameNameIndex] as Record<string, unknown> : undefined;
      if (sameName) {
        originalJson = deps.snapshotEntry(sameName);
        originalEntry = sameName;
        const entry = await deps.lifecycle().get(name);
        const status = entry?.status;
        if (status === "idle" || status === "running" || status === "queued") {
          throw new MemberConflictError(
            `成员「${name}」已存在且活跃（${status}）。如需换任务请用工单派活，或先停止该成员。`,
          );
        }
        // parked/aborted/未登记 ⇒ 补派分支：名册条目已存在（不重复追加）。
        return { value: { mode: "respawn", sessionId: entry?.sessionId, status: status ?? "unregistered" }, next: null };
      }
      // per-team 配额在临界区内复核（并发 add 各自预检 11/12 都会通过 ⇒ 必须重读后再判）。
      // lead 排除走可靠链（lead 退回②）：不再只按固定名字——改名 lead 不虚占配额。
      const leadNames = deps.leadNamesOf(members.filter(isMemberObject));
      const workers = members.filter((item) => isMemberObject(item) && !leadNames.has(memberName(item))).length;
      if (workers >= deps.quotaPerTeamLimit) {
        throw new MemberConflictError(
          `LIMIT_EXCEEDED: per-team worker limit reached (${deps.quotaPerTeamLimit}). ` +
          `团队「${deps.rawTeamName}」名册已有 ${workers} 名成员，达到每团队上限 ${deps.quotaPerTeamLimit}。` +
          `请拆成多个团队，或减少成员数量。`,
        );
      }
      const agentId = `${name}-${deps.now()}-${deps.uuid().slice(0, 8)}`;
      const entry = buildRosterEntry(input, agentId, deps.now());
      members.push(entry);
      return { value: { mode: "spawn", agentId }, next: config };
      },
      "config.json 在添加成员时不可读",
  );

  try {
    if (staged.mode === "respawn") {
      // 复活分支：ensureLive 是唯一 revive 编排；无 sessionId 抛错 ⇒ 改走新 start。
      let sessionId: string | undefined;
      try {
        const live = await deps.lifecycle().ensureLive(name);
        sessionId = live.sessionId;
      } catch {
        const started = await deps.start({
          name,
          profile: input.agentType || "general-purpose",
          task: input.prompt || "继续你之前的任务，并把结果回报给团队。",
          description: `${deps.rawTeamName}/${name}`,
          teamName: deps.rawTeamName,
          agentName: name,
          ...(input.model ? { model: input.model } : {}),
          runInBackground: true,
        });
        sessionId = started.sessionId;
        startedSessionId = started.sessionId;
        usedStart = true;
        await deps.lifecycle().adopt(name, { sessionId: started.sessionId, sessionFile: started.sessionFile });
      }
      // deliverText 是「立即唤醒」增强：ensureLive 已把成员回 idle、任务正文随后经
      // team_ticket/邮箱可达（bus #flush 吞错 teamBus.js:189-195 同口径）——失败不整单
      // failed、不回收已复活的会话（那会留下未接管的 revive 残骸），如实带 warning。
      let deliveryWarning: string | undefined;
      try {
        await deps.deliverText(
          name,
          `[Pi Web 人工调度] 你被重新启用。任务：${input.prompt || "继续你之前的任务，并把结果回报给团队。"}`,
          `重新启用成员 ${name}`,
        );
      } catch (deliverError) {
        deliveryWarning = `成员已复活，但任务投递失败：${deliverError instanceof Error ? deliverError.message : String(deliverError)}；请用 team_ticket/邮箱补投。`;
      }
      const keptAgentId = typeof originalEntry?.agentId === "string" ? originalEntry.agentId : name;
      return { name, agentId: keptAgentId, status: "respawned", sessionId, ...(deliveryWarning ? { warning: deliveryWarning } : {}) };
    }

    // 新成员：host.start → adopt（pi-team teamTools.js:294-307 同序）。
    const started = await deps.start({
      name,
      profile: input.agentType || "general-purpose",
      task: input.prompt || "查看团队工单与邮箱，向团队 lead 报到并等待任务。",
      description: `${deps.rawTeamName}/${name}`,
      teamName: deps.rawTeamName,
      agentName: name,
      ...(input.model ? { model: input.model } : {}),
      runInBackground: true,
    });
    startedSessionId = started.sessionId;
    await deps.lifecycle().adopt(name, { sessionId: started.sessionId, sessionFile: started.sessionFile });
    let spawnWarning: string | undefined;
    if (input.prompt) {
      try {
        await deps.deliverText(name, `[Pi Web 人工调度] ${input.prompt}`, `任务：成员 ${name}`);
      } catch (deliverError) {
        spawnWarning = `成员已派发，但任务投递失败：${deliverError instanceof Error ? deliverError.message : String(deliverError)}；请用 team_ticket/邮箱补投。`;
      }
    }
    return { name, agentId: staged.agentId, status: "spawned", sessionId: started.sessionId, ...(spawnWarning ? { warning: spawnWarning } : {}) };
  } catch (error) {
    // 补偿：回收刚起的会话 + 恢复临界区前名册（respawn 场景名册是既有条目，不回滚名册）。
    const reason = error instanceof Error ? error.message : String(error);
    let warning: string | undefined;
    if (startedSessionId && (staged.mode === "spawn" || usedStart)) {
      try {
        await deps.stopSession(startedSessionId);
      } catch (stopError) {
        warning = `会话未能回收，请手动停止：${stopError instanceof Error ? stopError.message : String(stopError)}`;
      }
    }
    if (staged.mode === "spawn") {
      const restoreError = await restoreRosterEntry(deps, name, originalJson, originalEntry);
      if (restoreError) {
        warning = `${warning ? `${warning}；` : ""}名册恢复失败（${restoreError}），请人工核对 config.json`;
      }
    }
    return { name, status: "failed", reason, ...(warning ? { warning } : {}) };
  }
}

/**
 * POST add 的全局配额闸（route 与测试共用同一函数——lead 门禁：不能靠 route 外复刻
 * 流程声称已覆盖）。`.quota.lock` 锁内：
 * - 入口重读全局计数，limit 已满 ⇒ 拒任何新增（limit 0 = 全拒）；
 * - 每 input 前**锁内重读**（前序 spawn/失败恢复都反映在盘上名册里，重读即真实余量）；
 * - spawned=新占 1 个全局名额；respawned 复用既有会话不占；failed（补偿已回滚名册）不占；
 * - MemberConflictError ⇒ 整批返回 409 语义（conflict 携带原因）。
 *
 * `deps.addOne` 由 route 装配（addTeamMember 的 team 队列在 addTeamMember 内部）；
 * `deps.readTotal` 注入 readGlobalRosterWorkers（测试换假计数）。
 */
export interface GlobalQuotaGateDeps {
  globalLimit: number;
  readTotal(): Promise<number>;
  addOne(input: AddMemberInput): Promise<AddMemberResult>;
}

export interface GlobalQuotaGateResult {
  conflict: string | null;
  results: AddMemberResult[];
}

export async function runGlobalQuotaGate(deps: GlobalQuotaGateDeps, inputs: readonly AddMemberInput[]): Promise<GlobalQuotaGateResult> {
  let used = await deps.readTotal();
  if (used >= deps.globalLimit) {
    return {
      conflict: `LIMIT_EXCEEDED: global worker limit reached (${deps.globalLimit}). 当前全进程已有 ${used} 名成员，无余量再添加。请等待其他团队的成员收工，或先精简不再需要的团队。`,
      results: [],
    };
  }
  const results: AddMemberResult[] = [];
  for (const input of inputs) {
    // 每 input 前锁内重读（前序 spawned/failed 已落盘名册，重读即真实余量）。
    const freshTotal = await deps.readTotal();
    if (freshTotal >= deps.globalLimit) {
      return {
        conflict: `LIMIT_EXCEEDED: global worker limit reached (${deps.globalLimit}). 当前全进程已有 ${freshTotal} 名成员，无余量再添加「${input.name}」。请等待其他团队的成员收工，或先精简不再需要的团队。`,
        results,
      };
    }
    try {
      const result = await deps.addOne(input);
      results.push(result);
      if (result.status === "spawned") used += 1;
    } catch (error) {
      results.push({
        name: input.name,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof MemberConflictError) {
        return {
          conflict: error instanceof Error ? error.message : String(error),
          results,
        };
      }
    }
  }
  return { conflict: null, results };
}

/**
 * 删成员。顺序（v5 设计 §二，③）：先 release + 回执校验 → probe 真探 → **全成功后**
 * 才进临界区移名册（先移再探会在长跑期间制造孤儿）；移出时重读发现原值被并发改写
 * ⇒ 409 冲突不移除；停止成功而移除失败 ⇒ 如实报。running 成员禁止 remove。
 */
/** 删成员（对外入口）：整体进本团队 `team:<dir>` 共享队列（与 add/工单编排串行）。 */
export function removeTeamMember(deps: MembersDeps, name: string): Promise<RemoveMemberResult> {
  return enqueueTeamMutation(`team:${deps.teamDir}`, () => removeTeamMemberCore(deps, name));
}

async function removeTeamMemberCore(deps: MembersDeps, name: string): Promise<RemoveMemberResult> {
  // 预读：定位名册条目 + lifecycle 状态（config 锁临界区；只读）。
  const roster = await withTeamConfigLock<{ entry: Record<string, unknown> | null }>(
    deps.teamDir,
    (config) => {
      const members = config.members;
      if (!Array.isArray(members)) throw new MemberConflictError("config.json 的 members 不是数组");
      const entry = members.find((item) => isMemberObject(item) && memberName(item) === name);
      return { value: { entry: entry ?? null }, next: null };
    },
    "config.json 在移除成员时不可读",
  );
  if (!roster.entry) throw new MemberNotFoundError(`成员「${name}」不在团队名册中`);
  const originalJson = deps.snapshotEntry(roster.entry);

  const entry = await deps.lifecycle().get(name);
  if (entry?.status === "running") {
    throw new MemberConflictError(`成员「${name}」正在执行任务（running），不能直接移除。请先停止该成员或等它完成。`);
  }

  let sessionId = entry?.sessionId ?? (typeof roster.entry.sessionId === "string" ? roster.entry.sessionId : undefined);
  if (deps.hasLifecycleInstance()) {
    const released = await deps.lifecycle().release(name, { tombstone: false });
    // 回执校验：release 吞 stop 异常，「parked + generation 前进」只证明记了账。
    const advanced = typeof entry?.generation !== "number"
      || typeof released.generation !== "number"
      || released.generation > entry.generation;
    if (released.status !== "parked" || !advanced) {
      return {
        name,
        status: "failed",
        sessionId: released.sessionId ?? sessionId,
        reason: `停止回执异常（status=${released.status}${advanced ? "" : "，代数未前进"}），名册未移除`,
      };
    }
    sessionId = released.sessionId ?? sessionId;
  }

  // 真探：任一已知 sessionId 仍在跑 ⇒ 拒绝（release 吞异常，「parked」≠已停）。
  const knownSessionIds = [sessionId, typeof roster.entry.sessionId === "string" ? roster.entry.sessionId : undefined]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of knownSessionIds) {
    let running: boolean;
    try {
      running = await deps.probeRunning(candidate);
    } catch (error) {
      return {
        name,
        status: "failed",
        sessionId: candidate,
        reason: `无法确认会话是否已停（探测出错）：${error instanceof Error ? error.message : String(error)}；名册未移除`,
      };
    }
    if (running) {
      return {
        name,
        status: "failed",
        sessionId: candidate,
        reason: `release 回执已置 parked，但会话仍在运行（sessionId=${candidate}）；名册未移除`,
      };
    }
  }

  // release + probe 全成功 ⇒ 临界区移名册；移出时重读发现原值被并发改写 ⇒ 冲突不移除。
  try {
    await withTeamConfigLock(
      deps.teamDir,
      (config) => {
        const members = config.members;
        if (!Array.isArray(members)) throw new MemberConflictError("config.json 的 members 不是数组");
        const index = members.findIndex((item) => isMemberObject(item) && memberName(item) === name);
        if (index < 0) {
          throw new MemberConflictError(`成员「${name}」的名册条目已被并发移除，无需重复移除`);
        }
        if (deps.snapshotEntry(members[index]) !== originalJson) {
          throw new MemberConflictError(
            `成员「${name}」的名册条目在停止期间被并发修改，为不覆盖他人改动本次不移除；请刷新后重试。`,
          );
        }
        members.splice(index, 1);
        return { value: undefined, next: config };
      },
      "config.json 在移除成员时不可读",
    );
  } catch (error) {
    // 停止已成功、名册移除失败：如实报，不伪造会话仍在跑。
    return {
      name,
      status: "failed",
      sessionId,
      reason: `成员已停止，但名册移除失败：${error instanceof Error ? error.message : String(error)}；请重试移除`,
    };
  }

  return {
    name,
    status: "removed",
    sessionId,
    warning: `成员「${name}」名下未结束的工单派活将无人认领；如需保留请在移除前先改派。`,
  };
}
