"use client";

import { memo, useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useProgressiveReveal } from "@/hooks/useProgressiveReveal";
import { useTranscriptFind } from "@/hooks/useTranscriptFind";
import type { TeamWorkbenchSnapshot, WorkbenchMember, WorkbenchMessage } from "@/lib/agent-teams-swimlane";
import type { TranslationParams } from "@/lib/i18n/types";

type TranslationFn = (key: string, params?: TranslationParams) => string;
type FeedCategory = "assignment" | "peer" | "report" | "system";
type FeedFilter = "all" | FeedCategory;

/** 正文超过这个字符数就折叠到「展开」按钮之后（对齐 cc-haha）。 */
const COLLAPSED_BODY_CHARS = 260;

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

/** 成员组内配色名 → 主题色变量（与 native-theme.css 的 --*-accent 同源）。 */
const COLOR_VARS: Record<string, string> = {
  blue: "var(--info)",
  green: "var(--success)",
  purple: "var(--accent)",
  orange: "var(--warning)",
  teal: "var(--info)",
  pink: "var(--accent)",
  red: "var(--danger)",
  gray: "var(--text-dim)",
};

// ─────────────────────────────────────────────────────────────────────────────
// 模型：身份解析 / 正文解析 / 分类（全部自包含，纯函数）
// ─────────────────────────────────────────────────────────────────────────────

/** 身份别名：小写化后同时认全名与 `name@team` 的短名（发送方可能是任一形态）。 */
function identityAliases(value: string): string[] {
  const normalized = (value ?? "").trim().toLowerCase();
  const short = normalized.split("@")[0] ?? normalized;
  return normalized === short ? [normalized] : [normalized, short];
}

