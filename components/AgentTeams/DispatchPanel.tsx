"use client";

/**
 * 调度建议与一键调度动作面板（#58，#55 第二段）。
 *
 * 数据：GET /api/teams/[team]/workload（v5 稳定契约，design-54.md §一.0）——
 * 只读建议，独立 fetch、失败只在本面板降级提示，**不阻断原画布**（泳道/编队带/
 * 统计头零依赖本面板）；无新定时器，刷新随快照节奏（snapshotStamp）+ 手动按钮。
 *
 * 动作（lead 拍板的硬边界）：系统只检测与建议；首分配/pending-orphan 改派/加成员
 * 一律用户两段式显式确认后才 POST；running（含 orphan-running）永不出现建议，
 * 面板底部固定说明「先等完成或先停旧任务」（如实禁用而非假成功）；按钮在途禁双击
 * （clientRequestId + inFlightRef）；消费 delivery.outcome 如实渲染——woken 只写
 * 「已投递，唤醒中」，绝不写「已执行」；仅 failed 给重试（同 clientRequestId 重发，
 * sidecar 幂等由后端兜底）；skipped 无重试；409 给「刷新」重取代际，不自动重发。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "@/components/AppSelect";
import type { TranslationParams } from "@/lib/i18n/types";

/** v5 稳定契约（design-54.md §一.0）：workload 只读响应。 */
export interface WorkloadMember {
  name: string;
  state: "running" | "pending" | "idle" | "orphan";
  runningCount: number;
  pendingCount: number;
}
export interface WorkloadOrphan {
  ticketId: string;
  assignmentId: string;
  assignee: string;
  status: "pending" | "running";
}
export interface DispatchSuggestion {
  kind: "assign" | "reassign" | "add-member";
  ticketId: string;
  assignmentId?: string;
  fromMember?: string;
  toMember?: string;
  expectedUpdatedAt?: string;
  reason: string;
}
export interface WorkloadQuota {
  perTeamLimit: number;
  globalLimit: number;
  rosterWorkers: number;
  globalWorkers: number;
}
export interface WorkloadResponse {
  members: WorkloadMember[];
  orphans: WorkloadOrphan[];
  suggestions: DispatchSuggestion[];
  quota: WorkloadQuota;
}

/** v5：成员名进邮箱文件路径，格式后端强校验；前端先同款校验避免无效请求。 */
export const MEMBER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type Translator = (key: string, params?: TranslationParams) => string;

/** 建议行稳定 key（同票同派活唯一）。 */
export function suggestionRowKey(s: DispatchSuggestion): string {
  return `${s.kind}:${s.ticketId}:${s.assignmentId ?? ""}`;
}

/** POST /assignments 请求体（v5 §一.2）：改派必带 assignmentId+expectedUpdatedAt；
 *  add-member 不走此端点（走 POST members），返回 null 表示不该发这个请求。 */
export function dispatchBody(
  s: DispatchSuggestion,
  toMember: string,
  clientRequestId: string,
): Record<string, unknown> | null {
  if (!toMember) return null;
  if (s.kind === "reassign") {
    if (!s.assignmentId || !s.expectedUpdatedAt) return null;
    return {
      clientRequestId,
      ticketId: s.ticketId,
      assignmentId: s.assignmentId,
      toMember,
      expectedUpdatedAt: s.expectedUpdatedAt,
    };
  }
  if (s.kind === "assign") {
    return { clientRequestId, ticketId: s.ticketId, toMember };
  }
  return null;
}

/** 改派候选：只列 state==="idle" 的成员（v5 定稿——pending 不作接收者、orphan 永不进候选）。 */
export function idleCandidateNames(workload: WorkloadResponse | null): string[] {
  return (workload?.members ?? []).filter((member) => member.state === "idle").map((member) => member.name);
}

/** delivery.outcome → 如实文案（v5 §一.2 文案契约）。枚举外的未知值兜底显示原文：
 *  宁多给出口，不把未知名宣称成任何一种成功。 */
export function outcomeText(outcome: string, error: string | undefined, t: Translator): string {
  switch (outcome) {
    case "injected":
      return t("teams.dispatch.outcome.injected");
    case "woken":
      return t("teams.dispatch.outcome.woken");
    case "revived":
      return t("teams.dispatch.outcome.revived");
    case "buffered":
      return t("teams.dispatch.outcome.buffered");
    case "failed":
      return t("teams.dispatch.outcome.failed", { error: error ?? "" });
    default:
      return outcome;
  }
}

