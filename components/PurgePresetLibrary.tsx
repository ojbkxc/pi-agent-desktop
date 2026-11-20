"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TranslationParams } from "@/lib/i18n/types";
import { ConfigButton } from "./SettingsUi";

/**
 * The armored-prompt preset library: browse a built-in collection of third-party
 * prompt files, read one, and drop it onto one of the gateway's two live targets.
 *
 * The bodies are the upstream research collection **verbatim** — this component
 * never rewrites, filters or truncates them (only the list preview is cut, and
 * it says so with a trailing ellipsis). The compliance notice on top is always
 * visible, never a dismissible toast.
 *
 * The wire contract is the `/api/purge/presets` family:
 *
 * - `GET  /api/purge/presets?q=&vendor=&limit=` → `{ items, vendors, total }`
 * - `GET  /api/purge/presets/:id`               → the detail, with the full body
 * - `POST /api/purge/presets/:id/apply`         → `{ result: { target, changed, template?, path? }, settings }`
 *
 * Declared here rather than imported so the browser bundle never pulls a server
 * module; the two copies are locked together by the component test.
 */

/** One list row: metadata plus a cut preview, never the full body. */
export interface PurgePresetBrief {
  id: string;
  vendor: string;
  model: string;
  title: string;
  tags: string[];
  /** Body length in UTF-8 bytes. */
  bytes: number;
  /** Lowercase hex sha256 of the body. */
  sha256: string;
  /** First `PRESET_PREVIEW_CHARS` characters of the body. */
  preview: string;
}

/** Vendor chip: a count of the rows that survived the current filter. */
export interface PurgePresetVendorCount {
  vendor: string;
  count: number;
}

/** `GET /api/purge/presets` body. */
export interface PurgePresetList {
  items: PurgePresetBrief[];
  vendors: PurgePresetVendorCount[];
  /** Total after filtering; `items` is already cut to the limit. */
  total: number;
}

/** `GET /api/purge/presets/:id` body: the same row plus the full text. */
export interface PurgePresetDetail {
  id: string;
  vendor: string;
  model: string;
  title: string;
  tags: string[];
  bytes: number;
  sha256: string;
  preview: string;
  body: string;
}

/** Where a preset lands. `structured_template` edits the draft; `skill_file` writes disk. */
export type PurgePresetApplyTarget = "structured_template" | "skill_file";

export const PURGE_PRESET_TARGETS: readonly PurgePresetApplyTarget[] = [
  "structured_template",
  "skill_file",
];

/**
 * `POST /api/purge/presets/:id/apply`: the normalized result the panel renders.
 *
 * The server answers `{ result, settings }`; `name` is the server's `template`
 * (structured templates are identified by name) and is empty for a skill write.
 */
export interface PurgePresetApplyResult {
  applied: {
    /** Echoes the request target. */
    target: string;
    /** Template name or skill name. */
    name: string;
    /** Written path; only `skill_file` has one. */
    path: string | null;
  };
}

/** Base path of the preset family. */
export const PRESET_LIST_PATH = "/api/purge/presets";

/** Search debounce; typing `glm` must not cost three round trips. */
export const PRESET_SEARCH_DEBOUNCE_MS = 250;

/** The server's default page size, and its hard ceiling. */
export const PRESET_DEFAULT_LIMIT = 50;
export const PRESET_MAX_LIMIT = 500;

/** Characters kept in the list preview (not bytes — a multi-byte cut would split a character). */
export const PRESET_PREVIEW_CHARS = 200;

/**
 * Every message key the panel renders. The status line picks its key at runtime
 * (`t(status.key)`), so this list — not the JSX — is what the test walks to prove
 * all three language packs carry the copy.
 */
