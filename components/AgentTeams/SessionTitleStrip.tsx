"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { skillExpansionToCommand } from "@/lib/slash-display";
import type { SessionInfo } from "@/lib/types";

/**
 * 聊天区会话标题条（消息列表上方，与 GoalStrip / 团队条同处会话头部）。
 *
 * 顶栏标题在窄屏会被截断到 160px（`.app-topbar-title` 的 max-width 断点），
 * 会话头部是整宽，能把当前会话叫什么完整展示给用户。
 *
 * 只读展示 + 就地改名：点标题（或右侧铅笔）进入编辑，Enter/失焦保存，Esc 取消。
 * 保存走 `PATCH /api/sessions/[id] { name }`（空串清除自定义名，回落到首条消息）；
 * 成功后用 `onRenamed` 通知上层刷新列表。缺 `onRenamed` 时保持纯展示。
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
  /** 改名成功后的回调（刷新侧栏/选中会话）；缺省时标题只读。 */
  onRenamed?: (id: string, name: string) => void;
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
  editable: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: "var(--fw-semibold)",
    color: "var(--text)",
    cursor: "text",
    borderRadius: 4,
  },
  input: {
    minWidth: 0,
    flex: 1,
    font: "inherit",
    fontWeight: "var(--fw-semibold)",
    color: "var(--text)",
    background: "var(--bg)",
    border: "var(--hairline) solid var(--border)",
    borderRadius: 4,
    padding: "2px 6px",
  },
  action: {
    flexShrink: 0,
    border: "none",
    borderRadius: 4,
    padding: "2px 8px",
    fontSize: "var(--fs-micro)",
    fontWeight: "var(--fw-medium)",
    cursor: "pointer",
    background: "var(--bg-hover)",
    color: "var(--text)",
  },
  pencil: {
    flexShrink: 0,
    border: "none",
    background: "transparent",
    color: "var(--text-dim)",
    fontSize: "var(--fs-caption)",
    cursor: "pointer",
    padding: "0 2px",
  },
  error: {
    flexShrink: 0,
    color: "var(--danger)",
    fontSize: "var(--fs-micro)",
  },
};

export function SessionTitleStrip({ session, compact = false, onRenamed }: Props) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // set by Esc / Cancel so the input's blur handler does not save afterwards.
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // 与侧栏会话行同一口径：name → 折叠后的首条消息 → 未命名。
  const rawFirstMessage = session?.firstMessage ?? "";
  const displayFirstMessage = skillExpansionToCommand(rawFirstMessage) ?? rawFirstMessage;
  const storedName = session?.name ?? "";
  const fallback = (displayFirstMessage ?? "").trim();
  const title = storedName.trim() || fallback;

  const startEdit = useCallback(() => {
    if (!onRenamed || saving) return;
    setDraft(storedName);
    setError(null);
    setEditing(true);
  }, [onRenamed, saving, storedName]);

  const cancelEdit = useCallback(() => {
    cancelRef.current = true;
    setEditing(false);
    setError(null);
  }, []);

  const commit = useCallback(async () => {
    if (!session?.id || !onRenamed || saving) return;
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    const next = draft.trim();
    if (next === storedName.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setEditing(false);
      setError(null);
      onRenamed(session.id, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, onRenamed, saving, session?.id, storedName]);

  if (!session?.id) return null;

  return (
    <div
      data-testid="session-title-strip"
      style={{ ...S.bar, ...(compact ? S.barCompact : null) }}
    >
      <span style={S.label}>{t("chat.sessionTitle.label")}</span>
      {editing ? (
        <>
          <input
            ref={inputRef}
            data-testid="session-title-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEdit();
              }
            }}
            onBlur={() => void commit()}
            placeholder={t("chat.sessionTitle.renamePlaceholder")}
            aria-label={t("chat.sessionTitle.rename")}
            disabled={saving}
            style={S.input}
          />
          <button
            type="button"
            data-testid="session-title-save"
            style={S.action}
            disabled={saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void commit()}
          >
            {saving ? t("chat.sessionTitle.saving") : t("i18n.save")}
          </button>
          <button
            type="button"
            data-testid="session-title-cancel"
            style={S.action}
            disabled={saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancelEdit}
          >
            {t("i18n.cancel")}
          </button>
        </>
      ) : title ? (
        <span
          style={onRenamed ? S.editable : S.title}
          title={onRenamed ? t("chat.sessionTitle.renameHint") : title}
          onClick={onRenamed ? startEdit : undefined}
        >
          {title}
        </span>
      ) : (
        <span
          style={onRenamed ? { ...S.untitled, cursor: "text" } : S.untitled}
          title={onRenamed ? t("chat.sessionTitle.renameHint") : undefined}
          onClick={onRenamed ? startEdit : undefined}
        >
          {t("chat.untitledSession")}
        </span>
      )}
      {onRenamed && !editing ? (
        <button
          type="button"
          data-testid="session-title-rename"
          style={S.pencil}
          onClick={startEdit}
          title={t("chat.sessionTitle.renameHint")}
          aria-label={t("chat.sessionTitle.rename")}
        >
          ✎
        </button>
      ) : null}
      {error ? (
        <span role="alert" style={S.error} title={error}>
          {t("chat.sessionTitle.renameFailed")}
        </span>
      ) : null}
    </div>
  );
}
