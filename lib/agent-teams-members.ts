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

import {
  enqueueTeamMutation,
  releaseQuotaSlot,
  tryReserveTeamWorkerSlot,
  withTeamConfigLock,
} from "./agent-teams-swimlane-store";
import { prunePlanRosterMember } from "./agent-teams-plan-write";

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

/**
 * ── 批量派成员/删成员 body 的解析（route 只做 HTTP，判定在这里，便于单测）──────
 *
 * 上限口径（为什么是 64）：
 * - 旧值 8（删 12）是「一次点一个」年代的防呆，与配额完全脱节：每团队上限已抬到
 *   16～24、全局 64，一次请求填满一个团队就必然超 8 → 直接 400，「多派成员」在
 *   HTTP 层就被拦住。现在批上限 = 一个满编团队（64 ≥ 全局上限），配额才是真闸；
 * - 这里只防超大 body（一次几千条会把宿主 spawn 队列打爆、请求体也过大），
 *   不是并发闸——并发由 runGlobalQuotaGate 的原子名额控制。
 */
export const MAX_BATCH_ADD_MEMBERS = 64;
export const MAX_BATCH_REMOVE_MEMBERS = 64;
/** prompt 正文上限（超长截断而不是拒单：派活正文长一点不该让整个请求失败）。 */
export const MAX_MEMBER_PROMPT_LENGTH = 2000;

/** 成员名合法字符（与 pi-team 名册/工单键同口径）。 */
export const MEMBER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type BatchParse<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * 解析 `action:"add"` 的 members 数组：名非法 ⇒ 整单 400（宁可整单拒，也不静默跳过——
 * 静默跳过会让用户以为成员派出去了）；同名（大小写不敏感）去重保序；超批上限 ⇒ 400
 * 并给出当前上限。
 */
export function parseAddMembersBatch(raw: unknown): BatchParse<AddMemberInput[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "members 必须是非空数组" };
  }
  if (raw.length > MAX_BATCH_ADD_MEMBERS) {
    return {
      ok: false,
      error: `members 一次最多 ${MAX_BATCH_ADD_MEMBERS} 个（收到 ${raw.length} 个）：请拆成多批，批内会被并发派发`,
    };
  }
  const seen = new Set<string>();
  const inputs: AddMemberInput[] = [];
  for (const item of raw) {
    const record = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
    const name = typeof record?.name === "string" ? record.name : "";
    if (!MEMBER_NAME_PATTERN.test(name)) {
      return { ok: false, error: `成员名不合法（限字母数字与 ._-，1..64 字符）：${JSON.stringify(name)}` };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push({
      name,
      ...(typeof record?.agentType === "string" && record.agentType ? { agentType: record.agentType } : {}),
      ...(typeof record?.prompt === "string" && record.prompt
        ? { prompt: record.prompt.slice(0, MAX_MEMBER_PROMPT_LENGTH) }
        : {}),
      ...(typeof record?.model === "string" && record.model ? { model: record.model } : {}),
    });
  }
  return { ok: true, value: inputs };
}

/** 解析 `action:"remove"` 的 names 数组（去重保序；任何非法名 ⇒ 整单 400）。 */
export function parseRemoveMemberNames(raw: unknown): BatchParse<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "names 必须是非空数组" };
  }
  if (raw.length > MAX_BATCH_REMOVE_MEMBERS) {
    return { ok: false, error: `names 一次最多 ${MAX_BATCH_REMOVE_MEMBERS} 个（收到 ${raw.length} 个）` };
  }
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !MEMBER_NAME_PATTERN.test(item)) {
      return { ok: false, error: `成员名不合法：${JSON.stringify(item)}` };
    }
    if (!names.includes(item)) names.push(item);
  }
  return { ok: true, value: names };
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
    // 不写 process.cwd()：打包版里那是 resources/server（脏数据），而团队真正在哪个项目
    // 下跑由宿主 spawn 时的 parentContext 决定，没人读这个字段（见 pi-team-host.ts）。
    // 与 agent-teams-swimlane-store 追加条目时的口径一致：不知道就写 ""。
    cwd: "",
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
 * LIMIT_EXCEEDED 文案口径：前缀 + `(上限)` 保持英文原文（前端/日志按它分支），
 * 后面接**中文可执行出路**——旧文案只说「等别人收工或精简团队」，用户拿不到下一步动作。
 * 每条出路都必须是**现在就能做的事**，并且带上当前数字（已用/上限）。
 */
