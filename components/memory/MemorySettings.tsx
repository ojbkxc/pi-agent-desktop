"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigEmptyState } from "../SettingsUi";
import { ConfirmDangerButton } from "../ConfirmDangerButton";

/**
 * Settings › General：长期记忆（Phase alma-parity）。跨会话保存用户可见、可编辑的条目；
 * 模型通过 `memory` 工具读写，有记忆时由扩展注入 system prompt（见 lib/memory/extension.ts）。
 *
 * 自包含：数据全走 `/api/memory`，不依赖 SettingsPanel 的 props（插入位置由 integrator 决定）。
 * 服务端校验是唯一真源（非空、≤4 KB、≤200 条）；这里只做字节计数与空态/错误提示。
 * 本组件是客户端组件，**不要** import `lib/memory/store.ts`（含 node:fs），类型就地声明。
 */

export interface MemoryEntryView {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  sourceSessionId?: string;
}

/** 与服务端 store 的上限一致；只用于计数与禁用，不当作校验结论。 */
const MAX_TEXT_BYTES = 4096;
const MAX_TAGS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 一条记忆或 null；坏字段整条丢弃（列表接口的空洞不能把渲染打崩）。 */
export function asMemoryEntry(raw: unknown): MemoryEntryView | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.text !== "string") return null;
  return {
    id: raw.id,
    text: raw.text,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    ...(Array.isArray(raw.tags) ? { tags: raw.tags.filter((tag): tag is string => typeof tag === "string") } : {}),
    ...(typeof raw.sourceSessionId === "string" ? { sourceSessionId: raw.sourceSessionId } : {}),
  };
}

/** GET /api/memory 的载荷 → 条目数组；没有 entries 数组算失败（null）。 */
export function asMemoryEntries(raw: unknown): MemoryEntryView[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return null;
  return raw.entries.flatMap((entry) => {
    const parsed = asMemoryEntry(entry);
    return parsed ? [parsed] : [];
  });
}

