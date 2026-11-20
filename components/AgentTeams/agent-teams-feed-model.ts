/**
 * 团队通信流（C6）的纯模型层：身份解析 / 正文解析 / 分类 / 叙述。
 *
 * 从 AgentTeamsCommunicationFeed.tsx 抽出，行为逐字保持一致（移植 cc-haha 的
 * parseWorkbenchMessageBody / classifyMessage 等）。组件只留渲染与私有样式函数
 * （categoryAccent / categoryTagStyle / 图标）；这里全部是无 React 依赖的纯函数，
 * 便于单独做单测。
 */
import type { TeamWorkbenchSnapshot, WorkbenchMember, WorkbenchMessage } from "@/lib/agent-teams-swimlane";
import type { TranslationParams } from "@/lib/i18n/types";

export type TranslationFn = (key: string, params?: TranslationParams) => string;
export type FeedCategory = "assignment" | "peer" | "report" | "system";

/**
 * 结构化协议里「用一句话叙述」的类型（cc-haha NARRATED_PROTOCOL_TYPES 的本仓复刻：
 * AGENT_LIFECYCLE_TYPES + shutdown_response）。task_assignment 刻意不在此列——它记录
 * 「有活被领走」，是团队一切工作的前半段，归入生命周期会把它藏进折叠里，
 * 反而让刚派完活的团队显示「0 条消息」。
 */
const NARRATED_PROTOCOL_TYPES = new Set([
  "shutdown_approved",
  "shutdown_rejected",
  "shutdown_request",
  "teammate_terminated",
  "idle_notification",
  "shutdown_response",
]);