export const PURGE_PRESET_MESSAGE_KEYS = [
  "purge.presetsHeading",
  "purge.presetsNotice",
  "purge.presetsSearch",
  "purge.presetsSearchAria",
  "purge.presetsTotal",
  "purge.presetsAllVendors",
  "purge.presetsFilterAria",
  "purge.presetsLoading",
  "purge.presetsEmpty",
  "purge.presetsListFailed",
  "purge.presetsDetailFailed",
  "purge.presetsPreviewAria",
  "purge.presetsApplyTemplate",
  "purge.presetsApplySkill",
  "purge.presetsCopy",
  "purge.presetsBusy",
  "purge.presetsTemplateDone",
  "purge.presetsTemplateFailed",
  "purge.presetsCopyDone",
  "purge.presetsCopyFailed",
  "purge.presetsSkillDone",
  "purge.presetsSkillFailed",
  "purge.presetsRetry",
  "purge.presetsSelectAria",
  "purge.presetsTemplatesHeading",
  "purge.presetsTemplatesEmpty",
  "purge.presetsActiveTemplate",
  "purge.presetsActiveTemplateHint",
  "purge.presetsTemplateChars",
  "purge.presetsDefaultSuffix",
  "purge.presetsRemoveTemplate",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function asCount(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

/**
 * Some hosts wrap the payload in `{ data: … }` (the AIGX envelope); Next.js API
 * routes answer with the bare object. Accepting both keeps the panel working
 * against either server without a flag.
 */
export function unwrapPayload(raw: unknown): unknown {
  if (isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, "data") && isRecord(raw.data)) {
    return raw.data;
  }
  return raw;
}

/** An integer inside `[1, PRESET_MAX_LIMIT]`; anything unusable reads as the default. */
export function clampPresetLimit(raw: unknown): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return PRESET_DEFAULT_LIMIT;
  return Math.min(PRESET_MAX_LIMIT, Math.max(1, Math.round(value)));
}

/**
 * The list URL. A blank search or vendor is omitted rather than sent as an empty
 * query value, so the server sees "no filter" and the URL stays readable in a
 * network log.
 */
export function presetListQuery(params: {
  q?: string;
  vendor?: string;
  limit?: number | null;
} = {}): string {
  const search = new URLSearchParams();
  const q = (params.q ?? "").trim();
  const vendor = (params.vendor ?? "").trim();
  if (q !== "") search.set("q", q);
  if (vendor !== "") search.set("vendor", vendor);
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    search.set("limit", String(clampPresetLimit(params.limit)));
  }
  const query = search.toString();
  return `${PRESET_LIST_PATH}${query === "" ? "" : `?${query}`}`;
}

/** One preset's detail URL, with the id encoded (ids are `[a-z0-9-]`, but never trust a path segment). */
export function presetDetailPath(id: string): string {
  return `${PRESET_LIST_PATH}/${encodeURIComponent(id)}`;
}

/** One preset's apply URL. */
export function presetApplyPath(id: string): string {
  return `${presetDetailPath(id)}/apply`;
}

/** The apply body. `activate` only means anything for `structured_template`. */
export function applyPresetBody(
  target: PurgePresetApplyTarget,
  activate = false,
): { target: PurgePresetApplyTarget; activate: boolean } {
  return { target, activate: activate === true };
}

/**
 * Cut `text` to `chars` characters, appending an ellipsis when it was cut.
 *
 * Splits by code point (`Array.from`) so an emoji or a CJK glyph is never sliced
 * in half — the same rule the Rust side implements with `chars().take()`.
 */
export function previewOf(text: string, chars: number = PRESET_PREVIEW_CHARS): string {
  const limit = Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : PRESET_PREVIEW_CHARS;
  const points = Array.from(typeof text === "string" ? text : "");
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : points.join("");
}