/** 逗号（含中文逗号）分隔的标签草稿 → 数组。 */
export function parseTagDraft(draft: string): string[] {
  const seen: string[] = [];
  for (const part of draft.split(/[,，]/)) {
    const tag = part.trim();
    if (tag && !seen.includes(tag)) seen.push(tag);
  }
  return seen;
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

function formatUpdated(entry: MemoryEntryView): string {
  if (!entry.updatedAt) return "";
  const date = new Date(entry.updatedAt);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** 一行记忆：正文 + 标签 + 更新时间 + 编辑/删除；编辑态就地换成 textarea。 */
function MemoryRow({
  entry,
  busy,
  onSave,
  onDelete,
}: {
  entry: MemoryEntryView;
  busy: boolean;
  onSave: (patch: { text: string; tags: string[] }) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [tagsDraft, setTagsDraft] = useState((entry.tags ?? []).join(", "));
  const hintId = useId();
  const bytes = byteLength(draft);
  const tooLong = bytes > MAX_TEXT_BYTES;
  const tags = parseTagDraft(tagsDraft);
  const tagsOk = tags.length <= MAX_TAGS;
  const dirty = draft !== entry.text || tagsDraft !== (entry.tags ?? []).join(", ");

  const commit = async () => {
    if (!dirty) {
      setEditing(false);
      return;
    }
    if (await onSave({ text: draft, tags })) setEditing(false);
  };

  if (!editing) {
    return (
      <div className="settings-chat-option memory-row">
        <div className="memory-row-main">
          <p className="memory-row-text">{entry.text}</p>
          <div className="memory-row-meta">
            {(entry.tags ?? []).map((tag) => (
              <span key={tag} className="memory-tag">{tag}</span>
            ))}
            {formatUpdated(entry) && (
              <span className="memory-row-updated">{t("memory.updated", { date: formatUpdated(entry) })}</span>
            )}
          </div>
        </div>
        <div className="memory-row-actions">
          <ConfigButton
            size="small"
            disabled={busy}
            aria-label={t("memory.editLabel")}
            title={t("memory.editLabel")}
            onClick={() => {
              setDraft(entry.text);
              setTagsDraft((entry.tags ?? []).join(", "));
              setEditing(true);
            }}
          >
            {t("memory.edit")}
          </ConfigButton>
          <ConfirmDangerButton
            label={t("memory.delete")}
            busyLabel={t("i18n.saving")}
            busy={busy}
            className="config-button config-button-danger config-button-small"
            onConfirm={() => void onDelete()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-chat-option memory-row is-editing">
      <div className="settings-chats-field">
        <label htmlFor={`${hintId}-text`}>{t("memory.textLabel")}</label>
        <textarea
          id={`${hintId}-text`}
          className="settings-chats-control memory-edit-text"
          rows={3}
          value={draft}
          disabled={busy}
          aria-describedby={hintId}
          onChange={(event) => setDraft(event.target.value)}
        />
        <label htmlFor={`${hintId}-tags`}>{t("memory.tagsLabel")}</label>
        <input
          id={`${hintId}-tags`}
          className="settings-chats-control"
          value={tagsDraft}
          disabled={busy}
          placeholder={t("memory.tagsPlaceholder")}
          onChange={(event) => setTagsDraft(event.target.value)}
        />
        <span id={hintId} className="settings-chats-hint" role={tooLong || !tagsOk ? "alert" : undefined}>
          {tooLong
            ? t("memory.tooLong", { max: MAX_TEXT_BYTES })
            : !tagsOk
              ? t("memory.tooManyTags", { max: MAX_TAGS })
              : t("memory.byteCount", { count: bytes, max: MAX_TEXT_BYTES })}
        </span>
        <div className="memory-edit-actions">
          <ConfigButton
            variant="primary"
            size="small"
            disabled={busy || tooLong || !tagsOk || !draft.trim()}
            onClick={() => void commit()}
          >
            {busy ? t("i18n.saving") : t("i18n.save")}
          </ConfigButton>
          <ConfigButton size="small" disabled={busy} onClick={() => setEditing(false)}>
            {t("i18n.cancel")}
          </ConfigButton>
        </div>
      </div>
    </div>
  );
}

export function MemorySettings() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<MemoryEntryView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [tagsDraft, setTagsDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState<"load" | "add" | "save" | "delete" | null>(null);
  const addHintId = useId();
  const bytes = byteLength(draft);
  const tooLong = bytes > MAX_TEXT_BYTES;
  const tags = parseTagDraft(tagsDraft);
  const tagsOk = tags.length <= MAX_TAGS;
  const canAdd = draft.trim().length > 0 && !tooLong && tagsOk && !adding;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/memory", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: unknown) => {
        if (cancelled) return;
        const next = asMemoryEntries(data);
        if (!next) {
          setLoadFailed(true);
          setFailed("load");
          return;
        }
        setEntries(next);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setFailed("load");
      });
    return () => { cancelled = true; };
  }, []);

  const add = useCallback(async () => {
    if (!canAdd) return;
    setAdding(true);
    setFailed(null);
    try {
      const response = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft, tags }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as unknown;
      const entry = isRecord(data) ? asMemoryEntry(data.entry) : null;
      if (!entry) throw new Error("malformed response");
      setEntries((current) => [entry, ...(current ?? [])]);
      setDraft("");
      setTagsDraft("");
    } catch {
      setFailed("add");
    } finally {
      setAdding(false);
    }
  }, [canAdd, draft, tags]);

  const save = useCallback(async (id: string, patch: { text: string; tags: string[] }): Promise<boolean> => {
    setBusyId(id);
    setFailed(null);
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as unknown;
      const entry = isRecord(data) ? asMemoryEntry(data.entry) : null;
      if (!entry) throw new Error("malformed response");
      setEntries((current) => (current ?? []).map((item) => (item.id === id ? entry : item)));
      return true;
    } catch {
      setFailed("save");
      return false;
    } finally {
      setBusyId(null);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setBusyId(id);
    setFailed(null);
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setEntries((current) => (current ?? []).filter((item) => item.id !== id));
    } catch {
      setFailed("delete");
    } finally {
      setBusyId(null);
    }
  }, []);

  const failureText = failed === "load"
    ? t("memory.loadFailed")
    : failed === "add"
      ? t("memory.addFailed")
      : failed === "save"
        ? t("memory.saveFailed")
        : failed === "delete"
          ? t("memory.deleteFailed")
          : null;

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("memory.title")}</h3>
      <p className="settings-general-description">{t("memory.description")}</p>

      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chats-field">
          <label htmlFor="settings-memory-add">{t("memory.addLabel")}</label>
          <textarea
            id="settings-memory-add"
            className="settings-chats-control memory-edit-text"
            rows={3}
            value={draft}
            disabled={adding}
            placeholder={t("memory.addPlaceholder")}
            aria-describedby={addHintId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canAdd) {
                event.preventDefault();
                void add();
              }
            }}
          />
          <input
            className="settings-chats-control"
            value={tagsDraft}
            disabled={adding}
            placeholder={t("memory.tagsPlaceholder")}
            aria-label={t("memory.tagsLabel")}
            onChange={(event) => setTagsDraft(event.target.value)}
          />
          <div className="memory-add-row">
            <span id={addHintId} className="settings-chats-hint" role={tooLong || !tagsOk ? "alert" : undefined}>
              {tooLong
                ? t("memory.tooLong", { max: MAX_TEXT_BYTES })
                : !tagsOk
                  ? t("memory.tooManyTags", { max: MAX_TAGS })
                  : t("memory.byteCount", { count: bytes, max: MAX_TEXT_BYTES })}
            </span>
            <ConfigButton variant="primary" size="small" disabled={!canAdd} onClick={() => void add()}>
              {adding ? t("i18n.saving") : t("memory.add")}
            </ConfigButton>
          </div>
        </div>

        {entries === null
          ? !loadFailed && (
            <div className="settings-chat-option">
              <span className="settings-chats-hint">{t("memory.loading")}</span>
            </div>
          )
          : entries.length === 0
            ? (
              <div className="settings-chat-option">
                <ConfigEmptyState>{t("memory.empty")}</ConfigEmptyState>
              </div>
            )
            : entries.map((entry) => (
              <MemoryRow
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                onSave={(patch) => save(entry.id, patch)}
                onDelete={() => remove(entry.id)}
              />
            ))}
      </div>

      <span className="settings-chats-hint memory-status" role={failureText ? "alert" : "status"}>
        {failureText ?? t("memory.injectHint")}
      </span>
    </section>
  );
}