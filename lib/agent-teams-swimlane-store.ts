/**
 * 泳道快照的磁盘读取 + 团队成员模型的写路径（服务端专用）。
 *
 * 读：从 ~/.pi/agent/teams/<team>/ 读 pi-team 落盘文件并交给 lib/agent-teams-swimlane.ts
 * 的纯投影。
 * 写：只写 config.json 的 members[].model / providerId（改成员模型用），读-改-写整份文件
 * 以保留其余字段；**不碰会话内部状态**（发命令由调用方注入的 deliver 负责）。
 *
 * 路径与 pi-team 对齐（constants.getTeamsDir / teamHelpers.sanitizeName），但不 import
 * pi-team 包：其 package.json exports 只暴露 `.` / `./compat` / `./policy`，internal
 * 模块不可达；这里按同名规则复刻，逻辑简单且稳定。
 *
 * 客户端组件不要 import 本文件（含 node:fs）；只 import lib/agent-teams-swimlane.ts。
 */
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "./user-home";
import { serializeByKey } from "./key-serializer";
import {
  projectTeamWorkbench,
  type AcceptedRecordLike,
  type LifecycleEntryLike,
  type MailboxMessageLike,
  type PlanLike,
  type ReceiptLike,
  type RuntimeTicketLike,
  type TeamFileLike,
  type TeamWorkbenchSnapshot,
} from "./agent-teams-swimlane";

/**
 * 团队数据根目录：与 pi-team constants.getTeamsDir 一致（PI_TEAM_DIR 覆盖）。
 * home 用 userHome()（PI_AGENT_HOME 覆盖）以避开 Next 打包期对字面 homedir 的静态求值；
 * 未设覆盖时与 pi-team 的 homedir() 结果相同。
 */
export function teamsRootDir(): string {
  return process.env.PI_TEAM_DIR || join(userHome(), ".pi", "agent", "teams");
}

/** 与 pi-team teamHelpers.sanitizeName 一致：非字母数字转 '-' 并小写。 */
export function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