function perTeamLimitMessage(teamName: string, used: number, limit: number): string {
  const team = encodeURIComponent(teamName);
  return `LIMIT_EXCEEDED: per-team worker limit reached (${limit}). `
    + `团队「${teamName}」已有 ${used} 名 worker（lead 不计入），每团队上限 ${limit}，再加会超。`
    + `出路：① 调高上限——设置项 teamQuota.perTeamLimit（PUT /api/teams/quota { "perTeamLimit": ${limit + 8} }）`
    + `或环境变量 PI_TEAM_MAX_MEMBERS，改完立即生效、不必重启；`
    + `② 开第二个团队分担，各自一份配额（跨团队派发不互抢）；`
    + `③ 腾名额——移除跑完/parked 的成员：POST /api/teams/${team}/members {"action":"remove","names":["<成员名>"]}；`
    + `④ 同一成员连续接手多件事用工单排队（POST /api/teams/${team}/assignments），不必一人一个新成员。`;
}

/** 全局上限文案（同样带数字 + 可执行出路）。 */
function globalLimitMessage(input: {
  limit: number;
  used: number;
  inflight: number;
  pendingName?: string;
  limitHint?: string;
}): string {
  const total = input.used + input.inflight;
  return `LIMIT_EXCEEDED: global worker limit reached (${input.limit}). `
    + `全进程已有 ${input.used} 名成员${input.inflight > 0 ? `，另有 ${input.inflight} 名正在派发中（合计 ${total}）` : ""}，`
    + `全局上限 ${input.limit}${input.pendingName ? `，无法再派「${input.pendingName}」` : ""}。`
    + `出路：① 只重派剩下没成功的成员（本批 status=spawned 的别重发，重发同名会 409），等某个成员收工即有余额；`
    + `② 调高全局上限——设置项 teamQuota.globalLimit（PUT /api/teams/quota { "globalLimit": ${input.limit * 2} }）`
    + `或环境变量 PI_TEAM_MAX_GLOBAL_WORKERS / PI_TEAM_MAX_WORKERS，改完立即生效；`
    + `③ 腾名额——删掉跑完的团队或 parked 成员（POST /api/teams/<team>/members {"action":"remove",...}）；`
    + `④ 把多件事压进工单队列（assignments）而不是多开成员。`
    + (input.limitHint ? `（本次上限来自 ${input.limitHint}）` : "");
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
 * 加成员（对外入口）。
 *
 * 队列键 **按成员名分槽**（`team:<dir>#member:<name>`），不再是整团队一把锁：
 * 旧口径「同团队所有编排串行」让同一团队的两名成员只能一个接一个 spawn（每个秒级），
 * 多派几名就排长队——那是「派成员串行」的另一半瓶颈。现在：
 * - 不同成员 ⇒ 不同队列槽 ⇒ 同时 spawn（配合 runGlobalQuotaGate 的并发名额，批内真并行）；
 * - 同名 add/remove ⇒ 同一槽 ⇒ 仍然串行，保住「不会为同一个名字起两个会话、不会
 *   ensureLive 撞上还没 adopt 完的 spawn」这条硬约束（并发同名会让第一个会话变孤儿）。
 *
 * 跨成员的共享状态只有 config.json，而它由 withTeamConfigLock（上游同款文件锁）兜底：
 * 必须先拿锁再判重名/追加，锁内重读的是磁盘最新内容。
 * ⚠️ 内部 config 临界区必须走 withTeamConfigLock，**不能**走 mutateTeamConfigFile
 * （同 key 队列嵌套会死锁，见 restoreRosterEntry 注释）。
 * 全局配额判定在 runGlobalQuotaGate 的 `.quota.lock` 临界区内完成。
 */
export function addTeamMember(deps: MembersDeps, input: AddMemberInput): Promise<AddMemberResult> {
  return enqueueTeamMutation(memberQueueKey(deps.teamDir, input.name), () => addTeamMemberCore(deps, input));
}

/** 成员级队列槽键（同团队不同成员可并行；同名 add/remove 仍串行）。 */
function memberQueueKey(teamDir: string, name: string): string {
  return `team:${teamDir}#member:${name.toLowerCase()}`;
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
      // `quotaPerTeamLimit <= 0` = 不限（操作者明确要求不设上限）。显式判 `> 0`：
      // 少了它，0 会让每次 add 都撞这条闸。
      if (deps.quotaPerTeamLimit > 0 && workers >= deps.quotaPerTeamLimit) {
        throw new MemberConflictError(perTeamLimitMessage(deps.rawTeamName, workers, deps.quotaPerTeamLimit));
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
 * 流程声称已覆盖）。
 *
 * 旧实现把整批派发塞进一个 `.quota.lock` 临界区里，于是**全进程任何时刻只起一个成员**
 * （spawn 是秒级），多团队/多成员一起派就排队——这是「派成员串行」的真瓶颈。现在：
 *
 * 1. **名额先原子占**：每个成员开派前调 `tryReserveTeamWorkerSlot`，在 `.quota.lock`
 *    内「读盘名册 + 看在途预留」判余量；够就记一笔预留再出锁。并发请求因此看到
 *    `已用 = 盘上 + 在途`，不会出现「双双预检都通过 ⇒ 超卖」；也不会把别的请求
 *    正在派的成员算成自己的余量。
 * 2. **起进程在锁外并发**：出锁后按 `concurrency`（默认 4，env
 *    `PI_TEAM_MAX_SPAWN_CONCURRENCY`）并行 spawn。锁只覆盖毫秒级判定额。
 * 3. **失败隔离**：单个成员失败（重名 409 / 该团队已满 / 宿主拒绝）只记一条 failed，
 *    **不再整批中止**——其余成员照派。只有全局名额耗尽才停（剩余 input 不派，
 *    conflict 如实带数字与出路）。
 * 4. **预留必释放**：`addOne` 一结束就 release——spawned 由盘上名册接手计数，
 *    failed 的补偿已回滚名册，respawned 本来不占；漏释放会把名额永久吃掉。
 *
 * `deps.addOne` 由 route 装配（addTeamMember 的**成员级**队列槽在 addTeamMember 内部，
 * 不同成员互不阻塞）；`deps.readTotal` 注入 readGlobalRosterWorkers（测试换假计数）。
 */
export interface GlobalQuotaGateDeps {
  globalLimit: number;
  readTotal(): Promise<number>;
  addOne(input: AddMemberInput): Promise<AddMemberResult>;
  /** 原子临界区注入（测试用假锁）；默认 store 的 withQuotaLock（真实 `.quota.lock`）。 */
  withLock?: <T>(task: () => Promise<T>) => Promise<T>;
  /** 同时在起的成员数上限（默认 DEFAULT_SPAWN_CONCURRENCY）。 */
  concurrency?: number;
  /** 上限来源描述（env 名 / 设置项），只用于文案。 */
  limitHint?: string;
}

export interface GlobalQuotaGateResult {
  conflict: string | null;
  results: AddMemberResult[];
}

/** 默认并发派成员数：4 个宿主进程同时起，够快又不把 spawn 风暴灌满机器。 */
export const DEFAULT_SPAWN_CONCURRENCY = 4;

/** 极简信号量：限制同时在飞的 spawn 数（12 个成员 → 4 路并发，而不是排队等锁）。 */
function createSemaphore(size: number): { acquire: () => Promise<void>; release: () => void } {
  let available = Math.max(1, size);
  const waiters: Array<() => void> = [];
  return {
    acquire: () => {
      if (available > 0) {
        available -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release: () => {
      const next = waiters.shift();
      if (next) next(); // 名额直接转手，available 不变。
      else available += 1;
    },
  };
}

export async function runGlobalQuotaGate(deps: GlobalQuotaGateDeps, inputs: readonly AddMemberInput[]): Promise<GlobalQuotaGateResult> {
  if (inputs.length === 0) return { conflict: null, results: [] };
  const results = new Array<AddMemberResult | undefined>(inputs.length);
  const semaphore = createSemaphore(Math.min(deps.concurrency ?? DEFAULT_SPAWN_CONCURRENCY, inputs.length));
  let conflict: string | null = null;
  let stopped = false;
  const inflight: Promise<void>[] = [];

  for (let index = 0; index < inputs.length; index += 1) {
    if (stopped) break;
    const input = inputs[index]!;
    // 先等一个并发位再占名额：等待中的成员不持预留，否则会把名额卡在排队上。
    await semaphore.acquire();
    const slot = await tryReserveTeamWorkerSlot({
      globalLimit: deps.globalLimit,
      readTotal: deps.readTotal,
      ...(deps.withLock ? { withLock: deps.withLock } : {}),
    });
    if (!slot.granted) {
      semaphore.release();
      stopped = true;
      conflict = globalLimitMessage({
        limit: slot.limit,
        used: slot.used,
        inflight: slot.inflight,
        pendingName: input.name,
        ...(deps.limitHint ? { limitHint: deps.limitHint } : {}),
      });
      break;
    }
    inflight.push((async () => {
      try {
        results[index] = await deps.addOne(input);
      } catch (error) {
        // 单个成员失败不中止整批（旧实现遇 MemberConflictError 直接丢掉剩余成员）。
        results[index] = {
          name: input.name,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (slot.reservationId) releaseQuotaSlot(slot.reservationId);
        semaphore.release();
      }
    })());
  }
  await Promise.all(inflight);
  return { conflict, results: results.filter((result): result is AddMemberResult => result !== undefined) };
}

/**
 * 删成员。顺序（v5 设计 §二，③）：先 release + 回执校验 → probe 真探 → **全成功后**
 * 才进临界区移名册（先移再探会在长跑期间制造孤儿）；移出时重读发现原值被并发改写
 * ⇒ 409 冲突不移除；停止成功而移除失败 ⇒ 如实报。running 成员禁止 remove。
 */
/** 删成员（对外入口）：进**成员级**队列槽（与同名 add 串行；不同成员互不阻塞）。 */
export function removeTeamMember(deps: MembersDeps, name: string): Promise<RemoveMemberResult> {
  return enqueueTeamMutation(memberQueueKey(deps.teamDir, name), () => removeTeamMemberCore(deps, name));
}

/**
 * 批量删成员：**逐成员失败隔离 + 小并发**。
 *
 * 旧 route 遇第一个 MemberConflictError 就 `break`——删 10 个成员时第 3 个在 running，
 * 后面 7 个根本没被尝试，用户还以为「删不动」。现在每个成员各自走自己的队列槽：
 * - 失败/冲突只记一条 failed（reason 原样），**继续**处理剩下的；
 * - 小并发（默认 4）：每个成员要 release + probe（真探会话是否已停），串行会拖很久；
 * - 结果按请求顺序返回。
 */
export interface RemoveMembersBatchResult {
  results: RemoveMemberResult[];
  /** 首个 409 语义（running / 被并发改写）的原因；没有则为 null。 */
  conflict: string | null;
}

export async function removeTeamMembersBatch(
  deps: MembersDeps,
  names: readonly string[],
  options: { concurrency?: number } = {},
): Promise<RemoveMembersBatchResult> {
  const results = new Array<RemoveMemberResult | undefined>(names.length);
  let conflict: string | null = null;
  const cursor = { value: 0 };
  const workerCount = Math.min(Math.max(1, options.concurrency ?? 4), names.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor.value;
      if (index >= names.length) return;
      cursor.value += 1;
      const name = names[index]!;
      try {
        results[index] = await removeTeamMember(deps, name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof MemberConflictError && conflict === null) conflict = reason;
        results[index] = { name, status: "failed", reason };
      }
    }
  }));
  return {
    results: results.filter((result): result is RemoveMemberResult => result !== undefined),
    conflict,
  };
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

  // 名册已经移掉，但**配额口径是 config ∪ plan**：不同步摘 plan 条目，全局数字一点不降，
  // 对 launch 派发出来的成员更是永远删不掉（它们只在 plan 里）。失败如实报告，
  // 不谎报「已移除」——用户要靠这个数字腾名额（团队计数审计 P0-1）。
  try {
    const pruned = await prunePlanRosterMember(deps.rawTeamName, name, deps.teamDir);
    if (!pruned.ok) {
      return {
        name,
        status: "failed",
        sessionId,
        reason: `成员已从 config 名册移除，但 plan.json 仍有同名条目（${pruned.error ?? "未知错误"}）：全局配额不会下降，请重试。`,
      };
    }
  } catch (error) {
    return {
      name,
      status: "failed",
      sessionId,
      reason: `成员已从 config 名册移除，但清理 plan.json 失败：${error instanceof Error ? error.message : String(error)}；全局配额不会下降，请重试。`,
    };
  }

  return {
    name,
    status: "removed",
    sessionId,
    warning: `成员「${name}」名下未结束的工单派活将无人认领；如需保留请在移除前先改派。`,
  };
}