/** Locale-aware byte size: `812 B`, `1.4 KB`. */
export function formatPresetBytes(bytes: number, locale: string): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes) : 0;
  if (value < 1024) return `${new Intl.NumberFormat(locale).format(value)} B`;
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 1024)} KB`;
}

/** The short sha the list shows; the full digest is the row's title attribute. */
export function shortSha(sha: string): string {
  return typeof sha === "string" ? sha.slice(0, 8) : "";
}

export function asPresetBrief(raw: unknown): PurgePresetBrief | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id).trim();
  if (id === "") return null;
  return {
    id,
    vendor: asString(raw.vendor),
    model: asString(raw.model),
    title: asString(raw.title),
    tags: asStringList(raw.tags),
    bytes: asCount(raw.bytes),
    sha256: asString(raw.sha256),
    preview: asString(raw.preview),
  };
}

export function asVendorCount(raw: unknown): PurgePresetVendorCount | null {
  if (!isRecord(raw)) return null;
  const vendor = asString(raw.vendor).trim();
  if (vendor === "") return null;
  return { vendor, count: asCount(raw.count) };
}

/**
 * The list body, every field filled. `null` when the payload carries no `items`
 * array at all: an error envelope is not an empty list, and showing "no match"
 * for a failed load would be a lie.
 */
export function asPresetList(raw: unknown): PurgePresetList | null {
  const body = unwrapPayload(raw);
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const items: PurgePresetBrief[] = [];
  for (const item of body.items) {
    const brief = asPresetBrief(item);
    if (brief) items.push(brief);
  }
  const vendors: PurgePresetVendorCount[] = [];
  if (Array.isArray(body.vendors)) {
    for (const item of body.vendors) {
      const vendor = asVendorCount(item);
      if (vendor) vendors.push(vendor);
    }
  }
  const total = typeof body.total === "number" && Number.isFinite(body.total)
    ? Math.max(0, Math.trunc(body.total))
    : items.length;
  return { items, vendors, total };
}

export function asPresetDetail(raw: unknown): PurgePresetDetail | null {
  const body = unwrapPayload(raw);
  if (!isRecord(body)) return null;
  const id = asString(body.id).trim();
  if (id === "") return null;
  return {
    id,
    vendor: asString(body.vendor),
    model: asString(body.model),
    title: asString(body.title),
    tags: asStringList(body.tags),
    bytes: asCount(body.bytes),
    sha256: asString(body.sha256),
    preview: asString(body.preview),
    body: asString(body.body),
  };
}

/**
 * The apply response, normalized. The server answers `{ result, settings }`; a
 * response without a `result` object is a failed apply.
 *
 * `settings` is deliberately ignored here: `structured_template` only edits the
 * server's in-memory snapshot (the console keeps its own draft) and `skill_file`
 * writes disk without touching the settings at all, so echoing it back would
 * invite a silent overwrite of unsaved edits.
 */
export function asPresetApplyResult(raw: unknown): PurgePresetApplyResult | null {
  const body = unwrapPayload(raw);
  if (!isRecord(body) || !isRecord(body.result)) return null;
  const path = body.result.path;
  return {
    applied: {
      target: asString(body.result.target),
      name: asString(body.result.template),
      path: typeof path === "string" && path !== "" ? path : null,
    },
  };
}

/**
 * Upsert a template by name — the name is the identity, so applying the same
 * preset twice replaces its text instead of appending a duplicate. The input is
 * never mutated (`Array.map`/spread only), which keeps a React draft honest.
 */
export function upsertPresetTemplate<T extends { name: string; text: string }>(
  templates: readonly T[],
  name: string,
  text: string,
): T[] {
  const trimmed = name.trim();
  if (trimmed === "") return [...templates];
  if (templates.some((template) => template.name === trimmed)) {
    return templates.map((template) =>
      template.name === trimmed ? { ...template, text } : template,
    );
  }
  return [...templates, { name: trimmed, text } as T];
}

/** Inline feedback: a message key plus its params, translated at render time. */
interface PresetStatus {
  kind: "ok" | "error";
  key: string;
  params?: TranslationParams;
}

type LoadState = "idle" | "loading" | "ready" | "failed";

export interface PurgePresetLibraryProps {
  /**
   * Hand a preset body to the host so it can land in the structured-template
   * draft. The host marks its form dirty; this component never PUTs on its own.
   */
  onApplyTemplate?: (name: string, text: string) => void;
  /** Called after a SKILL.md was written, so the host can refresh its snapshot. */
  onSkillWritten?: (path: string | null) => void;
  /** Test seam: defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: defaults to `navigator.clipboard.writeText`. */
  copyText?: (text: string) => Promise<void>;
}

/**
 * Settings › Purge › Preset library.
 *
 * Browse, search and read the built-in collection; then land one on a target.
 * Two of the three actions never touch the gateway's settings (copy, and writing
 * a SKILL.md); the template action only edits the caller's draft, so the preset
 * cannot half-save behind the operator's back.
 */
export function PurgePresetLibrary({
  onApplyTemplate,
  onSkillWritten,
  fetchImpl,
  copyText,
}: PurgePresetLibraryProps = {}) {
  const { t, locale } = useI18n();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [vendor, setVendor] = useState("");
  const [list, setList] = useState<PurgePresetList | null>(null);
  const [listState, setListState] = useState<LoadState>("idle");
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurgePresetDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<PresetStatus | null>(null);

  const doFetch = useCallback<typeof fetch>(
    (...args) => (fetchImpl ?? fetch)(...args),
    [fetchImpl],
  );

  const writeClipboard = useCallback(async (text: string) => {
    if (copyText) {
      await copyText(text);
      return;
    }
    await navigator.clipboard.writeText(text);
  }, [copyText]);

  // One debounce timer per keystroke; the last one wins.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), PRESET_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // The list follows the debounced query and the vendor chip.
  useEffect(() => {
    let cancelled = false;
    setListState("loading");
    const url = presetListQuery({ q: debouncedQuery, vendor });
    doFetch(url, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: unknown) => {
        if (cancelled) return;
        const parsed = asPresetList(data);
        if (!parsed) {
          setList(null);
          setListState("failed");
          return;
        }
        setList(parsed);
        setListState("ready");
        // A selection that no longer exists must not keep a stale body on screen.
        setSelectedId((current) => (current && parsed.items.some((item) => item.id === current) ? current : null));
      })
      .catch(() => {
        if (cancelled) return;
        setList(null);
        setListState("failed");
      });
    return () => { cancelled = true; };
  }, [debouncedQuery, doFetch, reloadKey, vendor]);

  // The body follows the selection.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailState("idle");
      return;
    }
    let cancelled = false;
    setDetailState("loading");
    doFetch(presetDetailPath(selectedId), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: unknown) => {
        if (cancelled) return;
        const parsed = asPresetDetail(data);
        if (!parsed) {
          setDetail(null);
          setDetailState("failed");
          return;
        }
        setDetail(parsed);
        setDetailState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setDetail(null);
        setDetailState("failed");
      });
    return () => { cancelled = true; };
  }, [doFetch, selectedId]);

  /** The body for `id`, from the open panel when it is already there. */
  const loadBody = useCallback(async (id: string): Promise<PurgePresetDetail | null> => {
    if (detail && detail.id === id) return detail;
    try {
      const response = await doFetch(presetDetailPath(id), { cache: "no-store" });
      if (!response.ok) return null;
      return asPresetDetail(await response.json());
    } catch {
      return null;
    }
  }, [detail, doFetch]);

  const applyTemplate = useCallback(async (id: string) => {
    setBusy(`template:${id}`);
    setStatus(null);
    try {
      const full = await loadBody(id);
      if (!full) throw new Error("detail unavailable");
      onApplyTemplate?.(full.title, full.body);
      setStatus({ kind: "ok", key: "purge.presetsTemplateDone" });
    } catch {
      setStatus({ kind: "error", key: "purge.presetsTemplateFailed" });
    } finally {
      setBusy(null);
    }
  }, [loadBody, onApplyTemplate]);

  const copyFullText = useCallback(async (id: string) => {
    setBusy(`copy:${id}`);
    setStatus(null);
    try {
      const full = await loadBody(id);
      if (!full) throw new Error("detail unavailable");
      await writeClipboard(full.body);
      setStatus({ kind: "ok", key: "purge.presetsCopyDone" });
    } catch {
      setStatus({ kind: "error", key: "purge.presetsCopyFailed" });
    } finally {
      setBusy(null);
    }
  }, [loadBody, writeClipboard]);

  const writeSkill = useCallback(async (id: string) => {
    setBusy(`skill:${id}`);
    setStatus(null);
    try {
      const response = await doFetch(presetApplyPath(id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applyPresetBody("skill_file")),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = asPresetApplyResult(await response.json());
      if (!parsed) throw new Error("unusable apply response");
      onSkillWritten?.(parsed.applied.path);
      setStatus({
        kind: "ok",
        key: "purge.presetsSkillDone",
        params: { path: parsed.applied.path ?? parsed.applied.name },
      });
    } catch {
      setStatus({ kind: "error", key: "purge.presetsSkillFailed" });
    } finally {
      setBusy(null);
    }
  }, [doFetch, onSkillWritten]);

  const items = useMemo(() => list?.items ?? [], [list]);
  const vendors = useMemo(() => list?.vendors ?? [], [list]);
  const total = list?.total ?? 0;
  const disabled = busy !== null;
  const failed = listState === "failed";
  const notice = t("purge.presetsNotice");
  const statusText = status ? t(status.key, status.params) : "";

  return (
    <section className="settings-general-section settings-preset" aria-busy={loading(listState, detailState)}>
      <h3 className="settings-general-heading">{t("purge.presetsHeading")}</h3>
      {/* 授权边界必须常驻可见：正文是第三方公开 prompt 原文，只搬不改。 */}
      <p className="settings-preset-notice">{notice}</p>

      <div className="settings-preset-toolbar">
        <label className="settings-preset-search" htmlFor={searchId}>
          <input
            id={searchId}
            className="settings-chats-control"
            type="search"
            aria-label={t("purge.presetsSearchAria")}
            placeholder={t("purge.presetsSearch")}
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="settings-preset-total" role="status">
          {listState === "ready" ? t("purge.presetsTotal", { total }) : ""}
        </span>
      </div>

      <div className="settings-preset-chips" role="group" aria-label={t("purge.presetsFilterAria")}>
        <button
          type="button"
          className={`settings-preset-chip${vendor === "" ? " is-active" : ""}`}
          aria-pressed={vendor === ""}
          disabled={disabled}
          onClick={() => setVendor("")}
        >
          {t("purge.presetsAllVendors")}
        </button>
        {vendors.map((entry) => (
          <button
            key={entry.vendor}
            type="button"
            className={`settings-preset-chip${vendor === entry.vendor ? " is-active" : ""}`}
            aria-pressed={vendor === entry.vendor}
            disabled={disabled}
            onClick={() => setVendor(entry.vendor)}
          >
            {entry.vendor}
            <span className="settings-preset-chip-count">{entry.count}</span>
          </button>
        ))}
      </div>

      {listState !== "ready" ? (
        <p className="settings-preset-empty" role={failed ? "alert" : "status"}>
          {failed ? t("purge.presetsListFailed") : t("purge.presetsLoading")}
        </p>
      ) : items.length === 0 ? (
        <p className="settings-preset-empty">{t("purge.presetsEmpty")}</p>
      ) : (
        <ul className="settings-preset-list">
          {items.map((item) => {
            const active = selectedId === item.id;
            return (
              <li key={item.id} className="settings-preset-row">
                <button
                  type="button"
                  className={`settings-preset-item${active ? " is-active" : ""}`}
                  data-testid="purge-preset-item"
                  aria-pressed={active}
                  aria-label={t("purge.presetsSelectAria", { title: item.title })}
                  disabled={disabled}
                  onClick={() => setSelectedId(active ? null : item.id)}
                >
                  <span className="settings-preset-item-main">
                    <span className="settings-preset-item-title">{item.title}</span>
                    <span className="settings-preset-item-meta">{item.vendor} · {item.model}</span>
                  </span>
                  <span className="settings-preset-item-side">
                    <span className="settings-preset-item-bytes">{formatPresetBytes(item.bytes, locale)}</span>
                    {item.sha256 !== "" && (
                      <code className="settings-preset-item-sha" title={item.sha256}>{shortSha(item.sha256)}</code>
                    )}
                  </span>
                </button>
                {active && (
                  <div className="settings-preset-detail">
                    {item.tags.length > 0 && (
                      <div className="settings-preset-tags">
                        {item.tags.map((tag) => (
                          <span key={tag} className="settings-preset-tag">{tag}</span>
                        ))}
                      </div>
                    )}
                    <div className="settings-preset-actions">
                      <ConfigButton
                        variant="secondary"
                        size="small"
                        data-testid="purge-preset-apply-template"
                        disabled={disabled}
                        onClick={() => { void applyTemplate(item.id); }}
                      >
                        {t("purge.presetsApplyTemplate")}
                      </ConfigButton>
                      <ConfigButton
                        variant="secondary"
                        size="small"
                        disabled={disabled}
                        onClick={() => { void copyFullText(item.id); }}
                      >
                        {t("purge.presetsCopy")}
                      </ConfigButton>
                      <ConfigButton
                        variant="secondary"
                        size="small"
                        data-testid="purge-preset-apply-skill"
                        disabled={disabled}
                        onClick={() => { void writeSkill(item.id); }}
                      >
                        {t("purge.presetsApplySkill")}
                      </ConfigButton>
                      {busy !== null && <span className="settings-chats-hint">{t("purge.presetsBusy")}</span>}
                    </div>
                    {detailState === "failed" ? (
                      <p className="settings-preset-empty" role="alert">{t("purge.presetsDetailFailed")}</p>
                    ) : (
                      <pre
                        className="settings-preset-preview"
                        data-testid="purge-preset-preview"
                        aria-label={t("purge.presetsPreviewAria")}
                        aria-busy={detailState === "loading"}
                      >
                        {detail && detail.id === item.id ? detail.body : item.preview}
                      </pre>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {failed && (
        <ConfigButton
          variant="secondary"
          size="small"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          {t("purge.presetsRetry")}
        </ConfigButton>
      )}

      {status !== null && (
        <p className="settings-preset-status" role={status.kind === "error" ? "alert" : "status"}>
          {statusText}
        </p>
      )}
    </section>
  );
}

/** True while either the list or the open body is still being fetched. */
function loading(listState: LoadState, detailState: LoadState): boolean {
  return listState === "loading" || detailState === "loading";
}
