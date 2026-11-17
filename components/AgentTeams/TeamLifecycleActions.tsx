"use client";

import { useEffect, useRef, useState } from "react";
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
  error?: string;
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
      params: { reason: payload.reason ?? payload.error ?? failed[0]?.reason ?? "" },
      failed,
    };
  }

  if (!ok) {
    return {
      tone: "error",
      messageKey: "teams.lifecycle.requestFailed",
      params: { message: payload.reason ?? payload.error ?? "" },
      failed,
    };
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

/**
 * 回收的二次确认（不可逆）：文案带 displayName 与 memberCount。
 *
 * 语义与行为必须一致（a11y.md P2）：这是**内联**确认区，不是模态——没有遮罩、
 * 不圈禁 Tab、也不接管 document 级 Esc，所以不能挂 `role="alertdialog"`（读屏器
 * 会按模态播报）。改用 `role="group"` + aria-label，并在出现时把焦点移到
 * 「取消」（键盘触发「回收」后焦点不会停在危险按钮上）；Esc 由本组件的
 * onKeyDown 取消并把焦点还回「回收」按钮。
 */
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // 出现即聚焦「取消」（安全选项）；卸载时把焦点还回触发「回收」的按钮。
  useEffect(() => {
    openerRef.current = typeof document === "undefined"
      ? null
      : document.activeElement as HTMLElement | null;
    cancelRef.current?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current;
      if (!opener || !opener.isConnected) return;
      const active = typeof document === "undefined" ? null : document.activeElement;
      if (active === null || active === document.body || confirmRef.current?.contains(active)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div
      ref={confirmRef}
      className="team-lifecycle-confirm"
      role="group"
      aria-label={t("teams.lifecycle.reclaim")}
      data-testid="reclaim-confirm"
      onKeyDown={(event) => {
        // 内联区块：Escape 只取消本次确认，stopPropagation 防它冒泡到全局
        // Esc 停掉运行中的 agent。
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="team-lifecycle-confirm-text">
        {t("teams.lifecycle.confirmReclaim", { team: displayName, count: memberCount })}
      </p>
      <div className="team-lifecycle-confirm-actions">
        <button type="button" className="team-lifecycle-confirm-danger" disabled={busy} onClick={onConfirm}>
          {busy ? t("teams.lifecycle.busy") : t("teams.lifecycle.confirmReclaimAction")}
        </button>
        <button ref={cancelRef} type="button" className="team-lifecycle-cancel" disabled={busy} onClick={onCancel}>
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
  /** 操作成功（response.ok 且 ok===true）后回调：携带操作目录名与动作。
   *  回收（reclaim）后团队目录已删除，父级据此刷新名册并回落选中；停止（stop）
   *  团队仍在，父级只需刷新名册。 */
  onDone?: (team: string, action: LifecycleAction) => void;
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
      // 契约：失败也以 409 带回结构化的 ok/removed/results（逐条如实），不能当成传输错误丢掉。
      const structured = Boolean(payload) && (typeof payload!.ok === "boolean" || Array.isArray(payload!.results));
      if (!structured) {
        setFailure(t("teams.lifecycle.requestFailed", {
          message: payload?.error ?? `HTTP ${response.status}`,
        }));
        return;
      }
      setOutcome(interpretLifecycleOutcome(action, payload));
      if (response.ok && payload!.ok === true) onDone?.(team, action);
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
