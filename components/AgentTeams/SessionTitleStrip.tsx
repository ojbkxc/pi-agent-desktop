"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { skillExpansionToCommand } from "@/lib/slash-display";
import type { SessionInfo } from "@/lib/types";

/**
 * 聊天区会话标题条（消息列表上方，与 GoalStrip / 团队条同处会话头部）。
 *
 * 顶栏标题在窄屏会被截断到 160px（`.app-topbar-title` 的 max-width 断点），
 * 会话头部是整宽，能把当前会话叫什么完整展示给用户。
 *
 * 只读展示：改名仍走侧栏会话行的 rename（PATCH），这里不重复做编辑入口。
 * 标题口径与侧栏/顶栏一致：`name || 首条消息 || 会话 id`，首条消息先经
 * `skillExpansionToCommand` 折叠回 `/skill:name` 命令；无 name 用
 * `chat.untitledSession` 兜底标签，避免把裸 id 当标题展示。
 *
 * 样式内联 + 主题变量，与 GoalStrip 同款（不新增全局类）。
 */
interface Props {
  /** 当前会话；新会话（尚无 id）传 null → 不渲染。 */
  session?: Pick<SessionInfo, "id" | "name" | "firstMessage"> | null;
  /** 窄屏紧凑档：字号降一级。 */
  compact?: boolean;
}

const S: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    maxWidth: "100%",
    minWidth: 0,
    marginBottom: 8,
    padding: "6px 10px",
    border: "var(--hairline) solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--bg-panel)",
    fontSize: "var(--fs-caption)",
  },
  barCompact: { fontSize: "var(--fs-micro)" },
  label: {
    flexShrink: 0,
    color: "var(--text-dim)",
    fontSize: "var(--fs-micro)",
    fontWeight: "var(--fw-medium)",
    letterSpacing: "0.02em",
  },
  title: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: "var(--fw-semibold)",
    color: "var(--text)",
  },
  untitled: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontStyle: "italic",
    color: "var(--text-muted)",
  },
};

export function SessionTitleStrip({ session, compact = false }: Props) {
  const { t } = useI18n();
  if (!session?.id) return null;

  // 与侧栏会话行同一口径：name → 折叠后的首条消息 → 未命名。
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const name = session.name?.trim();
  const fallback = (displayFirstMessage ?? "").trim();
  const title = name || fallback;

  return (
    <div
      data-testid="session-title-strip"
      style={{ ...S.bar, ...(compact ? S.barCompact : null) }}
    >
      <span style={S.label}>{t("chat.sessionTitle.label")}</span>
      {title ? (
        <span style={S.title} title={title}>{title}</span>
      ) : (
        <span style={S.untitled}>{t("chat.untitledSession")}</span>
      )}
    </div>
  );
}
