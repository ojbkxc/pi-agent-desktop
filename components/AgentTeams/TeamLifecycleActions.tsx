"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export type LifecycleAction = "stop" | "reclaim";

/** POST /api/teams/[team]/lifecycle 的逐成员回执（与 #23 冻结的契约同形）。 */
export interface LifecycleMemberResult {
  memberId: string;
  name: string | null;
  status: "stopped" | "already-stopped" | "failed";
  reason?: string;
}

export interface LifecycleResponse {
  team?: string;
  action?: string;
  ok?: boolean;
  removed?: boolean;
  reason?: string;
  results?: LifecycleMemberResult[];
}

export interface LifecycleOutcome {
  tone: "success" | "warning" | "error";
  messageKey: string;
  params: Record<string, string | number>;
  failed: { name: string; reason: string }[];
}

/** 保底解析逐成员回执；结构不符的条目丢弃。 */
export function parseLifecycleResults(payload: LifecycleResponse | null): LifecycleMemberResult[] {
  if (!payload || !Array.isArray(payload.results)) return [];
  return payload.results.filter((item): item is LifecycleMemberResult => (
    Boolean(item) && typeof item.memberId === "string"
  ));
}

/**
 * 把响应判成用户可读的结论。关键：reclaim 只有在 `ok && removed===true` 时才算成功；
 * `removed:false`（未删除）一律为 warning 并带上原因，绝不显示成成功。
 */
export function interpretLifecycleOutcome(
  action: LifecycleAction,
  payload: LifecycleResponse | null,
): LifecycleOutcome {
  if (!payload || typeof payload !== "object") {
    return { tone: "error", messageKey: "teams.lifecycle.requestFailed", params: { message: "invalid response" }, failed: [] };
  }
  const results = parseLifecycleResults(payload);
  const failed = results
    .filter((result) => result.status === "failed")
    .map((result) => ({ name: result.name ?? result.memberId, reason: result.reason ?? "" }));
  const stopped = results.filter((result) => result.status === "stopped").length;
  const already = results.filter((result) => result.status === "already-stopped").length;
  const ok = payload.ok === true;

  if (action === "reclaim") {
    if (ok && payload.removed === true) {
      return { tone: "success", messageKey: "teams.lifecycle.reclaimDone", params: {}, failed };
    }
    return {
      tone: "warning",
      messageKey: "teams.lifecycle.notRemoved",
      params: { reason: payload.reason ?? failed[0]?.reason ?? "" },
      failed,
    };
  }

  if (!ok) {
    return { tone: "error", messageKey: "teams.lifecycle.requestFailed", params: { message: payload.reason ?? "" }, failed };
  }
  return { tone: "success", messageKey: "teams.lifecycle.stopDone", params: { count: stopped, already }, failed };
}

/** 结论渲染：success / warning / error 三档，failed 成员单列并带原因。 */
export function LifecycleOutcomeMessage({ outcome }: { outcome: LifecycleOutcome }) {
  const { t } = useI18n();
  const reason = t("teams.lifecycle.unknownReason");
  return (
    <div
      className={`team-lifecycle-outcome team-lifecycle-outcome--${outcome.tone}`}
      data-tone={outcome.tone}
      role={outcome.tone === "error" ? "alert" : "status"}
    >
      <p className="team-lifecycle-outcome-message">
        {t(outcome.messageKey, {
          ...outcome.params,
          ...(outcome.messageKey === "teams.lifecycle.notRemoved" && !outcome.params.reason ? { reason } : {}),
        })}
      </p>
      {outcome.failed.length > 0 && (
        <ul className="team-lifecycle-outcome-failed">
          {outcome.failed.map((item) => (
            <li key={item.name}>{t("teams.lifecycle.memberFailed", { name: item.name, reason: item.reason || reason })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 回收的二次确认（不可逆）：文案带 displayName 与 memberCount。 */
export function ReclaimConfirm({
  displayName,
  memberCount,
  busy,
  onConfirm,
  onCancel,
}: {
  displayName: string;
  memberCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="team-lifecycle-confirm" role="alertdialog" aria-label={t("teams.lifecycle.reclaim")} data-testid="reclaim-confirm">
      <p className="team-lifecycle-confirm-text">
        {t("teams.lifecycle.confirmReclaim", { team: displayName, count: memberCount })}
      </p>
      <div className="team-lifecycle-confirm-actions">
        <button type="button" className="team-lifecycle-confirm-danger" disabled={busy} onClick={onConfirm}>
          {busy ? t("teams.lifecycle.busy") : t("teams.lifecycle.confirmReclaimAction")}
        </button>
        <button type="button" className="team-lifecycle-cancel" disabled={busy} onClick={onCancel}>
          {t("teams.lifecycle.cancel")}
        </button>
      </div>
    </div>
  );
}

export interface TeamLifecycleActionsProps {
  /** 目录名（URL 用），不是 displayName。 */
  team: string;
  /** 展示名（config.json 的 team.name）。 */
  displayName: string;
  memberCount: number;
  onDone?: () => void;
}

/**
 * 团队生命周期操作：停止（保留会话文件，可复活）与回收（不可逆删除 + 杀运行中的 agent）。
 * 回收必须二次确认；removed:false 时明确告知「未删除」而不是成功。
 */
export function TeamLifecycleActions({ team, displayName, memberCount, onDone }: TeamLifecycleActionsProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<LifecycleAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<LifecycleOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (action: LifecycleAction) => {
    setBusy(action);
    setFailure(null);
    setOutcome(null);
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(team)}/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => null) as (LifecycleResponse & { error?: string }) | null;
      if (!response.ok) {
        setFailure(t("teams.lifecycle.requestFailed", {
          message: payload?.error ?? `HTTP ${response.status}`,
        }));
        return;
      }
      setOutcome(interpretLifecycleOutcome(action, payload));
      onDone?.();
    } catch (err) {
      setFailure(t("teams.lifecycle.requestFailed", {
        message: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <div className="team-lifecycle-actions">
      <div className="team-lifecycle-buttons">
        <button
          type="button"
          className="team-lifecycle-stop"
          title={t("teams.lifecycle.stopHint")}
          disabled={busy !== null}
          onClick={() => void run("stop")}
        >
          {t("teams.lifecycle.stop")}
        </button>
        <button
          type="button"
          className="team-lifecycle-reclaim"
          title={t("teams.lifecycle.reclaimHint")}
          disabled={busy !== null}
          onClick={() => setConfirming(true)}
        >
          {t("teams.lifecycle.reclaim")}
        </button>
      </div>

      {confirming && (
        <ReclaimConfirm
          displayName={displayName}
          memberCount={memberCount}
          busy={busy !== null}
          onConfirm={() => void run("reclaim")}
          onCancel={() => setConfirming(false)}
        />
      )}

      {failure && <p className="team-lifecycle-error" role="alert">{failure}</p>}
      {outcome && <LifecycleOutcomeMessage outcome={outcome} />}
    </div>
  );
}
