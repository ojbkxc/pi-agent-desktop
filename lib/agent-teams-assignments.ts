/**
 * 工单首次分配 / 改派编排（#54，服务端可测核心）。
 *
 * 数据层事实（实现依据，勿凭印象改动）：
 * - pi-team 根导出只有 host/lifecycle/bus（index.d.ts），teamTickets 的带锁 API 不在
 *   exports ⇒ 桌面在宿主侧复刻**同路径锁**：`tickets/<id>.json.lock`（proper-lockfile，
 *   选项照 teamTickets.js:127-133：retries {10, 5ms, 100ms}，先 wx 落空占位）——与
 *   pi-team 的 withTicketLock 跨进程互斥。
 * - writeTicket 每次写都 `ticketSchema.parse`（teamTickets.js:98）：非 schema 字段被
 *   strip；setAssignmentStatus 的 result 参数会覆盖 result ⇒ **assignment.result 不是
 *   可靠的幂等标记**。调度指纹/回执存独立 sidecar `tickets/<id>.dispatch.json`
 *   （同一票锁保护，pi-team 不读不写它），**按 clientRequestId 多记录键控**——同票
 *   先后两次调度（assign A → reassign B）各留各的记录，旧 clientRequestId 重试仍能
 *   精确复用，不重新 send、不新建 assignment。
 * - assignment 三态 {pending, running, ended}；ticket 二态 {open, ended}。
 * - setAssignmentStatus 不能换 assignee ⇒ 「改派」= 结束旧 assignment + 新建。
 *
 * 幂等边界（如实，不宣称 exactly-once）：两段临界区——段一（归属变更 + sidecar 记
 * outcome="pending-send"）出锁；段二（短票锁）只回写对应 clientRequestId 的 outcome，
 * 不触碰 assignment 业务字段。崩溃于「已 send 未回写」⇒ sidecar 停在 pending-send ⇒
 * 同 clientRequestId 重试会重新 send 一次（可能重复一条邮箱消息）——warnings 明示。
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";

const TICKET_LOCK_RETRIES = { retries: 10, minTimeout: 5, maxTimeout: 100 } as const;
/** Windows rename 瞬时错误（杀软/索引器顶句柄）的有界退避上限。 */
const RENAME_RETRY_MAX_ATTEMPTS = 23;

/**
 * 票文件的桌面浅写：原样序列化（**不 schema.parse**——上游 writeTicket 的 parse 会
 * strip 未知字段，桌面只改既有字段、不引入新字段，浅写保留 pi-team 落盘的一切）。
 * 随机临时文件 + rename 原子替换，Windows 瞬时错误有界退避（与 config 写同口径）。
 */