export function teamDirFor(teamName: string): string {
  return join(teamsRootDir(), sanitizeTeamName(teamName));
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readLifecycle(teamDir: string): Promise<Record<string, LifecycleEntryLike>> {
  const file = await readJson<{ members?: Record<string, LifecycleEntryLike> }>(join(teamDir, "lifecycle.json"));
  return file?.members ?? {};
}

async function readAccepted(teamDir: string): Promise<AcceptedRecordLike[]> {
  try {
    const raw = await readFile(join(teamDir, "accepted.jsonl"), "utf8");
    const records: AcceptedRecordLike[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AcceptedRecordLike;
        if (parsed && typeof parsed.member === "string" && typeof parsed.at === "string") records.push(parsed);
      } catch {
        // 撕裂的最后一行：下次追加会另起一行，忽略之。
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * 运行时工单：tickets/<ticketId>.json（pi-team team_ticket 工具写入）。
 * 目录缺失、单个文件损坏/结构不符一律静默跳过；顺序按 createdAt 升序（与 listTickets 一致）。
 */
async function readRuntimeTickets(teamDir: string): Promise<RuntimeTicketLike[]> {
  const dir = join(teamDir, "tickets");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const collected: RuntimeTicketLike[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const ticket = await readJson<RuntimeTicketLike>(join(dir, name));
    if (!ticket || typeof ticket.id !== "string" || typeof ticket.subject !== "string" || !Array.isArray(ticket.assignments)) continue;
    collected.push(ticket);
  }
  return collected.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** 已读回执：acks/receipts.jsonl，逐行解析，撕裂/损坏行静默忽略（同 readAccepted 风格）。 */
async function readReceipts(teamDir: string): Promise<ReceiptLike[]> {
  try {
    const raw = await readFile(join(teamDir, "acks", "receipts.jsonl"), "utf8");
    const receipts: ReceiptLike[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ReceiptLike;
        if (parsed && typeof parsed.messageId === "string" && typeof parsed.reader === "string" && typeof parsed.ackedAt === "number") {
          receipts.push(parsed);
        }
      } catch {
        // 撕裂的最后一行：下次追加会另起一行，忽略之。
      }
    }
    return receipts;
  } catch {
    return [];
  }
}

/** 读取某成员邮箱的 live + history，并把收件人补进 `to`（邮箱是按收件人分目录的）。 */
async function readMemberMessages(teamDir: string, member: string): Promise<MailboxMessageLike[]> {
  const inboxDir = join(teamDir, "inboxes");
  const live = join(inboxDir, `${member}.json`);
  const history = join(inboxDir, `${member}.history.jsonl`);
  const collected: MailboxMessageLike[] = [];

  const liveRaw = await readJson<MailboxMessageLike[]>(live);
  if (Array.isArray(liveRaw)) {
    for (const message of liveRaw) {
      if (message && typeof message.from === "string") collected.push({ ...message, to: member });
    }
  }

  try {
    const raw = await readFile(history, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as MailboxMessageLike;
        if (parsed && typeof parsed.from === "string") collected.push({ ...parsed, to: member });
      } catch {
        // 同上：撕裂行忽略。
      }
    }
  } catch {
    // 无 history 文件。
  }

  return collected;
}

/** 该团队全部成员的邮箱消息（live + history 合并；identity 去重）。 */
async function readAllMessages(teamDir: string, memberNames: readonly string[]): Promise<MailboxMessageLike[]> {
  let inboxFiles: string[] = [];
  try {
    inboxFiles = await readdir(join(teamDir, "inboxes"));
  } catch {
    inboxFiles = [];
  }
  const recipients = new Set<string>(memberNames);
  for (const file of inboxFiles) {
    const match = /^(.*)\.json$/.exec(file);
    if (match) recipients.add(match[1]);
  }

  const all: MailboxMessageLike[] = [];
  for (const recipient of recipients) {
    all.push(...(await readMemberMessages(teamDir, recipient)));
  }

  const seen = new Set<string>();
  const deduped: MailboxMessageLike[] = [];
  for (const message of all) {
    const identity = message.id ? `id:${message.id}` : `${message.from}|${message.timestamp}|${message.text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(message);
  }
  // history 在 live 之后，时间序不可靠；按 timestamp 稳定排序。
  deduped.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return deduped;
}

/** 读取一个团队的泳道快照；团队不存在（无 config.json）返回 null。 */
export async function readTeamWorkbench(teamName: string): Promise<TeamWorkbenchSnapshot | null> {
  const teamDir = teamDirFor(teamName);
  const team = await readJson<TeamFileLike>(join(teamDir, "config.json"));
  if (!team || !Array.isArray(team.members)) return null;

  const [plan, lifecycle, accepted, messages, runtimeTickets, receipts] = await Promise.all([
    readJson<PlanLike>(join(teamDir, "plan.json")),
    readLifecycle(teamDir),
    readAccepted(teamDir),
    readAllMessages(teamDir, team.members.map((member) => member.name)),
    readRuntimeTickets(teamDir),
    readReceipts(teamDir),
  ]);

  return projectTeamWorkbench({
    teamName,
    team,
    plan,
    lifecycle,
    accepted,
    messages,
    runtimeTickets,
    receipts,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * 找到包含该 session 的团队名（供 /api/teams/session/[id]/workbench）。
 * 既认 lead 会话，也认成员会话：成员的 sessionId 可能落在 config 名册里，
 * 也可能只落在 lifecycle.json（成员被派发后才写入），两处都要查。
 */
export async function findTeamBySession(sessionId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(teamsRootDir());
  } catch {
    return null;
  }
  for (const name of names) {
    const teamDir = teamDirFor(name);
    const team = await readJson<TeamFileLike>(join(teamDir, "config.json"));
    if (team?.leadSessionId === sessionId) return name;
    if (Array.isArray(team?.members) && team.members.some((member) => member.sessionId === sessionId)) return name;
    const lifecycle = await readLifecycle(teamDir);
    if (Object.values(lifecycle).some((entry) => entry.sessionId === sessionId)) return name;
  }
  return null;
}

/**
 * 本机团队名册（供 Agents 面板选择）。
 *
 * `name` 是**目录名**（已 sanitize，稳定，可用于 URL/查表）；`displayName` 是**给人看的名字**，
 * 优先取 config.json 的 team.name（缺失才回退目录名）。两者必须分开：中文团队名「前端重构队」
 * 的目录名是 `------`（sanitizeTeamName 把非 ASCII 全替换成 -），拿目录名当显示名会显示一串横线。
 */
export async function listTeams(): Promise<Array<{
  /** 目录名（sanitize 后，稳定 id）。 */
  name: string;
  /** 显示名：config.json 的 team.name，缺失回退目录名。 */
  displayName: string;
  description: string;
  memberCount: number;
  createdAt: string;
  /** 团队成员的全部会话 id：config 名册 + lifecycle 条目，合并去重（名册在前）。 */
  memberSessionIds: string[];
}>> {
  let names: string[];
  try {
    names = await readdir(teamsRootDir());
  } catch {
    return [];
  }
  const teams = await Promise.all(names.map(async (name) => {
    const teamDir = teamDirFor(name);
    const [team, lifecycle] = await Promise.all([
      readJson<TeamFileLike>(join(teamDir, "config.json")),
      readLifecycle(teamDir),
    ]);
    if (!team) return null;
    const sessionIds = new Set<string>();
    for (const member of team.members ?? []) {
      if (typeof member.sessionId === "string" && member.sessionId) sessionIds.add(member.sessionId);
    }
    for (const entry of Object.values(lifecycle)) {
      if (typeof entry.sessionId === "string" && entry.sessionId) sessionIds.add(entry.sessionId);
    }
    const configName = typeof team.name === "string" && team.name ? team.name : "";
    return {
      name,
      displayName: configName || name,
      description: team.description ?? "",
      memberCount: team.members?.length ?? 0,
      createdAt: typeof team.createdAt === "number" ? new Date(team.createdAt).toISOString() : "",
      memberSessionIds: [...sessionIds],
    };
  }));
  return teams.filter((team): team is NonNullable<typeof team> => team !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 写路径：改团队成员模型（读-改-写 config.json + 投递 set_model）
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamMemberModelUpdate {
  /** config.json 里成员的 agentId。 */
  memberId: string;
  provider: string;
  modelId: string;
}

/**
 * 一次投递的结果：
 * - applied：已对存活会话执行 set_model，运行态即时生效；
 * - unavailable：会话不在（未派发 / 已死 / parked），发不了命令，只能写文件。
 */
export type MemberModelDelivery = { kind: "applied" } | { kind: "unavailable" };

export interface TeamMemberModelResult {
  memberId: string;
  /** 成员名（取不到为 null）。 */
  name: string | null;
  /** applied=已生效；saved=已保存待复活；failed=失败。 */
  status: "applied" | "saved" | "failed";
  /** status=failed 时的原因（成员不存在 / 模型不存在 / 命令失败）。 */
  reason?: string;
}

export interface ApplyTeamMemberModelsOptions {
  teamName: string;
  updates: readonly TeamMemberModelUpdate[];
  /**
   * 把 set_model 投递到指定会话。会话不可用返回 unavailable；命令失败（如模型不存在）
   * 请直接抛错——错误信息会原样透传进该成员的结果。
   */
  deliver: (sessionId: string, update: { provider: string; modelId: string }) => Promise<MemberModelDelivery>;
}

/**
 * config.json 的 per-team 写队列。只靠队列并不闭环——pi-team 扩展自身写 config.json
 * 不经过这里——所以队列之内还要**同步重读**最新落盘内容再合并（见
 * applyMemberModelIntentsSync）：同步段没有任何 await，JS 单线程下同进程写者（含
 * pi-team）不可能插进读与写之间；队列则把并发 PATCH 的写回按团队排成先后。
 */
const TEAM_CONFIG_QUEUE: symbol = Symbol.for("pi-web:team-config-write-queue");

/** config.json 原子写回：随机临时文件（防并发同写一个 temp）+ rename；失败清掉临时。 */
function writeTeamConfigSync(teamDir: string, config: unknown): void {
  const target = join(teamDir, "config.json");
  const temp = join(teamDir, `config.json.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // 尚未创建，或已 rename 走。
    }
    throw error;
  }
}

/** 同步读 config.json：阶段二的合并基线必须读盘，不能用阶段一的旧快照。 */
function readTeamConfigSync(teamDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(teamDir, "config.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 阶段一收集的「要写什么」：落盘所需的最小意图，阶段二据此改**磁盘最新**的 config。 */
interface MemberModelIntent {
  memberId: string;
  name: string;
  provider: string;
  modelId: string;
  /** plan 独有成员追加名册时带的 agentType（existing 成员没有）。 */
  agentType?: string;
  /** 追加条目时的 joinedAt：existing 成员沿用原值，plan 独有成员用 plan.createdAt。 */
  joinedAt: number;
  /** 追加条目时的 cwd：existing 成员沿用原值，plan 独有成员为 ""（沿用旧追加语义）。 */
  cwd: string;
}

/**
 * 把意图落盘，Windows 瞬时错误有界重试：rename 覆盖「刚被换上的文件」会被杀软/索引器
 * 的短暂句柄顶住（EPERM/EACCES/EBUSY，tmpdir 上连续快速换名时可长达数秒）。每次重试都
 * 是一段完整的「同步重读→合并→写」（applyMemberModelIntentsSync）——读与写之间仍无
 * await，正确性不因重试破坏；等待发生在两次完整尝试之间，事件循环不被阻塞。重试耗尽
 * 才如实抛错——原子换名保证旧 config 完好，路由会以 500 上报、不谎报成功。
 */
async function persistMergedTeamConfig(teamDir: string, intents: readonly MemberModelIntent[]): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      applyMemberModelIntentsSync(teamDir, intents);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (attempt >= 23 || !transient) throw error;
      // 不 unref：重试是承重工作，unref 会让事件循环在只剩这个 timer 时提前清空，
      // 进程带着 pending promise 退出（测试里表现为 ERR_TEST_FAILURE cancelled）。
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(25 * 2 ** attempt, 500));
      });
    }
  }
}