const LIFECYCLE_DETAIL_FIELDS = ["idleReason", "reason", "detail", "message"] as const;
const READABLE_BODY_FIELDS = ["message", "content", "text", "summary", "reason"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 身份解析
// ─────────────────────────────────────────────────────────────────────────────

/** 身份别名：小写化后同时认全名与 `name@team` 的短名（发送方可能是任一形态）。 */
export function identityAliases(value: string): string[] {
  const normalized = (value ?? "").trim().toLowerCase();
  const short = normalized.split("@")[0] ?? normalized;
  return normalized === short ? [normalized] : [normalized, short];
}

/** 在本仓的 snapshot 里解析成员身份（成员在 snapshot.members，lead 由 isLead 字段标记）。 */
export function resolveMember(
  snapshot: TeamWorkbenchSnapshot,
  value: string,
): { member: WorkbenchMember | null; isLead: boolean } {
  const aliases = identityAliases(value);
  const member = snapshot.members.find((candidate) => {
    const candidateAliases = [...identityAliases(candidate.id), ...identityAliases(candidate.name)];
    return aliases.some((alias) => candidateAliases.includes(alias));
  }) ?? null;
  const isLead = aliases.includes("team-lead") || Boolean(member?.isLead);
  return { member, isLead };
}

export function isLeadIdentity(value: string, snapshot: TeamWorkbenchSnapshot): boolean {
  if (!value || value === "*") return false;
  return resolveMember(snapshot, value).isLead;
}

// ─────────────────────────────────────────────────────────────────────────────
// 正文解析
// ─────────────────────────────────────────────────────────────────────────────

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 一条消息的正文：作者文本、派工信封、或协议生命周期信号。 */
export type MessageBody =
  | { kind: "text"; text: string }
  | { kind: "assignment"; taskId?: string; subject?: string; selfClaim: boolean }
  | { kind: "lifecycle"; type: string; detail?: string };

/**
 * 解析正文（移植 cc-haha parseWorkbenchMessageBody）：协议载荷用句子叙述而非原样倾倒
 * JSON。结构化 type 由投影层直通到 `message.protocolType`，文本仍可能是原始 JSON。
 */
export function parseMessageBody(message: WorkbenchMessage): MessageBody {
  const raw = message.text?.trim() ?? "";
  const senderAliases = identityAliases(message.from);
  const selfClaim = Boolean(
    message.recipients.some((recipient) => identityAliases(recipient).some((alias) => senderAliases.includes(alias))),
  );
  const payload = parseJsonObject(raw);
  const payloadType = typeof payload?.type === "string" ? payload.type : undefined;
  const type = message.protocolType ?? payloadType;

  if (type === "task_assignment") {
    // 自己领下一张活 = 信封寄给自己；被派活 = 信封寄给自己以外的人。
    const structuredSubject = payloadType === "task_assignment" && typeof payload?.subject === "string"
      ? payload.subject.trim()
      : "";
    const subject = structuredSubject || (
      message.protocolType === "task_assignment" && payloadType !== "task_assignment" ? raw : ""
    );
    return {
      kind: "assignment",
      selfClaim,
      ...(typeof payload?.taskId === "string" ? { taskId: payload.taskId } : {}),
      ...(subject ? { subject } : {}),
    };
  }

  if (type && NARRATED_PROTOCOL_TYPES.has(type)) {
    return {
      kind: "lifecycle",
      type,
      ...(payload ? { detail: firstNonEmptyString(payload, LIFECYCLE_DETAIL_FIELDS) } : {}),
    };
  }

  // 无法识别的 JSON 载荷仍胜过裸露的花括号：透出真正承载文案的字段，都没有才回退原文。
  if (payload) {
    return { kind: "text", text: firstNonEmptyString(payload, READABLE_BODY_FIELDS) ?? raw };
  }
  return { kind: "text", text: raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// 分类
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 4 分类判据（移植 cc-haha classifyMessage）：按 from/to/recipients 是否 lead 与 kind
 * （broadcast/direct）推导，而非 CLI 传输 kind。
 * - assignment：lead 派给成员，或解析出非自领的派工信封；
 * - report：成员发给 lead，或非 lead 的广播；
 * - peer：成员之间的直接消息；
 * - system：生命周期 / 协议消息 / 自领 / 无法归类的路由。
 */
export function classifyMessage(
  message: WorkbenchMessage,
  body: MessageBody,
  snapshot: TeamWorkbenchSnapshot,
): FeedCategory {
  if (body.kind === "assignment") return body.selfClaim ? "system" : "assignment";
  if (body.kind === "lifecycle") return "system";
  if (message.protocolType || message.kind === "system") return "system";

  const senderIsLead = isLeadIdentity(message.from, snapshot);
  if (message.kind === "broadcast") return senderIsLead ? "assignment" : "report";

  const recipients = Array.from(new Set([message.to, ...message.recipients])).filter(Boolean);
  const targetsLead = recipients.some((recipient) => isLeadIdentity(recipient, snapshot));
  const targetsMember = recipients.some((recipient) => !isLeadIdentity(recipient, snapshot));

  if (senderIsLead && targetsMember) return "assignment";
  if (!senderIsLead && targetsLead) return "report";
  if (message.kind === "direct") return "peer";
  return "system";
}

export type ParsedRow = { message: WorkbenchMessage; body: MessageBody; category: FeedCategory };
export type VisibleRow = ParsedRow & { repeats: number };

// ─────────────────────────────────────────────────────────────────────────────
// 叙述 / 展示文本
// ─────────────────────────────────────────────────────────────────────────────

export function lifecycleNarration(body: Extract<MessageBody, { kind: "lifecycle" }>, t: TranslationFn): string {
  const narration = t(`teams.communication.lifecycle.${body.type}`);
  return body.detail ? `${narration} · ${body.detail}` : narration;
}

/** 「领活」与「被派活」是不同事件，叙述也不同。 */
export function assignmentNarration(
  body: Extract<MessageBody, { kind: "assignment" }>,
  message: WorkbenchMessage,
  t: TranslationFn,
): string {
  const taskId = body.taskId ?? message.taskId;
  return t(body.selfClaim ? "teams.communication.taskClaimed" : "teams.communication.taskAssignment", {
    task: taskId ? `#${taskId}` : "",
    subject: body.subject ?? "",
    name: body.selfClaim ? message.from : (message.recipients[0] ?? message.to),
  });
}

export function readableSystemText(body: Extract<MessageBody, { kind: "text" }>, t: TranslationFn): string {
  const text = body.text.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return text;
  return t("teams.communication.system");
}

export function rowDisplayText(
  message: WorkbenchMessage,
  body: MessageBody,
  category: FeedCategory,
  t: TranslationFn,
): string {
  if (body.kind === "lifecycle") return lifecycleNarration(body, t);
  if (body.kind === "assignment") return assignmentNarration(body, message, t);
  return category === "system" ? readableSystemText(body, t) : body.text;
}

/** 协议通知与系统文本单行显示；作者写的消息给整卡。 */
export function isCompactRow(body: MessageBody, category: FeedCategory): boolean {
  return body.kind !== "text" || category === "system";
}