async function writeTicketShallow(path: string, ticket: Record<string, unknown>): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(ticket, null, 2)}\n`, "utf8");
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (attempt >= RENAME_RETRY_MAX_ATTEMPTS || !transient) throw error;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(25 * 2 ** attempt, 500));
        });
      }
    }
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** 409 语义的拒绝（route 直接转 409 + message）。 */
export class AssignmentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentConflictError";
  }
}

/** 票/成员不存在的 404 语义。 */
export class AssignmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentNotFoundError";
  }
}

/** sidecar 的单条调度记录（按 clientRequestId 键控多记录）。 */
interface DispatchRecord {
  clientRequestId: string;
  action: "assign" | "reassign";
  ticketId: string;
  assignmentId: string;
  toMember: string;
  /** 改派时为被结束的旧 assignment id；首次分配为 ""。 */
  replacedAssignmentId: string;
  /** 指纹：规范化 note（去首尾空白，空串归一）+ expectedUpdatedAt；重试精确全等。 */
  note: string;
  expectedUpdatedAt: number | null;
  /** pending-send=已建归属未确认投递；其余为 bus 回执（injected/woken/revived/buffered/failed）。 */
  outcome: string;
  error?: string;
}

interface DispatchSidecar {
  records: DispatchRecord[];
}

/** ticketId 必须能安全当文件名（防路径穿越）。 */
export function isValidTicketId(ticketId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ticketId) && !ticketId.includes("..");
}

function normalizeNote(note: string | undefined): string {
  return (note ?? "").trim();
}

function ticketPaths(teamDir: string, ticketId: string): { ticket: string; lock: string; sidecar: string } {
  const ticket = join(teamDir, "tickets", `${ticketId}.json`);
  return { ticket, lock: `${ticket}.lock`, sidecar: join(teamDir, "tickets", `${ticketId}.dispatch.json`) };
}

async function readTicketFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readSidecar(path: string): Promise<DispatchSidecar> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as DispatchSidecar;
    return Array.isArray(parsed.records) ? { records: parsed.records } : { records: [] };
  } catch {
    return { records: [] };
  }
}

async function writeSidecar(path: string, sidecar: DispatchSidecar): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  // sidecar 是桌面私有文件（pi-team 不读），rename 失败即如实抛错——不引入第二套重试口径。
  const { rename } = await import("node:fs/promises");
  await rename(temp, path);
}

/** 持票锁执行（同 pi-team withTicketLock：wx 占位 + proper-lockfile 同路径锁）。 */
export async function withTicketLock<T>(teamDir: string, ticketId: string, run: () => Promise<T>): Promise<T> {
  const { ticket, lock } = ticketPaths(teamDir, ticketId);
  await writeFile(ticket, "{}", { encoding: "utf8", flag: "wx" }).catch(() => undefined);
  const release = await lockfile.lock(ticket, {
    lockfilePath: lock,
    realpath: false,
    retries: { ...TICKET_LOCK_RETRIES },
  });
  try {
    return await run();
  } finally {
    await release().catch(() => undefined);
  }
}

export interface DispatchAssignmentDeps {
  /** 团队目录（route 用 teamDirFor 装配）。 */
  teamDir: string;
  /** 原始团队名（ticket.teamName 归属核对 + bus ctx）。 */
  rawTeamName: string;
  /**
   * config 名册成员名。⚠️ 这只是 route 调用时刻的快照；队列/票锁可能让它过期。
   * 判定 toMember 是否在名册时**优先用 `roster()` 在票锁内重读**（lead 复核），
   * 本字段仅作 roster() 缺省时的回退（测试便利）。
   */
  memberNames: readonly string[];
  /**
   * 票锁内重读名册（route 注入 readTeamConfigSnapshot）。返回 null = 团队消失/损坏
   * => 派发中止（**不回退快照**）；未注入（纯单测）才回退 memberNames。
   */
  roster?(deps: { teamDir: string; rawTeamName: string }): Promise<{ names: readonly string[]; members?: Array<{ name: string; sessionId?: string }> } | null>;
  now(): number;
  uuid(): string;
  /**
   * bus.send 的桌面装配（route 注入：getBus(rawName, 完整 BusContext) + from:"human"）。
   * 返回 receipt.outcome（injected/woken/revived/buffered/failed）。
   */
  send(to: string, body: string, summary: string): Promise<{ outcome: string; error?: string }>;
  /** wake 兜底（revived/buffered 时 best-effort；A9 残余窗口如实）。 */
  wake(sessionId: string, text: string): Promise<boolean>;
  /** 新 assignment 的接手人的会话（投递兜底用；取不到返回 undefined）。 */
  memberSessionId?(memberName: string): string | undefined;
}

export interface DispatchAssignmentInput {
  action: "assign" | "reassign";
  clientRequestId: string;
  ticketId: string;
  /** 改派时必填（被结束的旧 assignment）。 */
  assignmentId?: string;
  toMember: string;
  note?: string;
  /** 改派时必填（旧 assignment.updatedAt 的前置代际）。 */
  expectedUpdatedAt?: number;
}

export interface DispatchAssignmentResult {
  ok: boolean;
  ticketId: string;
  assignment: { id: string; assignee: string; status: string; updatedAt: number };
  delivery: { to: string; outcome: string; error?: string } | { to: string; skipped: "already-delivered" };
  warnings: string[];
}

/** 段一/段二共享的票面 assignment 形态（结构化访问 pi-team 落盘）。 */
interface TicketAssignmentView {
  id: string;
  assignee: string;
  status: string;
  updatedAt: number;
  raw: Record<string, unknown>;
}

function assignmentViews(ticket: Record<string, unknown>): TicketAssignmentView[] {
  const assignments = ticket.assignments;
  if (!Array.isArray(assignments)) return [];
  return assignments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || typeof raw.assignee !== "string" || typeof raw.status !== "string") return [];
    return [{
      id: raw.id,
      assignee: raw.assignee,
      status: raw.status,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
      raw,
    }];
  });
}

/** 票主题的安全读取（落盘缺 subject 时回退票 id）。 */
function ticketSubject(ticket: Record<string, unknown>): string {
  return typeof ticket.subject === "string" && ticket.subject ? ticket.subject : String(ticket.id ?? "");
}

/**
 * 首次分配 / 改派：段一票锁内完成「复核 + 归属变更 + sidecar 记录」，锁外投递，
 * 段二短票锁回写 outcome。返回逐字段的交付结果（不吞错、不谎报已唤醒）。
 *
 * 外层再包 `enqueueTeamMutation("team:<dir>")`（lead 裁定）：同团队所有编排（config/
 * 成员/工单）共享一条队列；票锁只保护票临界区本身。
 */
export async function dispatchAssignment(deps: DispatchAssignmentDeps, input: DispatchAssignmentInput): Promise<DispatchAssignmentResult> {
  const { enqueueTeamMutation } = await import("./agent-teams-swimlane-store");
  return enqueueTeamMutation(`team:${deps.teamDir}`, () => dispatchAssignmentLocked(deps, input));
}

async function dispatchAssignmentLocked(deps: DispatchAssignmentDeps, input: DispatchAssignmentInput): Promise<DispatchAssignmentResult> {
  const clientRequestId = input.clientRequestId;
  const toMember = input.toMember;
  const note = normalizeNote(input.note);
  const isReassign = input.action === "reassign";

  // 段一：票锁临界区。
  const staged = await withTicketLock(deps.teamDir, input.ticketId, async () => {
    const paths = ticketPaths(deps.teamDir, input.ticketId);
    const ticket = await readTicketFile(paths.ticket);
    if (!ticket) throw new AssignmentNotFoundError(`工单 ${input.ticketId} 不存在`);
    if (ticket.teamName !== deps.rawTeamName) {
      throw new AssignmentConflictError(`工单 ${input.ticketId} 不属于团队「${deps.rawTeamName}」`);
    }
    if (ticket.status !== "open") {
      throw new AssignmentConflictError(`工单 ${input.ticketId} 已结束（${ticket.status}），不能再派活`);
    }
    // toMember 校验前**在票锁内重读名册**（lead 复核：memberNames 是 route 快照，
    // 队列等待期间名册可能已变）。口径（lead 退回④）：deps.roster **已注入但返回
    // null（团队消失/损坏）=> 中止派发**——回退过期快照会把活派给已删成员造成孤儿；
    // 仅「未注入 roster（纯单测）」才回退 memberNames 快照。
    let currentNames: readonly string[];
    let rosterMembers: Array<{ name: string; sessionId?: string }> | null = null;
    if (deps.roster) {
      const fresh = await deps.roster({ teamDir: deps.teamDir, rawTeamName: deps.rawTeamName });
      if (!fresh) {
        throw new AssignmentNotFoundError(`团队「${deps.rawTeamName}」的名册已不可读（可能已被移除），中止派发`);
      }
      currentNames = fresh.names;
      rosterMembers = fresh.members ?? null;
    } else {
      currentNames = deps.memberNames;
    }
    if (!currentNames.includes(toMember)) {
      throw new AssignmentNotFoundError(`接手成员「${toMember}」不在团队名册中`);
    }

    const sidecar = await readSidecar(paths.sidecar);
    const mine = sidecar.records.find((record) => record.clientRequestId === clientRequestId);
    if (mine) {
      // 同 clientRequestId 重试：指纹精确全等（含规范化 note 与 expectedUpdatedAt）。
      const sameFingerprint =
        mine.action === input.action
        && mine.ticketId === input.ticketId
        && (mine.replacedAssignmentId || "") === (isReassign ? input.assignmentId ?? "" : "")
        && mine.toMember === toMember
        && mine.note === note
        && mine.expectedUpdatedAt === (isReassign ? input.expectedUpdatedAt ?? null : null);
      if (!sameFingerprint) {
        throw new AssignmentConflictError(
          `clientRequestId "${clientRequestId}" 已用于同票的另一次调度（参数不同）。请换一个新的 clientRequestId。`,
        );
      }
      if (mine.outcome !== "failed" && mine.outcome !== "pending-send") {
        // 已确认交付：不重新 send（防邮箱重复文本），返回既有 assignment。
        const existing = assignmentViews(ticket).find((view) => view.id === mine.assignmentId);
        if (!existing) throw new AssignmentNotFoundError("调度记录存在，但对应的 assignment 已不在票上");
        return {
          kind: "skip" as const,
          subject: ticketSubject(ticket),
          assignment: { id: existing.id, assignee: existing.assignee, status: existing.status, updatedAt: existing.updatedAt },
          outcome: mine.outcome,
          rosterMembers,
        };
      }
      // pending-send（崩溃残留）或 failed：保留既有 assignment，重发投递（不新建）。
      const existing = assignmentViews(ticket).find((view) => view.id === mine.assignmentId);
      if (!existing) throw new AssignmentNotFoundError("调度记录存在，但对应的 assignment 已不在票上");
      return {
        kind: "resend" as const,
        subject: ticketSubject(ticket),
        assignment: { id: existing.id, assignee: existing.assignee, status: existing.status, updatedAt: existing.updatedAt },
        record: mine,
        rosterMembers,
      };
    }

    if (isReassign) {
      const views = assignmentViews(ticket);
      const target = views.find((view) => view.id === input.assignmentId);
      if (!target) throw new AssignmentNotFoundError(`assignment ${input.assignmentId} 不在工单 ${input.ticketId} 上`);
      if (target.status === "running") {
        throw new AssignmentConflictError(
          `旧派活正在执行（running），改派会造成双主。请先等它完成或停止成员「${target.assignee}」的当前执行，再改派。`,
        );
      }
      if (target.status !== "pending") {
        throw new AssignmentConflictError(`旧派活已结束（${target.status}），无需改派`);
      }
      if (target.assignee === toMember) {
        throw new AssignmentConflictError(`接手成员与当前派活成员相同（${toMember}）`);
      }
      if (typeof input.expectedUpdatedAt !== "number" || input.expectedUpdatedAt !== target.updatedAt) {
        throw new AssignmentConflictError(
          `工单已被他人更新（代际不匹配：期望 ${input.expectedUpdatedAt ?? "缺失"}，实际 ${target.updatedAt}）。请刷新后重试。`,
        );
      }
      const otherActive = views.filter((view) => view.id !== target.id && view.status !== "ended");
      if (otherActive.length > 0) {
        throw new AssignmentConflictError(
          `工单还有其它未结束的派活（${otherActive.map((view) => view.id).join("、")}），先处理它们再改派，避免多主。`,
        );
      }
      // 两步变更：结束旧 + 新建（照 teamTickets.js setAssignmentStatus/createTicket 形态）。
      target.raw.status = "ended";
      target.raw.outcome = "cancelled";
      target.raw.result = note || `改派至 ${toMember}（Pi Web 人工调度）`;
      target.raw.updatedAt = deps.now();
      const assignmentId = `assign-${deps.uuid()}`;
      const now = deps.now();
      ticket.assignments = [
        ...(Array.isArray(ticket.assignments) ? ticket.assignments as unknown[] : []),
        { id: assignmentId, assignee: toMember, status: "pending", createdAt: now, updatedAt: now },
      ];
      // 写序：先票后 sidecar——票写失败（rename 异常）⇒ sidecar 无痕，完整重试安全；
      // 反序则票未变而记录已留，重试会撞「assignment 不在票上」死路。
      await writeTicketShallow(paths.ticket, ticket);
      sidecar.records.push({
        clientRequestId,
        action: "reassign",
        ticketId: input.ticketId,
        assignmentId,
        toMember,
        replacedAssignmentId: target.id,
        note,
        expectedUpdatedAt: input.expectedUpdatedAt ?? null,
        outcome: "pending-send",
      });
      await writeSidecar(paths.sidecar, sidecar);
      return {
        kind: "dispatch" as const,
        subject: ticketSubject(ticket),
        assignment: { id: assignmentId, assignee: toMember, status: "pending", updatedAt: now },
        rosterMembers,
      };
    }

    // 首次分配：同票已有任一未 ended assignment ⇒ 409（防并行双派）。
    const views = assignmentViews(ticket);
    const active = views.filter((view) => view.status !== "ended");
    if (active.length > 0) {
      throw new AssignmentConflictError(
        `工单已有未结束的派活（${active.map((view) => view.id).join("、")}）。如需换人请走改派（提供 assignmentId）。`,
      );
    }
    const assignmentId = `assign-${deps.uuid()}`;
    const now = deps.now();
    ticket.assignments = [
      ...(Array.isArray(ticket.assignments) ? ticket.assignments as unknown[] : []),
      { id: assignmentId, assignee: toMember, status: "pending", createdAt: now, updatedAt: now },
    ];
    // 写序同上：先票后 sidecar。
    await writeTicketShallow(paths.ticket, ticket);
    sidecar.records.push({
      clientRequestId,
      action: "assign",
      ticketId: input.ticketId,
      assignmentId,
      toMember,
      replacedAssignmentId: "",
      note,
      expectedUpdatedAt: null,
      outcome: "pending-send",
    });
    await writeSidecar(paths.sidecar, sidecar);
    return {
      kind: "dispatch" as const,
      subject: ticketSubject(ticket),
      assignment: { id: assignmentId, assignee: toMember, status: "pending", updatedAt: now },
      rosterMembers,
    };
  });

  const warnings: string[] = [];

  if (staged.kind === "skip") {
    return {
      ok: true,
      ticketId: input.ticketId,
      assignment: staged.assignment,
      delivery: { to: toMember, skipped: "already-delivered" },
      warnings,
    };
  }

  // 段一与段二之间：真投递（bus.send，from:"human" 由 route 装配）。
  const subject = staged.subject;
  const body = `[工单 ${input.ticketId}]（Pi Web 人工调度）工单「${subject}」已${isReassign ? "改派" : "分配"}给你${note ? `：${note}` : ""}。请用 team_ticket 查看详情并开始执行。`;
  let delivery: { outcome: string; error?: string };
  try {
    delivery = await deps.send(toMember, body, subject);
  } catch (error) {
    // send 抛错（deps 不应抛，但防御）：sidecar 留在 pending-send（既定崩溃边界），
    // route 以 500 上报、客户端同 clientRequestId 重试恢复（pending-send ⇒ 重发）。
    // **不宣称 exactly-once**：此时消息可能已落邮箱。
    delivery = { outcome: "pending-send", error: error instanceof Error ? error.message : String(error) };
  }
  let outcome = delivery.outcome;

  // revived/buffered ⇒ wake 兜底（best-effort；A9 残余窗口如实——wake 失败被总线吞掉）。
  // sessionId 优先取票锁内新读的 roster（lead 退回③：入队前 config 可能过期——
  // 排队期间成员复活换了会话，旧 sessionId 唤不醒）。
  // fresh.members 存在但未命中 toMember ⇒ 不回退旧 sessionId（成员已不在名册 =
  // 派发应已失败；此处是防御——回退旧会话会唤醒已删成员的残骸会话）。
  const freshMember = staged.rosterMembers?.find((member) => member.name === toMember);
  const wakeSessionId = staged.rosterMembers
    ? freshMember?.sessionId
    : deps.memberSessionId?.(toMember);
  if ((outcome === "revived" || outcome === "buffered") && wakeSessionId) {
    const sessionId = wakeSessionId;
    if (sessionId) {
      const woke = await deps.wake(sessionId, body).catch(() => false);
      if (!woke) warnings.push("邮箱投递已落盘，但即时唤醒未成功；成员空闲后仍会从邮箱取到该工单（上游 A9 残余窗口）。");
    }
  }

  // 段二：短票锁回写 outcome（只改 sidecar 对应记录，不触碰 assignment 业务字段）。
  // send 抛错（outcome=pending-send）时同样回写——记录如实停在 pending-send。
  await withTicketLock(deps.teamDir, input.ticketId, async () => {
    const paths = ticketPaths(deps.teamDir, input.ticketId);
    const sidecar = await readSidecar(paths.sidecar);
    const record = sidecar.records.find((item) => item.clientRequestId === clientRequestId);
    if (record) {
      record.outcome = outcome;
      if (delivery.error) record.error = delivery.error;
      await writeSidecar(paths.sidecar, sidecar);
    }
  });

  if (outcome === "pending-send") {
    // 投递结果未知：如实在响应里降级为 failed + 指引重试（同 clientRequestId 恢复）。
    outcome = "failed";
    warnings.push(
      `投递结果未知${delivery.error ? `（${delivery.error}）` : ""}：归属已落盘，请用同一 clientRequestId 重试以确认或重发投递。`,
    );
  }

  return {
    ok: true,
    ticketId: input.ticketId,
    assignment: staged.assignment,
    delivery: { to: toMember, outcome, ...(delivery.error ? { error: delivery.error } : {}) },
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// route 侧装配（动态 import pi-team，纯测试路径不触达）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * bus.send 的桌面装配：完整 BusContext 照 pi-team envFor 形态（teamTools.js:105-115），
 * **getter 一律动态现取**（host/lifecycle 走 registry，不缓存实例——防 ensureLive 后
 * 打到旧实例）。self 用 "human"（pi-team constants.js:140 HUMAN_SENDER_NAME，根导出
 * 不含 constants，故字面量+注释钉口径）：人类优先跳过防抖立即 #flush，用户一键调度
 * 的唤醒不等价于 from:"team-lead" 的排队合并。
 */
export async function dispatchViaBus(
  teamDirName: string,
  rawTeamName: string,
  to: string,
  body: string,
  summary: string,
): Promise<{ outcome: string; error?: string }> {
  const piTeam = await import("pi-team");
  const { teamDirFor } = await import("./agent-teams-swimlane-store");
  const { readTeamConfig } = await import("./agent-teams-team-actions");
  const roster = await readTeamConfig(teamDirName, teamDirFor);
  const memberNames = roster?.members.map((member) => member.name) ?? [];
  const bus = piTeam.getBus(rawTeamName, {
    host: () => piTeam.resolveTeamHost(),
    lifecycle: () => {
      const lifecycle = piTeam.getLifecycle(rawTeamName, piTeam.resolveTeamHost());
      return {
        get: (name: string) => lifecycle.get(name),
        ensureLive: (name: string) => lifecycle.ensureLive(name),
        markIdle: (name: string) => lifecycle.markIdle(name),
      };
    },
    teamName: () => rawTeamName,
    self: () => "human",
    members: () => Promise.resolve(memberNames),
  });
  const receipt = await bus.send({ from: "human", to, body, summary });
  return { outcome: receipt.outcome, ...(receipt.error ? { error: receipt.error } : {}) };
}