/**
 * 阶段二单次尝试：把意图合并进磁盘上最新的 config.json 并原子写回。整段同步、无
 * await——读与写之间本进程任何代码（含 pi-team 扩展）都无法插入；合并基线永远是刚
 * 读到的盘上内容，因此先落盘者的改动不会被旧快照覆盖。
 */
function applyMemberModelIntentsSync(teamDir: string, intents: readonly MemberModelIntent[]): void {
  const config = readTeamConfigSync(teamDir);
  const rawMembers = config?.members;
  if (!config || !Array.isArray(rawMembers)) {
    throw new Error("config.json 在保存成员模型时不可读，未写盘");
  }
  for (const intent of intents) {
    let member = findConfigMember(rawMembers, intent.memberId);
    if (!member) {
      // 名册里没有（plan 独有成员，或阶段一之后被并发移除）：按意图补一条，
      // 幂等由 agentId 命中保证。刻意不写 sessionId（见 applyTeamMemberModelChanges 注释）。
      member = {
        agentId: intent.memberId,
        name: intent.name,
        ...(intent.agentType ? { agentType: intent.agentType } : {}),
        joinedAt: intent.joinedAt,
        cwd: intent.cwd,
      };
      rawMembers.push(member);
    }
    member.model = intent.modelId;
    member.providerId = intent.provider;
  }
  writeTeamConfigSync(teamDir, config);
}

