"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import {
  CAMPAIGN_DEFAULT_ITEM_MAX_ROUNDS,
  CAMPAIGN_DEFAULT_MAX_ITEMS,
  CAMPAIGN_MAX_TOTAL_ROUNDS,
  campaignProgress,
  isActiveCampaignStatus,
  isTerminalCampaignStatus,
  type Campaign,
  type CampaignCreateInput,
  type CampaignItem,
  type CampaignItemDraft,
} from "@/lib/campaign/types";

interface Props {
  /** 新建战役时预填的工作目录（当前会话的 cwd）。 */
  defaultCwd: string | null;
  /** 打开战役会话（会话已被删除时返回 false）。 */
  onOpenSession: (sessionId: string) => Promise<boolean>;
}

/** 表单里的一行 backlog 草稿（比 CampaignItemDraft 多一个 dependsOn 文本输入）。 */
interface DraftItem {
  title: string;
  instruction: string;
  acceptance: string;
  verifyCommand: string;
  /** 逗号分隔的 `item-1, item-2` 引用（store 生成 item-N 的稳定 id）。 */
  dependsOn: string;
  maxRounds: string;
}

function emptyDraft(): DraftItem {
  return { title: "", instruction: "", acceptance: "", verifyCommand: "", dependsOn: "", maxRounds: "" };
}

const POLL_MS = 3000;

function usd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

class CampaignApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly key?: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "CampaignApiError";
  }
}