/** 在本仓的 snapshot 里解析成员身份（成员在 snapshot.members，lead 由 isLead 字段标记）。 */
function resolveMember(
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

function isLeadIdentity(value: string, snapshot: TeamWorkbenchSnapshot): boolean {
  if (!value || value === "*") return false;
  return resolveMember(snapshot, value).isLead;
}

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
type MessageBody =
  | { kind: "text"; text: string }
  | { kind: "assignment"; taskId?: string; subject?: string; selfClaim: boolean }
  | { kind: "lifecycle"; type: string; detail?: string };

/**
 * 解析正文（移植 cc-haha parseWorkbenchMessageBody）：协议载荷用句子叙述而非原样倾倒
 * JSON。结构化 type 由投影层直通到 `message.protocolType`，文本仍可能是原始 JSON。
 */
function parseMessageBody(message: WorkbenchMessage): MessageBody {
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

/**
 * 4 分类判据（移植 cc-haha classifyMessage）：按 from/to/recipients 是否 lead 与 kind
 * （broadcast/direct）推导，而非 CLI 传输 kind。
 * - assignment：lead 派给成员，或解析出非自领的派工信封；
 * - report：成员发给 lead，或非 lead 的广播；
 * - peer：成员之间的直接消息；
 * - system：生命周期 / 协议消息 / 自领 / 无法归类的路由。
 */
function classifyMessage(
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

type ParsedRow = { message: WorkbenchMessage; body: MessageBody; category: FeedCategory };
type VisibleRow = ParsedRow & { repeats: number };

function categoryLabel(category: FeedCategory, t: TranslationFn): string {
  if (category === "assignment") return t("teams.communication.assignment");
  if (category === "peer") return t("teams.communication.peer");
  if (category === "report") return t("teams.communication.report");
  return t("teams.communication.system");
}

/** 分类强调色（静态块用 Tailwind 变量类，动态色走这里）。 */
function categoryAccent(category: FeedCategory): string {
  if (category === "assignment") return "var(--info)";
  if (category === "peer") return "var(--accent)";
  if (category === "system") return "var(--text-dim)";
  return "var(--text-muted)";
}

/** 分类标签的浅底样式（inline，避免依赖本仓没有的 --color-* 令牌）。 */
function categoryTagStyle(category: FeedCategory): CSSProperties {
  const accent = categoryAccent(category);
  return {
    color: accent,
    borderColor: accent,
    backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)",
  };
}

function lifecycleNarration(body: Extract<MessageBody, { kind: "lifecycle" }>, t: TranslationFn): string {
  const narration = t(`teams.communication.lifecycle.${body.type}`);
  return body.detail ? `${narration} · ${body.detail}` : narration;
}

/** 「领活」与「被派活」是不同事件，叙述也不同。 */
function assignmentNarration(
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

function readableSystemText(body: Extract<MessageBody, { kind: "text" }>, t: TranslationFn): string {
  const text = body.text.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return text;
  return t("teams.communication.system");
}

function rowDisplayText(
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
function isCompactRow(body: MessageBody, category: FeedCategory): boolean {
  return body.kind !== "text" || category === "system";
}

/** 一行按屏上顺序展示的文本，供「未挂载行」的查找。 */
function feedRowFindText({ message, body, category }: VisibleRow, t: TranslationFn): string {
  const text = rowDisplayText(message, body, category, t);
  const task = message.taskId ? `#${message.taskId}` : "";
  const time = formatMessageTime(message.timestamp);
  if (isCompactRow(body, category)) return [categoryLabel(category, t), text, task, time].join("\n");
  const recipient = message.kind === "broadcast" ? t("teams.communication.everyone") : message.to;
  return [categoryLabel(category, t), task, time, message.from, recipient, text].join("\n");
}

/** 消息发送的墙钟时刻（本地 HH:MM）。 */
function formatMessageTime(timestamp: string): string {
  const time = new Date(timestamp);
  return Number.isNaN(time.getTime())
    ? ""
    : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 成员头像字：取名称首字符，拉丁首字母大写；空名回退 "?"。 */
function initialOf(name: string): string {
  const trimmed = (name ?? "").trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

function memberAccent(color: string | undefined): string {
  return (color && COLOR_VARS[color]) ?? "var(--text-dim)";
}

// ─────────────────────────────────────────────────────────────────────────────
// 图标（本仓无 lucide，内联 SVG）
// ─────────────────────────────────────────────────────────────────────────────

function Icon({ path, size = 12 }: { path: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

const MegaphoneIcon = (
  <Icon path={<><path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /></>} />
);
const MessageIcon = <Icon path={<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />} />;
const SettingsIcon = (
  <Icon path={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>} />
);
const ArrowRightIcon = <Icon path={<><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>} />;

function transportIcon(kind: WorkbenchMessage["kind"]) {
  if (kind === "broadcast") return MegaphoneIcon;
  if (kind === "direct") return MessageIcon;
  return SettingsIcon;
}

// ─────────────────────────────────────────────────────────────────────────────
// 参与方头像（本仓无 PNG 头像资源，用首字圆 + 强调色下划线，与会话团队条一致）
// ─────────────────────────────────────────────────────────────────────────────

type Participant = { name: string; initial: string; accent: string };

function resolveParticipant(value: string, snapshot: TeamWorkbenchSnapshot): Participant {
  const { member } = resolveMember(snapshot, value);
  return {
    name: value,
    initial: initialOf(member?.name ?? value),
    accent: member ? memberAccent(member.color) : "var(--text-dim)",
  };
}

function ParticipantFigure({
  participant,
  name,
  nameTestId,
  avatarTestId,
}: {
  participant: Participant;
  name: string;
  nameTestId: string;
  avatarTestId: string;
}) {
  return (
    <span className="inline-flex min-w-0 flex-1 items-center gap-1.5" title={name}>
      <span
        data-testid={avatarTestId}
        aria-hidden="true"
        className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--tool-bg)] text-[11px] font-semibold text-[var(--text)]"
        style={{ boxShadow: `inset 0 -2px 0 ${participant.accent}` }}
      >
        {participant.initial}
      </span>
      <span data-testid={nameTestId} className="min-w-0 truncate font-mono text-[11px] font-medium text-[var(--text-muted)]">
        {name}
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 组件
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  snapshot: TeamWorkbenchSnapshot;
  /** 整高布局：让 feed 占据自己的列而不是固定高度条。 */
  fill?: boolean;
  /** 悬停某行时点亮画布上对应任务（复用其 focus 通道）。 */
  onFocusTask?: (taskId: string | null) => void;
}

/**
 * 团队通信流（C6，对齐 cc-haha 的 AgentTeamsCommunicationFeed）。
 *
 * - 4 分类（派工/同侪/汇报/系统）+ 5 过滤器（全部 + 4 类，各带计数）；
 * - 相邻同类生命周期消息折叠为一条并计 `×N`（成员空转每几秒重复同一提示）；
 * - 两种行渲染：紧凑行（系统/协议）与完整行（发送者→接收者 + Markdown 正文，>260 字折叠）；
 * - 最新一条左侧蓝色竖条；
 * - 悬停行 → `onFocusTask(taskId)` 通知父级高亮画布对应任务（离开 → null）；
 * - 空态文案。
 */
export function AgentTeamsCommunicationFeed({ snapshot, fill = false, onFocusTask }: Props) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<FeedFilter>("all");

  const rows = useMemo(
    () => snapshot.messages
      .map((message): ParsedRow => {
        const body = parseMessageBody(message);
        return { message, body, category: classifyMessage(message, body, snapshot) };
      })
      .reverse(),
    [snapshot],
  );
  const categoryCounts = useMemo(() => rows.reduce<Record<FeedCategory, number>>(
    (counts, row) => {
      counts[row.category] += 1;
      return counts;
    },
    { assignment: 0, peer: 0, report: 0, system: 0 },
  ), [rows]);

  const filters: Array<{ key: FeedFilter; label: string; count: number }> = [
    { key: "all", label: t("teams.communication.all"), count: rows.length },
    { key: "assignment", label: categoryLabel("assignment", t), count: categoryCounts.assignment },
    { key: "peer", label: categoryLabel("peer", t), count: categoryCounts.peer },
    { key: "report", label: categoryLabel("report", t), count: categoryCounts.report },
    { key: "system", label: categoryLabel("system", t), count: categoryCounts.system },
  ];

  const filteredRows = useMemo(
    () => (filter === "all" ? rows : rows.filter(({ category }) => category === filter)),
    [filter, rows],
  );

  // 等待工作的成员每几秒就重复同一条空闲提示：保留最新一条，把相邻重复折叠成它的重复计数。
  const visibleRows = useMemo(() => {
    const collapsed: VisibleRow[] = [];
    for (const row of filteredRows) {
      const previous = collapsed[collapsed.length - 1];
      if (
        previous
        && previous.body.kind === "lifecycle"
        && row.body.kind === "lifecycle"
        && previous.body.type === row.body.type
        && previous.message.from === row.message.from
      ) {
        previous.repeats += 1;
        continue;
      }
      collapsed.push({ ...row, repeats: 1 });
    }
    return collapsed;
  }, [filteredRows]);

  const reveal = useProgressiveReveal(visibleRows.length, filter);
  const mountedRows = visibleRows.slice(0, reveal.limit);
  useTranscriptFind({
    rows: visibleRows,
    rowKey: (row) => row.message.id,
    rowText: (row) => feedRowFindText(row, t),
    revealThrough: reveal.revealThrough,
    anchorRef: reveal.scrollRootRef,
  });

  return (
    <section
      data-testid="agent-teams-communication"
      className={[
        "flex min-h-0 flex-col border-[var(--separator)] bg-[var(--bg)]",
        fill ? "h-full w-full min-w-0" : "h-[240px] shrink-0 border-t",
      ].join(" ")}
    >
      <div className="shrink-0 border-b border-[var(--separator)] px-3.5 py-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="text-[15px] font-semibold tracking-[-0.2px] text-[var(--text)]">
            {t("teams.communication.title")}
          </h3>
          <span
            data-testid="agent-teams-message-count"
            className="font-mono text-[12px] tabular-nums text-[var(--text-dim)]"
          >
            {t("teams.communication.count", { count: rows.length })}
          </span>
        </div>

        <div
          role="group"
          aria-label={t("teams.communication.title")}
          className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5"
        >
          {filters.map((option) => {
            const selected = filter === option.key;
            return (
              <button
                key={option.key}
                type="button"
                data-testid={`agent-teams-filter-${option.key}`}
                data-count={option.count}
                aria-pressed={selected}
                onClick={() => setFilter(option.key)}
                className={[
                  "inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors outline-none",
                  selected
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
                    : "border-[var(--separator)] bg-[var(--bg-panel)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]",
                ].join(" ")}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={reveal.scrollRootRef} className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.length === 0 ? (
          <div
            data-testid="agent-teams-empty"
            className="flex min-h-28 items-center justify-center px-6 text-center text-[11px] leading-5 text-[var(--text-dim)]"
          >
            {t("teams.communication.empty")}
          </div>
        ) : (
          <div data-find-transcript="" className="divide-y divide-[var(--separator)]">
            {mountedRows.map(({ message, body, category, repeats }, index) => (
              <FeedRow
                key={message.id}
                message={message}
                body={body}
                category={category}
                repeats={repeats}
                isLatest={index === 0}
                snapshot={snapshot}
                onFocusTask={onFocusTask}
                t={t}
              />
            ))}
          </div>
        )}
        {reveal.hasMore && (
          <div className="flex justify-center px-3.5 py-2">
            {reveal.canAutoReveal ? (
              <div ref={reveal.sentinelRef} data-testid="agent-teams-reveal-sentinel" aria-hidden="true" className="h-px" />
            ) : (
              <button
                type="button"
                onClick={reveal.showMore}
                className="rounded-full border border-[var(--separator)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
              >
                {t("teams.communication.showEarlier", { count: visibleRows.length - mountedRows.length })}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 记忆化：工作台每秒一次的时钟与画布悬停焦点会让本 feed 重渲染但不改快照，
 * 已挂载的行保持不动。
 */
const FeedRow = memo(function FeedRow({
  message,
  body,
  category,
  repeats,
  isLatest,
  snapshot,
  onFocusTask,
  t,
}: {
  message: WorkbenchMessage;
  body: MessageBody;
  category: FeedCategory;
  /** 这一条代表了多少条连续相同的信号。 */
  repeats: number;
  isLatest: boolean;
  snapshot: TeamWorkbenchSnapshot;
  onFocusTask?: (taskId: string | null) => void;
  t: TranslationFn;
}) {
  const [expanded, setExpanded] = useState(false);
  const focusedTaskId = (body.kind === "assignment" ? body.taskId : undefined) ?? message.taskId;
  const time = formatMessageTime(message.timestamp);
  const text = rowDisplayText(message, body, category, t);
  const compact = isCompactRow(body, category);
  const rowProps = {
    "data-testid": `agent-teams-message-${message.id}`,
    "data-find-row": message.id,
    "data-message-body": body.kind,
    "data-message-kind": message.kind,
    "data-message-category": category,
    onMouseEnter: focusedTaskId ? () => onFocusTask?.(focusedTaskId) : undefined,
    onMouseLeave: focusedTaskId ? () => onFocusTask?.(null) : undefined,
  };

  if (compact) {
    return (
      <article {...rowProps} className="bg-[var(--bg-panel)] px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: categoryAccent(category) }}
            aria-hidden="true"
          />
          <span className="shrink-0 text-[11px] font-semibold" style={{ color: categoryAccent(category) }}>
            {categoryLabel(category, t)}
          </span>
          <p
            data-testid={`agent-teams-message-${message.id}-body`}
            className="min-w-0 flex-1 truncate text-xs leading-[1.4] text-[var(--text-muted)]"
            title={text}
          >
            {text}
          </p>
          {message.taskId ? (
            <span className="shrink-0 rounded-full bg-[var(--tool-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-dim)]">
              #{message.taskId}
            </span>
          ) : null}
          {repeats > 1 ? (
            <span
              data-testid={`agent-teams-message-${message.id}-repeats`}
              className="shrink-0 rounded-full bg-[var(--tool-bg)] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-[var(--text-dim)]"
            >
              ×{repeats}
            </span>
          ) : null}
          <time dateTime={message.timestamp} className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
            {time}
          </time>
        </div>
      </article>
    );
  }

  const isTruncatable = text.length > COLLAPSED_BODY_CHARS;
  const collapsed = isTruncatable && !expanded;
  const recipient = message.kind === "broadcast" ? t("teams.communication.everyone") : message.to;
  const senderParticipant = resolveParticipant(message.from, snapshot);
  const recipientParticipant = message.kind === "direct" ? resolveParticipant(message.to, snapshot) : null;

  return (
    <article {...rowProps} className="relative px-3.5 py-3">
      {isLatest ? (
        <span
          className="absolute bottom-3 left-0 top-3 w-0.5 rounded-r-full bg-[var(--info)]"
          aria-hidden="true"
        />
      ) : null}

      <div className="flex min-w-0 items-center gap-2">
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
          style={categoryTagStyle(category)}
        >
          {transportIcon(message.kind)}
          {categoryLabel(category, t)}
        </span>
        {message.taskId ? (
          <span className="shrink-0 rounded-full bg-[var(--tool-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-dim)]">
            #{message.taskId}
          </span>
        ) : null}
        <time
          dateTime={message.timestamp}
          className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-dim)]"
        >
          {time}
        </time>
      </div>

      <div data-testid={`agent-teams-message-${message.id}-route`} className="mt-1.5 flex min-w-0 items-center gap-1.5">
        <ParticipantFigure
          participant={senderParticipant}
          name={message.from}
          nameTestId={`agent-teams-message-${message.id}-from`}
          avatarTestId={`agent-teams-message-${message.id}-from-avatar`}
        />
        <span className="shrink-0 text-[var(--text-dim)]">{ArrowRightIcon}</span>
        {recipientParticipant ? (
          <ParticipantFigure
            participant={recipientParticipant}
            name={recipient}
            nameTestId={`agent-teams-message-${message.id}-to`}
            avatarTestId={`agent-teams-message-${message.id}-to-avatar`}
          />
        ) : (
          <span
            data-testid={`agent-teams-message-${message.id}-to`}
            className="inline-flex min-w-0 flex-1 items-center gap-1.5"
            title={recipient}
          >
            <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--tool-bg)] text-[var(--text-muted)]">
              {MegaphoneIcon}
            </span>
            <span className="min-w-0 truncate font-mono text-[11px] font-medium text-[var(--text-muted)]">
              {recipient}
            </span>
          </span>
        )}
      </div>

      <div
        data-testid={`agent-teams-message-${message.id}-body`}
        data-collapsed={collapsed ? "true" : "false"}
        className="relative mt-[7px] text-[13px] leading-[1.55]"
      >
        <div className={collapsed ? "max-h-[148px] overflow-hidden" : ""}>
          <MarkdownBody className="text-[13px] leading-[1.55]">{text}</MarkdownBody>
        </div>
        {collapsed ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-[var(--bg)]"
          />
        ) : null}
      </div>

      {isTruncatable ? (
        <button
          type="button"
          data-testid={`agent-teams-message-${message.id}-toggle`}
          onClick={() => setExpanded((current) => !current)}
          className="relative mt-2 text-[11px] font-medium text-[var(--accent)] outline-none hover:underline"
        >
          {t(expanded ? "teams.communication.collapse" : "teams.communication.expand")}
        </button>
      ) : null}
    </article>
  );
});