/** 在 config.members 原始数组里按 agentId 找成员条目。 */
function findConfigMember(
  members: readonly unknown[],
  memberId: string,
): Record<string, unknown> | undefined {
  return members.find(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && (item as { agentId?: unknown }).agentId === memberId,
  );
}

/**
 * 改团队成员的模型：把 members[].model / providerId 写进 config.json（其余字段原样
 * 保留），并对存活会话投递 { type: "set_model" }。
 *
 * 分两个阶段，防止「投递等待窗口里的并发写回」用旧快照覆盖别人：
 *
 * - **阶段一（可并发）**：读 config/lifecycle/plan 做校验与投递，只收集「要写什么」
 *   （MemberModelIntent）与逐条结果，不碰盘。投递抛错的成员不进意图——「失败不写盘、
 *   不追加名册」由收集口径保证。
 * - **阶段二（串行）**：per-team 队列内**同步重读**磁盘最新的 config.json，把意图合并
 *   进去再原子写回（见 applyMemberModelIntentsSync）。合并基线是刚读到的盘上内容，
 *   所以先落盘者（另一个 PATCH，或 pi-team 自身的无锁写）的改动不会被旧快照覆盖。
 *
 * 名册口径与投影层 `buildRoster`（#13）一致，统一到 **config.json 为权威名册**：
 * - 成员在 config 里 → 直接更新；
 * - 成员是 plan 独有（team_plan launch 只做 lifecycle.adopt、不写 config）→ **追加**一条
 *   config 名册条目（agentId/name 取自 plan），因为投影里 config.member.model 优先于
 *   plan.runtime.modelId——只写 plan.json 会让新值在界面上不可见。**幂等**：追加后再次
 *   调用按 agentId 命中既有条目，不会重复追加。追加条目**不写 sessionId**（投影优先读
 *   config.sessionId，写死会遮蔽 lifecycle 里后续换新的会话）。
 *
 * 逐条判定（**如实区分，不谎报已生效**）：
 * - config 与 plan 里都找不到该 memberId → failed("成员不存在")；
 * - 有存活会话且未 parked：投递成功 → applied；投递抛错（如 Model not found）
 *   → failed 且**不写盘**（保持 config 与运行态一致），错误原样透传；
 * - 无存活会话 / parked / 未派发：只写盘 → saved（调用方据此显示「已保存待复活」）。
 *
 * 团队不存在（无 config.json）时返回 teamExists=false、results=[]。
 */