async function campaignRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/campaigns${path}`, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    key?: string;
    params?: Record<string, string | number>;
  } & Record<string, unknown>;
  if (!response.ok) {
    throw new CampaignApiError(body.error ?? `HTTP ${response.status}`, response.status, body.code, body.key, body.params);
  }
  return body as T;
}

/**
 * 「长时项目战役」页（P1 最简 UI，见 docs/agents/fork-long-run-campaign.md §8/§10）。
 *
 * 一个战役 = 一句项目总目标 + 一份有序、带依赖的 backlog；每项自带机器判据
 * （verifyCommand，exit 0 才算 done）。本页只负责建战役 / 看进度 / 停止·暂停·恢复 / 打开会话；
 * 真正的驱动循环在 `lib/campaign/runner.ts`（服务端）。
 *
 * 没有 SSE：战役页在挂载时每 3s 轮询一次列表（条数少、payload 小），足够展示进度。
 */
export function CampaignView({ defaultCwd, onOpenSession }: Props) {
  const { t, locale } = useI18n();
  const [objective, setObjective] = useState("");
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [cost, setCost] = useState("");
  const [maxItems, setMaxItems] = useState(String(CAMPAIGN_DEFAULT_MAX_ITEMS));
  const [maxTotalRounds, setMaxTotalRounds] = useState(String(CAMPAIGN_MAX_TOTAL_ROUNDS));
  const [items, setItems] = useState<DraftItem[]>([emptyDraft()]);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!cwd && defaultCwd) setCwd(defaultCwd);
  }, [cwd, defaultCwd]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await campaignRequest<{ campaigns: Campaign[] }>("");
      if (!aliveRef.current) return;
      setCampaigns(data.campaigns);
      setLoaded(true);
      setError(null);
    } catch (caught) {
      if (!aliveRef.current) return;
      setLoaded(true);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  // 挂载即拉一次，之后每 3s 轮询（标签页隐藏时跳过，回来立刻补一次）。
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  function errorText(caught: unknown): string {
    if (caught instanceof CampaignApiError && caught.key) {
      return t(caught.key, caught.params);
    }
    return caught instanceof Error ? caught.message : String(caught);
  }

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((current) => current.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  }

  function addItem() {
    setItems((current) => [...current, emptyDraft()]);
  }

  function removeItem(index: number) {
    setItems((current) => (current.length <= 1 ? current : current.filter((_, at) => at !== index)));
  }

  function buildInput(): CampaignCreateInput | string {
    if (!objective.trim()) return t("campaign.error.objectiveRequired");
    if (!cwd.trim()) return t("campaign.error.cwdRequired");
    const costValue = Number(cost);
    if (!Number.isFinite(costValue) || costValue <= 0) return t("campaign.error.maxTotalCostUsdRequired");

    const drafts: CampaignItemDraft[] = [];
    for (const item of items) {
      const title = item.title.trim();
      const instruction = item.instruction.trim();
      const verifyCommand = item.verifyCommand.trim();
      if (!title && !instruction && !verifyCommand) continue; // 完全空白的行忽略
      if (!title) return t("campaign.error.itemTitleRequired");
      if (!instruction) return t("campaign.error.itemInstructionRequired");
      if (!verifyCommand) return t("campaign.error.itemVerifyRequired");
      drafts.push({
        title,
        instruction,
        ...(item.acceptance.trim() ? { acceptance: item.acceptance.trim() } : {}),
        verifyCommand,
        ...(item.dependsOn.trim()
          ? { dependsOn: item.dependsOn.split(",").map((entry) => entry.trim()).filter(Boolean) }
          : {}),
        ...(item.maxRounds.trim() ? { maxRounds: Number(item.maxRounds) } : {}),
      });
    }
    if (drafts.length === 0) return t("campaign.error.itemsRequired");

    const parsedMaxItems = maxItems.trim() ? Number(maxItems) : undefined;
    const parsedMaxTotalRounds = maxTotalRounds.trim() ? Number(maxTotalRounds) : undefined;

    return {
      objective: objective.trim(),
      cwd: cwd.trim(),
      maxTotalCostUsd: costValue,
      items: drafts,
      ...(parsedMaxItems !== undefined ? { maxItems: parsedMaxItems } : {}),
      ...(parsedMaxTotalRounds !== undefined ? { maxTotalRounds: parsedMaxTotalRounds } : {}),
    };
  }

  async function start() {
    setActionError(null);
    const input = buildInput();
    if (typeof input === "string") {
      setActionError(input);
      return;
    }
    await act("create", async () => {
      await campaignRequest<{ campaign: Campaign }>("", { method: "POST", body: JSON.stringify(input) });
      setObjective("");
      setItems([emptyDraft()]);
    });
  }

  async function openSession(campaign: Campaign) {
    if (!campaign.sessionId) return;
    setActionError(null);
    if (!(await onOpenSession(campaign.sessionId))) {
      setActionError(t("campaign.sessionMissing"));
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // 逐字面量返回状态文案（不用模板拼键，registry/usage 门禁只认静态键）。
  const statusLabel = (status: Campaign["status"]) => {
    switch (status) {
      case "queued":
        return t("campaign.status.queued");
      case "running":
        return t("campaign.status.running");
      case "verifying":
        return t("campaign.status.verifying");
      case "waiting-provider":
        return t("campaign.status.waitingProvider");
      case "paused":
        return t("campaign.status.paused");
      case "succeeded":
        return t("campaign.status.succeeded");
      case "failed":
        return t("campaign.status.failed");
      case "stopped":
        return t("campaign.status.stopped");
      default:
        return status;
    }
  };
  const itemStatusLabel = (status: CampaignItem["status"]) => {
    switch (status) {
      case "pending":
        return t("campaign.itemStatus.pending");
      case "running":
        return t("campaign.itemStatus.running");
      case "verifying":
        return t("campaign.itemStatus.verifying");
      case "done":
        return t("campaign.itemStatus.done");
      case "failed":
        return t("campaign.itemStatus.failed");
      case "skipped":
        return t("campaign.itemStatus.skipped");
      default:
        return status;
    }
  };
  const statusDotClass = (campaign: Campaign) => {
    if (campaign.status === "running" || campaign.status === "verifying") {
      return "scheduled-status-dot scheduled-status-dot--running";
    }
    if (campaign.status === "succeeded") return "scheduled-status-dot scheduled-status-dot--active";
    if (campaign.status === "failed") return "scheduled-status-dot scheduled-status-dot--attention";
    return "scheduled-status-dot";
  };

  const activeCount = campaigns.filter((campaign) => isActiveCampaignStatus(campaign.status)).length;

  return (
    <section
      ref={rootRef}
      className="scheduled-view"
      tabIndex={-1}
      aria-label={t("campaign.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.preventDefault();
      }}
    >
      <div className="scheduled-shell">
        <header className="scheduled-header">
          <div>
            <h2 className="scheduled-title">{t("campaign.title")}</h2>
            <p className="scheduled-subtitle">{t("campaign.subtitle")}</p>
          </div>
        </header>

        {/* ── 新建战役 ── */}
        <div className="scheduled-form">
          <div className="scheduled-field">
            <label htmlFor="campaign-objective">{t("campaign.objectiveLabel")}</label>
            <textarea
              id="campaign-objective"
              className="scheduled-input scheduled-textarea"
              rows={3}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder={t("campaign.objectivePlaceholder")}
            />
          </div>
          <div className="scheduled-grid">
            <div className="scheduled-field">
              <label htmlFor="campaign-cwd">{t("campaign.cwdLabel")}</label>
              <input
                id="campaign-cwd"
                className="scheduled-input"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder={t("campaign.cwdPlaceholder")}
                spellCheck={false}
              />
            </div>
            <div className="scheduled-field">
              <label htmlFor="campaign-cost">{t("campaign.costLabel")}</label>
              <input
                id="campaign-cost"
                className="scheduled-input"
                inputMode="decimal"
                value={cost}
                onChange={(event) => setCost(event.target.value)}
                placeholder="50"
                spellCheck={false}
              />
              <span className="scheduled-inline">{t("campaign.costHint")}</span>
            </div>
            <div className="scheduled-field">
              <label htmlFor="campaign-max-items">{t("campaign.maxItemsLabel")}</label>
              <input
                id="campaign-max-items"
                className="scheduled-input"
                inputMode="numeric"
                value={maxItems}
                onChange={(event) => setMaxItems(event.target.value)}
                placeholder={String(CAMPAIGN_DEFAULT_MAX_ITEMS)}
                spellCheck={false}
              />
            </div>
            <div className="scheduled-field">
              <label htmlFor="campaign-max-rounds">{t("campaign.maxTotalRoundsLabel")}</label>
              <input
                id="campaign-max-rounds"
                className="scheduled-input"
                inputMode="numeric"
                value={maxTotalRounds}
                onChange={(event) => setMaxTotalRounds(event.target.value)}
                placeholder={String(CAMPAIGN_MAX_TOTAL_ROUNDS)}
                spellCheck={false}
              />
            </div>
          </div>

          {/* ── backlog ── */}
          <div className="campaign-items-editor">
            <span className="campaign-items-heading">{t("campaign.itemsLabel")}</span>
            {items.map((item, index) => (
              <fieldset key={index} className="campaign-item-draft">
                <legend>{`item-${index + 1}`}</legend>
                <div className="scheduled-grid">
                  <div className="scheduled-field">
                    <label htmlFor={`campaign-item-${index}-title`}>{t("campaign.itemTitleLabel")}</label>
                    <input
                      id={`campaign-item-${index}-title`}
                      className="scheduled-input"
                      value={item.title}
                      onChange={(event) => updateItem(index, { title: event.target.value })}
                      spellCheck={false}
                    />
                  </div>
                  <div className="scheduled-field">
                    <label htmlFor={`campaign-item-${index}-verify`}>{t("campaign.itemVerifyLabel")}</label>
                    <input
                      id={`campaign-item-${index}-verify`}
                      className="scheduled-input"
                      value={item.verifyCommand}
                      onChange={(event) => updateItem(index, { verifyCommand: event.target.value })}
                      placeholder="npm test -- foo"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="scheduled-field">
                  <label htmlFor={`campaign-item-${index}-instruction`}>{t("campaign.itemInstructionLabel")}</label>
                  <textarea
                    id={`campaign-item-${index}-instruction`}
                    className="scheduled-input scheduled-textarea"
                    rows={2}
                    value={item.instruction}
                    onChange={(event) => updateItem(index, { instruction: event.target.value })}
                  />
                </div>
                <div className="scheduled-grid">
                  <div className="scheduled-field">
                    <label htmlFor={`campaign-item-${index}-acceptance`}>{t("campaign.itemAcceptanceLabel")}</label>
                    <input
                      id={`campaign-item-${index}-acceptance`}
                      className="scheduled-input"
                      value={item.acceptance}
                      onChange={(event) => updateItem(index, { acceptance: event.target.value })}
                    />
                  </div>
                  <div className="scheduled-field">
                    <label htmlFor={`campaign-item-${index}-depends`}>{t("campaign.itemDependsOnLabel")}</label>
                    <input
                      id={`campaign-item-${index}-depends`}
                      className="scheduled-input"
                      value={item.dependsOn}
                      onChange={(event) => updateItem(index, { dependsOn: event.target.value })}
                      placeholder="item-1, item-2"
                      spellCheck={false}
                    />
                    <span className="scheduled-inline">{t("campaign.itemDependsOnHint")}</span>
                  </div>
                  <div className="scheduled-field">
                    <label htmlFor={`campaign-item-${index}-maxrounds`}>{t("campaign.itemMaxRoundsLabel")}</label>
                    <input
                      id={`campaign-item-${index}-maxrounds`}
                      className="scheduled-input"
                      inputMode="numeric"
                      value={item.maxRounds}
                      onChange={(event) => updateItem(index, { maxRounds: event.target.value })}
                      placeholder={String(CAMPAIGN_DEFAULT_ITEM_MAX_ROUNDS)}
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="scheduled-actions">
                  <button
                    type="button"
                    className="scheduled-button scheduled-button--small scheduled-button--danger"
                    disabled={busy !== null || items.length <= 1}
                    onClick={() => removeItem(index)}
                  >
                    {t("campaign.removeItem")}
                  </button>
                </div>
              </fieldset>
            ))}
            <div className="scheduled-actions">
              <button
                type="button"
                className="scheduled-button scheduled-button--small"
                disabled={busy !== null}
                onClick={addItem}
              >
                {t("campaign.addItem")}
              </button>
            </div>
          </div>

          <div className="scheduled-actions">
            <button
              type="button"
              className="scheduled-button scheduled-button--primary"
              disabled={busy !== null || !objective.trim() || !cwd.trim() || !cost.trim()}
              onClick={() => void start()}
            >
              {busy === "create" ? t("campaign.starting") : t("campaign.start")}
            </button>
            <span className="scheduled-inline">
              {t("campaign.summaryLine", { active: activeCount, total: campaigns.length })}
            </span>
          </div>
        </div>

        {actionError && <p className="scheduled-error" role="alert">{actionError}</p>}
        {error && (
          <p className="scheduled-error" role="alert">
            {t("campaign.loadFailed", { error })}
            <button
              type="button"
              className="scheduled-button scheduled-button--small"
              style={{ marginLeft: 8 }}
              disabled={busy !== null}
              onClick={() => void act("reload", () => refresh())}
            >
              {t("campaign.retry")}
            </button>
          </p>
        )}

        {/* ── 战役列表 ── */}
        {!loaded && <p className="scheduled-inline">{t("campaign.loading")}</p>}
        {loaded && !error && campaigns.length === 0 && (
          <div className="scheduled-empty">
            <h3>{t("campaign.emptyTitle")}</h3>
            <p>{t("campaign.emptyBody")}</p>
          </div>
        )}
        {campaigns.length > 0 && (
          <ul className="scheduled-list">
            {campaigns.map((campaign) => {
              const isActive = isActiveCampaignStatus(campaign.status);
              const isTerminal = isTerminalCampaignStatus(campaign.status);
              const progress = campaignProgress(campaign);
              const isExpanded = expanded.has(campaign.id);
              const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
              const currentItem = campaign.currentItemId
                ? campaign.items.find((item) => item.id === campaign.currentItemId)
                : undefined;
              return (
                <li key={campaign.id}>
                  <div className="scheduled-card" style={{ flexDirection: "column", alignItems: "stretch", cursor: "default" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span className={statusDotClass(campaign)} aria-hidden="true" />
                      <button
                        type="button"
                        className="scheduled-card-main"
                        style={{ background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer", textAlign: "left" }}
                        onClick={() => toggleExpanded(campaign.id)}
                        aria-expanded={isExpanded}
                      >
                        <span className="scheduled-card-name">{campaign.objective.split(/\r?\n/, 1)[0]}</span>
                        <span className="scheduled-card-meta" style={{ flexDirection: "row", alignItems: "center", gap: 8, textAlign: "left" }}>
                          <span className={`scheduled-tag${isActive ? " scheduled-tag--running" : ""}`}>{statusLabel(campaign.status)}</span>
                          <span>{t("campaign.itemsProgress", { done: progress.done, total: progress.total })}</span>
                          <span>{t("campaign.roundOf", { round: campaign.totalRounds, max: campaign.maxTotalRounds })}</span>
                          <span>{formatRelativeTime(new Date(campaign.updatedAt), locale)}</span>
                        </span>
                      </button>
                      <div className="scheduled-actions">
                        {isActive && (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small"
                            disabled={busy !== null}
                            onClick={() => void act(`pause:${campaign.id}`, () =>
                              campaignRequest(`/${encodeURIComponent(campaign.id)}`, { method: "POST", body: JSON.stringify({ action: "pause" }) }),
                            )}
                          >
                            {t("campaign.pause")}
                          </button>
                        )}
                        {isActive && (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small"
                            disabled={busy !== null}
                            onClick={() => void act(`stop:${campaign.id}`, () =>
                              campaignRequest(`/${encodeURIComponent(campaign.id)}`, { method: "POST", body: JSON.stringify({ action: "stop" }) }),
                            )}
                          >
                            {t("campaign.stop")}
                          </button>
                        )}
                        {isTerminal && campaign.status !== "succeeded" && (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small"
                            disabled={busy !== null}
                            onClick={() => void act(`resume:${campaign.id}`, () =>
                              campaignRequest(`/${encodeURIComponent(campaign.id)}`, { method: "POST", body: JSON.stringify({ action: "resume" }) }),
                            )}
                          >
                            {t("campaign.resume")}
                          </button>
                        )}
                        {campaign.sessionId && (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small"
                            disabled={busy !== null}
                            onClick={() => void openSession(campaign)}
                          >
                            {t("campaign.openSession")}
                          </button>
                        )}
                        {confirmDelete === campaign.id ? (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small scheduled-button--danger"
                            disabled={busy !== null}
                            onClick={() => {
                              setConfirmDelete(null);
                              void act(`delete:${campaign.id}`, () =>
                                campaignRequest(`/${encodeURIComponent(campaign.id)}`, { method: "DELETE" }),
                              );
                            }}
                          >
                            {t("campaign.deleteConfirm")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="scheduled-button scheduled-button--small scheduled-button--danger"
                            disabled={busy !== null}
                            onClick={() => setConfirmDelete(campaign.id)}
                          >
                            {t("campaign.delete")}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 进度条 + 成本 / 轮次 / 当前项 */}
                    <div className="campaign-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                      <span className="campaign-progress-fill" style={{ width: `${percent}%` }} />
                    </div>
                    <p className="scheduled-inline campaign-facts">
                      <span>{t("campaign.costOf", {
                        spent: usd(campaign.spentCostUsd),
                        max: usd(campaign.maxTotalCostUsd),
                      })}</span>
                      {currentItem && (
                        <span>{t("campaign.currentItem")}: {currentItem.title}</span>
                      )}
                    </p>
                    {campaign.lastError && (
                      <p className="scheduled-inline autofix-last-error" title={campaign.lastError}>
                        {t("campaign.lastError")}: {campaign.lastError}
                      </p>
                    )}
                    {isExpanded && <CampaignItems campaign={campaign} itemStatusLabel={itemStatusLabel} />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function CampaignItems({
  campaign,
  itemStatusLabel,
}: {
  campaign: Campaign;
  itemStatusLabel: (status: CampaignItem["status"]) => string;
}) {
  const { t } = useI18n();
  if (campaign.items.length === 0) {
    return <p className="scheduled-inline">{t("campaign.noItems")}</p>;
  }
  return (
    <details open>
      <summary className="scheduled-inline">{t("campaign.itemsLabel")}</summary>
      <ul className="autofix-rounds">
        {campaign.items.map((item) => (
          <li key={item.id} className="autofix-round">
            <div className="autofix-round-head">
              <span className="scheduled-mono">{item.id}</span>
              <span className="scheduled-tag">{itemStatusLabel(item.status)}</span>
              <span>{t("campaign.roundOf", { round: item.round, max: item.maxRounds })}</span>
              <span className="scheduled-inline">{usd(item.costUsd)}</span>
            </div>
            <p className="scheduled-inline">{item.title}</p>
            {item.verifyCommand && <pre className="scheduled-mono autofix-round-output">{item.verifyCommand}</pre>}
            {item.lastError && <p className="autofix-round-error">{item.lastError}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}