type RowResult =
  | { phase: "delivered"; text: string }
  | { phase: "skipped"; text: string }
  | { phase: "conflict"; text: string }
  | { phase: "failed"; text: string; clientRequestId: string; body: Record<string, unknown> };

interface MemberReceipt {
  name: string;
  status: string;
  reason?: string;
  warning?: string;
}

export function DispatchPanel({
  team,
  snapshotStamp,
  ticketSubjects,
}: {
  team: string | null;
  /** workbench 快照的 generatedAt：快照更新即随节奏重拉建议（无独立定时器）。 */
  snapshotStamp?: string | null;
  /** ticketId → subject（来自既有快照，纯展示用；缺票回退显示 ticketId）。 */
  ticketSubjects?: Record<string, string>;
}) {
  const { t } = useI18n();
  const [workload, setWorkload] = useState<WorkloadResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [selectedTo, setSelectedTo] = useState<Record<string, string>>({});
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({});
  // 加成员表单（仅 add-member 建议行内展开）。
  const [addName, setAddName] = useState("");
  const [addAgentType, setAddAgentType] = useState("");
  const [addModel, setAddModel] = useState("");
  const [membersPending, setMembersPending] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberReceipts, setMemberReceipts] = useState<MemberReceipt[] | null>(null);
  const inFlightRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!team) {
      setWorkload(null);
      setLoadError(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(team)}/workload`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as WorkloadResponse;
      if (!aliveRef.current) return;
      setWorkload(data);
      setLoadError(null);
    } catch (error) {
      // 只降级本面板：原画布（泳道/编队带/统计头）不消费本面板任何状态。
      if (!aliveRef.current) return;
      setWorkload(null);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [team]);

  useEffect(() => {
    void refresh();
  }, [refresh, snapshotStamp]);

  const execute = useCallback(async (
    suggestion: DispatchSuggestion,
    toMember: string,
    reuseRequestId?: string,
  ) => {
    const rowKey = suggestionRowKey(suggestion);
    const body = dispatchBody(suggestion, toMember, reuseRequestId ?? crypto.randomUUID());
    if (!team || !body || inFlightRef.current) return;
    const requestId = body.clientRequestId as string;
    inFlightRef.current = true;
    setPendingKey(rowKey);
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(team)}/assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!aliveRef.current) return;
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        delivery?: { to: string; outcome?: string; error?: string; skipped?: string };
      };
      if (response.status === 409) {
        // 代际过期/running/多主：不自动重发——给「刷新」重取代际，由用户重新确认。
        setRowResults((prev) => ({
          ...prev,
          [rowKey]: { phase: "conflict", text: payload.error ?? t("teams.dispatch.conflict") },
        }));
        return;
      }
      if (!response.ok || payload.error) {
        const text = payload.error ?? `HTTP ${response.status}`;
        setRowResults((prev) => ({
          ...prev,
          [rowKey]: { phase: "failed", text, clientRequestId: requestId, body },
        }));
        return;
      }
      const delivery = payload.delivery;
      if (delivery?.skipped) {
        // 已投递过（幂等 sidecar 判定）——不重发，也不给重试按钮。
        setRowResults((prev) => ({ ...prev, [rowKey]: { phase: "skipped", text: t("teams.dispatch.skipped") } }));
        return;
      }
      const outcome = delivery?.outcome ?? "failed";
      const text = outcomeText(outcome, delivery?.error, t);
      if (outcome === "failed") {
        setRowResults((prev) => ({
          ...prev,
          [rowKey]: { phase: "failed", text, clientRequestId: requestId, body },
        }));
        return;
      }
      // injected/woken/revived/buffered：如实渲染 outcome 文案——woken 只是「已投递，
      // 唤醒中」，绝不宣称「已执行」。
      setRowResults((prev) => ({ ...prev, [rowKey]: { phase: "delivered", text } }));
    } catch (error) {
      // 网络层失败：票面变更（ended 不可逆）已发生后投递可能未达——按 failed 给
      // 同 clientRequestId 重试出口，重复投递风险由后端 sidecar 幂等兜底并明示。
      if (!aliveRef.current) return;
      setRowResults((prev) => ({
        ...prev,
        [rowKey]: {
          phase: "failed",
          text: error instanceof Error ? error.message : String(error),
          clientRequestId: requestId,
          body,
        },
      }));
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) setPendingKey(null);
    }
  }, [team, t]);

  const submitMembers = useCallback(async () => {
    if (!team || !MEMBER_NAME_PATTERN.test(addName) || inFlightRef.current) return;
    inFlightRef.current = true;
    setMembersPending(true);
    setMembersError(null);
    try {
      const member: Record<string, string> = { name: addName };
      if (addAgentType.trim()) member.agentType = addAgentType.trim();
      if (addModel.trim()) member.model = addModel.trim();
      const response = await fetch(`/api/teams/${encodeURIComponent(team)}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", members: [member] }),
      });
      if (!aliveRef.current) return;
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        results?: { name: string; status: string; reason?: string; warning?: string }[];
      };
      if (!response.ok || payload.error) {
        setMembersError(payload.error ?? `HTTP ${response.status}`);
        return;
      }
      // 逐条回执如实渲染（spawned/respawned/failed）——失败绝不渲染成成功。
      setMemberReceipts(payload.results ?? []);
      setAddName("");
      setAddModel("");
    } catch (error) {
      if (!aliveRef.current) return;
      setMembersError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) setMembersPending(false);
    }
  }, [addAgentType, addModel, addName, team]);

  const candidates = idleCandidateNames(workload);
  const suggestions = workload?.suggestions ?? [];

  return (
    <div className="agent-teams-dispatch" data-testid="agent-teams-dispatch">
      <div className="agent-teams-dispatch-head">
        <span className="agent-teams-dispatch-title">{t("teams.dispatch.title")}</span>
        <button
          type="button"
          className="agent-teams-dispatch-refresh"
          disabled={loading || !team}
          onClick={() => void refresh()}
        >
          {t("teams.dispatch.refresh")}
        </button>
      </div>

      {!team ? null : loadError ? (
        <p className="agent-teams-dispatch-error" role="alert">
          {t("teams.dispatch.loadFailed", { error: loadError })}
        </p>
      ) : loading && !workload ? (
        <p className="agent-teams-dispatch-empty">{t("i18n.loading")}</p>
      ) : suggestions.length === 0 ? (
        <p className="agent-teams-dispatch-empty">{t("teams.dispatch.empty")}</p>
      ) : (
        <ul className="agent-teams-dispatch-list">
          {suggestions.map((suggestion) => {
            const rowKey = suggestionRowKey(suggestion);
            const subject = ticketSubjects?.[suggestion.ticketId] ?? suggestion.ticketId;
            const toMember = selectedTo[rowKey] ?? suggestion.toMember ?? "";
            const result = rowResults[rowKey];
            const inFlight = pendingKey === rowKey;
            const isAddMember = suggestion.kind === "add-member";
            const nameInvalid = addName.length > 0 && !MEMBER_NAME_PATTERN.test(addName);
            const descKey = isAddMember
              ? "teams.dispatch.addMemberHint"
              : suggestion.kind === "reassign"
                ? "teams.dispatch.reassign"
                : "teams.dispatch.assign";
            const descParams: TranslationParams = isAddMember
              ? {}
              : suggestion.kind === "reassign"
                ? { ticket: subject, from: suggestion.fromMember ?? "", member: toMember || suggestion.toMember || "" }
                : { ticket: subject, member: toMember || suggestion.toMember || "" };
            return (
              <li key={rowKey} className="agent-teams-dispatch-row" data-kind={suggestion.kind}>
                <div className="agent-teams-dispatch-row-main">
                  <span className="agent-teams-dispatch-desc">{t(descKey, descParams)}</span>
                  <span className="agent-teams-dispatch-reason">{t("teams.dispatch.reason", { reason: suggestion.reason })}</span>
                </div>
                {result && (
                  <span
                    className={`agent-teams-dispatch-result agent-teams-dispatch-result--${result.phase}`}
                    data-dispatch-result={result.phase}
                  >
                    {result.text}
                    {result.phase === "conflict" && (
                      <button type="button" className="agent-teams-dispatch-inline" onClick={() => { setRowResults((prev) => { const next = { ...prev }; delete next[rowKey]; return next; }); void refresh(); }}>
                        {t("teams.dispatch.refresh")}
                      </button>
                    )}
                    {result.phase === "failed" && (
                      <button
                        type="button"
                        className="agent-teams-dispatch-inline"
                        disabled={inFlight}
                        onClick={() => void execute(suggestion, toMember, result.clientRequestId)}
                      >
                        {t("teams.dispatch.retry")}
                      </button>
                    )}
                  </span>
                )}
                {confirming === rowKey && !isAddMember && (
                  <div className="agent-teams-dispatch-confirm">
                    <span className="agent-teams-dispatch-confirm-label">{t("teams.dispatch.reassignTo")}</span>
                    <AppSelect
                      className="agent-teams-dispatch-select"
                      aria-label={t("teams.dispatch.reassignTo")}
                      value={toMember}
                      placeholder={t("teams.dispatch.reassignTo")}
                      disabled={inFlight || candidates.length === 0}
                      onValueChange={(next) => setSelectedTo((prev) => ({ ...prev, [rowKey]: next }))}
                      options={candidates.map((name) => ({ value: name, label: name }))}
                    />
                    {candidates.length === 0 && (
                      <span className="agent-teams-dispatch-confirm-note">{t("teams.dispatch.noIdle")}</span>
                    )}
                    <button
                      type="button"
                      className="agent-teams-dispatch-execute"
                      disabled={inFlight || !toMember}
                      onClick={() => void execute(suggestion, toMember)}
                    >
                      {inFlight ? t("teams.dispatch.inFlight") : t("teams.dispatch.confirm")}
                    </button>
                    <button
                      type="button"
                      className="agent-teams-dispatch-inline"
                      disabled={inFlight}
                      onClick={() => setConfirming(null)}
                    >
                      {t("i18n.cancel")}
                    </button>
                  </div>
                )}
                {confirming === rowKey && isAddMember && (
                  <div className="agent-teams-dispatch-confirm agent-teams-dispatch-member-form">
                    {workload && (
                      <span className="agent-teams-dispatch-quota">
                        {t("teams.dispatch.quota", {
                          roster: workload.quota.rosterWorkers,
                          perTeam: workload.quota.perTeamLimit,
                          global: workload.quota.globalWorkers,
                          globalLimit: workload.quota.globalLimit,
                        })}
                      </span>
                    )}
                    <label className="agent-teams-dispatch-field">
                      <span>{t("teams.dispatch.memberName")}</span>
                      <input
                        className="agent-teams-dispatch-input"
                        value={addName}
                        disabled={membersPending}
                        onChange={(event) => setAddName(event.target.value)}
                        placeholder="worker-two"
                      />
                    </label>
                    {nameInvalid && (
                      <span className="agent-teams-dispatch-field-error">{t("teams.dispatch.memberNameInvalid")}</span>
                    )}
                    <label className="agent-teams-dispatch-field">
                      <span>{t("teams.dispatch.memberRole")}</span>
                      <input
                        className="agent-teams-dispatch-input"
                        value={addAgentType}
                        disabled={membersPending}
                        onChange={(event) => setAddAgentType(event.target.value)}
                        placeholder="member"
                      />
                    </label>
                    <label className="agent-teams-dispatch-field">
                      <span>{t("teams.dispatch.memberModel")}</span>
                      <input
                        className="agent-teams-dispatch-input"
                        value={addModel}
                        disabled={membersPending}
                        onChange={(event) => setAddModel(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="agent-teams-dispatch-execute"
                      disabled={membersPending || addName.length === 0 || nameInvalid}
                      onClick={() => void submitMembers()}
                    >
                      {membersPending ? t("teams.dispatch.inFlight") : t("teams.dispatch.memberSubmit")}
                    </button>
                    <button
                      type="button"
                      className="agent-teams-dispatch-inline"
                      disabled={membersPending}
                      onClick={() => setConfirming(null)}
                    >
                      {t("i18n.cancel")}
                    </button>
                    {membersError && (
                      <span className="agent-teams-dispatch-result agent-teams-dispatch-result--failed" role="alert">
                        {membersError}
                      </span>
                    )}
                    {memberReceipts && memberReceipts.map((receipt) => {
                      const label = receipt.status === "spawned"
                        ? t("teams.dispatch.member.spawned")
                        : receipt.status === "respawned"
                          ? t("teams.dispatch.member.respawned")
                          : receipt.status === "failed"
                            ? t("teams.dispatch.member.failed")
                            : receipt.status;
                      return (
                        <span
                          key={receipt.name}
                          className={`agent-teams-dispatch-result agent-teams-dispatch-result--${receipt.status === "failed" ? "failed" : "ok"}`}
                          data-member-status={receipt.status}
                        >
                          {receipt.name}: {label}
                          {receipt.reason ? ` — ${receipt.reason}` : ""}
                          {receipt.warning ? ` (${receipt.warning})` : ""}
                        </span>
                      );
                    })}
                  </div>
                )}
                {!result && confirming !== rowKey && (
                  <button
                    type="button"
                    className="agent-teams-dispatch-execute"
                    disabled={inFlight || (!isAddMember && !suggestion.toMember)}
                    onClick={() => setConfirming((current) => (current === rowKey ? null : rowKey))}
                  >
                    {inFlight ? t("teams.dispatch.inFlight") : t("teams.dispatch.execute")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="agent-teams-dispatch-running-note" data-testid="agent-teams-dispatch-running-note">
        {t("teams.dispatch.runningNote")}
      </p>
    </div>
  );
}