export async function applyTeamMemberModelChanges(
  options: ApplyTeamMemberModelsOptions,
): Promise<{ teamExists: boolean; results: TeamMemberModelResult[] }> {
  const teamDir = teamDirFor(options.teamName);
  const [config, lifecycle, plan] = await Promise.all([
    readJson<Record<string, unknown>>(join(teamDir, "config.json")),
    readLifecycle(teamDir),
    readJson<PlanLike>(join(teamDir, "plan.json")),
  ]);
  const rawMembers = config?.members;
  if (!config || !Array.isArray(rawMembers)) return { teamExists: false, results: [] };

  // 阶段一：校验 + 投递，只收集意图与结果。
  const results: TeamMemberModelResult[] = [];
  const intents: MemberModelIntent[] = [];

  for (const update of options.updates) {
    const existing = findConfigMember(rawMembers, update.memberId);
    const planMember = existing
      ? undefined
      : (plan?.members ?? []).find((item) => item?.id === update.memberId && !!item?.name);

    if (!existing && !planMember) {
      results.push({ memberId: update.memberId, name: null, status: "failed", reason: "成员不存在" });
      continue;
    }

    const name = existing
      ? (typeof existing.name === "string" ? existing.name : null)
      : (planMember?.name ?? null);
    const entry = name ? lifecycle[name] : undefined;
    const sessionIdFromConfig = existing && typeof existing.sessionId === "string" ? existing.sessionId : "";
    const sessionId = (typeof entry?.sessionId === "string" ? entry.sessionId : "") || sessionIdFromConfig;

    let status: TeamMemberModelResult["status"] = "saved";
    if (sessionId && entry?.status !== "parked") {
      try {
        const delivery = await options.deliver(sessionId, { provider: update.provider, modelId: update.modelId });
        status = delivery.kind === "applied" ? "applied" : "saved";
      } catch (error) {
        // 命令失败（例：Model not found）：不进意图，落盘时保持 config 与运行态一致。
        results.push({
          memberId: update.memberId,
          name,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    // 成功路径才收集意图；plan 独有成员在阶段二追加名册条目（幂等，见
    // applyMemberModelIntentsSync）。带上 plan 的 agentType，否则投影里该成员的角色会
    // 从 plan 值退化成通用 "member"。
    intents.push({
      memberId: update.memberId,
      name: name ?? update.memberId,
      provider: update.provider,
      modelId: update.modelId,
      ...(planMember?.agentType ? { agentType: planMember.agentType } : {}),
      joinedAt: existing && typeof existing.joinedAt === "number"
        ? existing.joinedAt
        : typeof plan?.createdAt === "number" ? plan.createdAt : 0,
      cwd: existing && typeof existing.cwd === "string" ? existing.cwd : "",
    });
    results.push({ memberId: update.memberId, name, status });
  }

  // 阶段二：per-team 队列内重读最新 config、合并意图、原子写回（Windows 瞬时错误重试）。
  if (intents.length > 0) {
    await serializeByKey(TEAM_CONFIG_QUEUE, teamDir, () => persistMergedTeamConfig(teamDir, intents));
  }
  return { teamExists: true, results };
}
