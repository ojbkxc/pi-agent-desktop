/**
 * 票负责人解析（纯函数，零 I/O）。
 *
 * 任务详情抽屉要回答「这张票归谁」。票上的 `ownerId` 是最权威的来源，但运行时票
 * （tickets/<id>.json 派生）与 plan 派生票并非总能带上它：`ownerId === null` 时
 * 负责人只能从运行时派活（assignments）或邮箱派工消息（task_assignment）回填——
 * 这两条都是**推断**，界面必须如实标注（teams.task.inferredOwner），不能冒充显式归属。
 *
 * 解析顺序（先到先得）：
 *   1. `ownerId`（显式）——包括「显式空」：空串表示用户明确未指派，绝不回填；
 *   2. `assignments` 里**最后一条**带 `memberId` 的派活（推断）；
 *   3. `messages` 里该票 `task_assignment` 的收件人（推断）。
 *
 * `ownerId === null` / `undefined` 才视为「缺失」，允许回填；空串是明确信号，不参与回填。
 */

import type {
  WorkbenchAssignment,
  WorkbenchMember,
  WorkbenchMessage,
  WorkbenchTicket,
} from "./agent-teams-swimlane";

export interface ResolvedTicketOwner {
  memberId: string | null;
  memberName: string | null;
  /** true = 负责人不是票上的显式 ownerId，而是由派活 / 消息回填推断。 */
  inferred: boolean;
}

/** 解析输入的票子集（运行时票与 plan 票的结构都满足）。 */
export type OwnableTicket = Pick<WorkbenchTicket, "id" | "ownerId" | "assignments">;

const UNASSIGNED: ResolvedTicketOwner = { memberId: null, memberName: null, inferred: false };

/** 身份别名：小写化后同时认全名与 `name@team` 的短名（发送方/收件方可能任一形态）。 */
function identityAliases(value: string | null | undefined): string[] {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return [];
  const short = normalized.split("@")[0] ?? normalized;
  return normalized === short ? [normalized] : [normalized, short];
}

/** 在名册里按 id / 姓名别名找到成员；找不到返回 undefined。 */
function matchMember(
  members: readonly WorkbenchMember[],
  identity: string | null | undefined,
): WorkbenchMember | undefined {
  const wanted = identityAliases(identity);
  if (wanted.length === 0) return undefined;
  return members.find((member) => {
    const own = [...identityAliases(member.id), ...identityAliases(member.name)];
    return wanted.some((alias) => own.includes(alias));
  });
}

/** 消息文本若是 JSON 对象且带字符串 type，返回该 type（兼容未投影 protocolType 的调用方）。 */
function protocolTypeOf(message: WorkbenchMessage): string | undefined {
  if (message.protocolType) return message.protocolType;
  const raw = (message.text ?? "").trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const type = (parsed as Record<string, unknown>).type;
    return typeof type === "string" && type.trim() ? type.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析票负责人。
 *
 * @param ticket   票（至少含 id / ownerId / assignments）。
 * @param members  团队成员名册（解析人的 id 与展示名）。
 * @param messages 通信流消息（回填派活收件人用；缺省视为无）。
 */
export function resolveTicketOwner(
  ticket: OwnableTicket,
  members: readonly WorkbenchMember[],
  messages: readonly WorkbenchMessage[] = [],
): ResolvedTicketOwner {
  const rawOwnerId = ticket.ownerId;

  // 1. 显式 ownerId（null/undefined = 缺失；空串 = 显式「未指派」，不回填）。
  if (rawOwnerId !== null && rawOwnerId !== undefined) {
    const explicit = rawOwnerId.trim();
    if (explicit === "") return { ...UNASSIGNED };
    const member = matchMember(members, explicit);
    return {
      memberId: member?.id ?? explicit,
      memberName: member?.name ?? explicit,
      inferred: false,
    };
  }

  // 2. assignments：最后一条带 memberId 的派活。
  for (let index = (ticket.assignments?.length ?? 0) - 1; index >= 0; index -= 1) {
    const assignment: WorkbenchAssignment | undefined = ticket.assignments[index];
    if (!assignment?.memberId) continue;
    const member = members.find((candidate) => candidate.id === assignment.memberId)
      ?? matchMember(members, assignment.memberId)
      ?? matchMember(members, assignment.assignee);
    return {
      memberId: member?.id ?? assignment.memberId,
      memberName: member?.name ?? (assignment.assignee || assignment.memberId),
      inferred: true,
    };
  }

  // 3. messages：该票最新一条 task_assignment 的收件人。
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.taskId !== ticket.id) continue;
    if (protocolTypeOf(message) !== "task_assignment") continue;
    const recipient = message.recipients?.[0] ?? message.to ?? "";
    const member = matchMember(members, recipient);
    const identity = member?.id ?? recipient.trim();
    if (!identity) continue;
    return {
      memberId: identity,
      memberName: member?.name ?? recipient.trim(),
      inferred: true,
    };
  }

  return { ...UNASSIGNED };
}
