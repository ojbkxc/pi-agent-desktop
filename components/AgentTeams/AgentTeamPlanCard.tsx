"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TranslationParams } from "@/lib/i18n/types";
import {
  derivePlanReview,
  isApproveDisabled,
  isPlanApprovable,
  isPlanCardVisible,
  type PlanState,
  type TeamPlanView,
} from "@/lib/agent-teams-plan";
import { PlanEditor, type PlanMemberEditDraft, type PlanTaskEditDraft } from "./PlanEditor";

/**
 * B3 计划卡（会话决策坞，composer 上方）——展示 + **可编辑** + 批准。
 *
 * 收缩态：团队名 + 状态徽标 + 成员数 + 「Review configuration」。点开是 Modal：
 * - 传了 `onSave` → 渲染 `PlanEditor`（成员勾选/批量设模型/跟随队长/逐个改 agent 与模型/
 *   任务负责人；`draft` / `review_pending` 才可编辑）；
 * - 没传 → 退回只读名册（纯展示场景与静态断言用）。
 *
 * 批准按钮的 disabled 口径 = `isApproveDisabled`（图校验：未分配任务 / 非法成员名）
 * || **状态不是 review_pending**（批准路由对其它状态一律 409） || busy
 * || **有未保存的编辑**（否则会按旧模型启动团队）。
 *
 * 阶段显示（对齐 cc-haha AgentTeamsPlanCard.tsx:83）：draft / review_pending / launch_failed
 * / interrupted 显示；无 plan、launching、running、cancelled 且无 parentPlanId 隐藏。
 * approve 成功 → 状态变 launching → 卡片自动消失。
 *
 * 纯展示 + 回调：数据由调用方用 `useTeamPlan(teamName)` 提供；approve 只是回调（由 hook
 * 投递给 lead，桌面不写盘），save 走 PATCH。本组件自判断可见性，不满足时返回 null。
 * 样式内联 + 主题 CSS 变量，不新增全局类。
 */
interface Props {
  plan: TeamPlanView | null;
  /** 读 agent 预设用的项目目录（会话 cwd）；缺省时成员详情只显示当前 agentType。 */
  cwd?: string | null;
  /** approve 请求进行中。 */
  busy?: boolean;
  /** 保存编辑进行中。 */
  saving?: boolean;
  /** 保存失败信息。 */
  saveError?: string | null;
  /** 上次保存 409（计划已被别人改过）。 */
  conflict?: boolean;
  /** 读取 / 批准的错误信息。 */
  error?: string | null;
  /** 批准失败的原因（投递失败 / 409），由 useTeamPlan 记录。 */
  approveError?: string | null;
  /** 点「批准」；由 hook 的 approve 投递给 lead。 */
  onApprove?: () => void;
  /** 保存编辑（PATCH）；缺省时保存按钮不出现。 */
  onSave?: (edits: { members: PlanMemberEditDraft[]; tasks: PlanTaskEditDraft[] }) => void;
  /** 409 后重新载入。 */
  onReload?: () => void;
}

type TFn = (key: string, params?: TranslationParams) => string;

/** 状态 → i18n 键（teams.plan.state.*）。 */
export function planStateLabelKey(state: PlanState): string {
  return `teams.plan.state.${state}`;
}

/** 状态 → 徽标色（只用主题 token）。 */
export function planStateToneColor(state: PlanState): string {
  if (state === "review_pending") return "var(--accent)";
  if (state === "launch_failed") return "var(--danger)";
  return "var(--text-muted)";
}

const S: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
  },
  icon: { flex: "0 0 auto", color: "var(--text-muted)" },
  text: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  label: { fontSize: "var(--fs-micro)", color: "var(--text-dim)" },
  name: { fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fs-caption)", color: "var(--text-muted)" },
  badge: { padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border)", fontSize: "var(--fs-micro)" },
  review: {
    flex: "0 0 auto",
    border: "none",
    borderRadius: 7,
    padding: "5px 11px",
    background: "var(--accent)",
    color: "var(--accent-contrast)",
    fontSize: "var(--fs-caption)",
    fontWeight: "var(--fw-semibold)",
    cursor: "pointer",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 60,
  },
  dialog: {
    width: "min(920px, 100%)",
    maxHeight: "min(80vh, 720px)",
    overflow: "auto",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 16,
  },
  dialogHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  h2: { fontSize: "var(--fs-title)", fontWeight: "var(--fw-semibold)", color: "var(--text)", margin: 0 },
  section: { marginTop: 14 },
  h4: { fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", color: "var(--text-muted)", margin: "0 0 6px" },
  member: { padding: "6px 0", borderTop: "1px solid var(--border)" },
  memberName: { fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", color: "var(--text)" },
  mono: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--text-muted)" },
  muted: { fontSize: "var(--fs-caption)", color: "var(--text-muted)" },
  prompt: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--text-dim)", whiteSpace: "pre-wrap", margin: "4px 0 0" },
  task: { padding: "6px 0", borderTop: "1px solid var(--border)", fontSize: "var(--fs-caption)", color: "var(--text)" },
  alert: { color: "var(--danger)", fontSize: "var(--fs-caption)", margin: "6px 0" },
  footer: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 },
  ghost: { border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: 7, padding: "5px 11px", fontSize: "var(--fs-caption)", cursor: "pointer" },
  approve: { border: "none", background: "var(--accent)", color: "var(--accent-contrast)", borderRadius: 7, padding: "5px 12px", fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", cursor: "pointer" },
  approveOff: { border: "none", background: "var(--border)", color: "var(--text-dim)", borderRadius: 7, padding: "5px 12px", fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", cursor: "not-allowed" },
};

function UsersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/** 纯视图：Modal 内容（无 hook），便于单测直接渲染 / 遍历回调。
 *
 * 「可编辑」由 `options.editor` 决定：传了就渲染 PlanEditor（成员/任务/模型编辑），
 * 否则退回只读名册（既有静态断言与纯展示场景不变）。
 */
export function planModalView(
  t: TFn,
  plan: TeamPlanView,
  options: {
    busy?: boolean;
    onApprove?: () => void;
    onClose?: () => void;
    cwd?: string | null;
    saving?: boolean;
    saveError?: string | null;
    conflict?: boolean;
    onSave?: (edits: { members: PlanMemberEditDraft[]; tasks: PlanTaskEditDraft[] }) => void;
    onReload?: () => void;
    /** 传 true 才渲染可编辑区（需要 React hook，无 DOM 的纯视图测试默认不传）。 */
    editor?: boolean;
    /** 可编辑区有未保存改动（批准必须被拦住）。 */
    dirty?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    /** 批准失败的原因（投递失败 / 409 等），由 useTeamPlan 记录。 */
    approveError?: string | null;
  } = {},
) {
  const review = derivePlanReview(plan);
  const approveDisabled =
    isApproveDisabled(plan) || !isPlanApprovable(plan) || Boolean(options.busy) || Boolean(options.dirty);
  const ownerName = (ownerId: string | undefined) =>
    plan.members.find((member) => member.id === ownerId)?.name ?? t("teams.plan.unassigned");
  const editable = options.editor === true && (plan.state === "draft" || plan.state === "review_pending");
  return (
    <div style={S.overlay} data-testid="team-plan-overlay" onClick={options.onClose}>
      <div
        style={S.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("teams.plan.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={S.dialogHead}>
          <h2 style={S.h2}>
            {t("teams.plan.title")} · {plan.teamName}
          </h2>
          <span style={{ ...S.badge, color: planStateToneColor(plan.state) }}>{t(planStateLabelKey(plan.state))}</span>
        </div>
        <p style={S.muted}>{t("teams.plan.reviewHint")}</p>
        {plan.launch?.error ? (
          <p style={S.alert} role="alert" data-testid="team-plan-launch-error">
            {plan.launch.error}
          </p>
        ) : null}
        {review.invalidNames.length > 0 ? (
          <p style={S.alert} role="alert" data-testid="team-plan-invalid-names">
            {t("teams.plan.invalidNames", { names: review.invalidNames.join(", ") })}
          </p>
        ) : null}

        {options.editor ? (
          <PlanEditor
            plan={plan}
            cwd={options.cwd ?? null}
            editable={editable}
            saving={options.saving ?? false}
            saveError={options.saveError ?? null}
            conflict={options.conflict ?? false}
            {...(options.onSave ? { onSave: options.onSave } : {})}
            {...(options.onReload ? { onReload: options.onReload } : {})}
            {...(options.onDirtyChange ? { onDirtyChange: options.onDirtyChange } : {})}
          />
        ) : (
          <>
            <section style={S.section} aria-label={t("teams.plan.roster")}>
              <h4 style={S.h4}>
                {t("teams.plan.roster")} ({plan.members.length})
              </h4>
              {plan.members.map((member) => (
                <div key={member.id} style={S.member} data-member-id={member.id}>
                  <div style={S.memberName}>{member.name}</div>
                  <div style={S.mono}>
                    {member.agentType} · {member.runtime.providerId}/{member.runtime.modelId}
                    {member.runtime.effortLevel ? ` · ${member.runtime.effortLevel}` : ""}
                  </div>
                  {member.reason ? <p style={S.muted}>{member.reason}</p> : null}
                  {member.prompt ? <p style={S.prompt}>{member.prompt}</p> : null}
                </div>
              ))}
            </section>

            <section style={S.section} aria-label={t("teams.plan.tasks")}>
              <h4 style={S.h4}>
                {t("teams.plan.tasks")} ({plan.tasks.length})
              </h4>
              {plan.tasks.length === 0 ? (
                <p style={S.muted}>{t("teams.plan.noTasks")}</p>
              ) : (
                plan.tasks.map((task) => (
                  <div key={task.id} style={S.task} data-task-id={task.id}>
                    <div>{task.subject}</div>
                    <div style={S.mono}>
                      {t("teams.plan.owner")}: {ownerName(task.ownerId)}
                      {task.dependencies.length > 0
                        ? ` · ${t("teams.plan.dependencies")}: ${task.dependencies.join(", ")}`
                        : ""}
                    </div>
                    {!task.ownerId || !plan.members.some((member) => member.id === task.ownerId) ? (
                      <div style={S.alert} role="alert" data-testid="team-plan-unassigned">
                        {t("teams.plan.assignRequired")}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </section>
          </>
        )}

        {options.dirty ? (
          <p style={S.alert} role="alert" data-testid="team-plan-unsaved">
            {t("teams.plan.saveBeforeApprove")}
          </p>
        ) : null}
        {options.approveError ? (
          <p style={S.alert} role="alert" data-testid="team-plan-approve-error">
            {options.approveError}
          </p>
        ) : null}

        <div style={S.footer}>
          <button type="button" data-testid="team-plan-close" style={S.ghost} onClick={options.onClose} disabled={options.busy}>
            {t("teams.plan.close")}
          </button>
          <button
            type="button"
            data-testid="team-plan-approve"
            style={approveDisabled ? S.approveOff : S.approve}
            onClick={approveDisabled ? undefined : options.onApprove}
            disabled={approveDisabled}
          >
            {options.busy ? t("teams.plan.approving") : t("teams.plan.approve")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentTeamPlanCard({
  plan,
  cwd = null,
  busy = false,
  saving = false,
  saveError = null,
  conflict = false,
  error = null,
  approveError = null,
  onApprove,
  onSave,
  onReload,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // 可编辑区有未保存改动时，批准必须被拦住（否则按旧模型启动团队）。
  const [dirty, setDirty] = useState(false);

  // 审批通过（state 变 launching）后卡片本就隐藏；这里顺手把 Modal 关掉，避免退场残留。
  useEffect(() => {
    if (!isPlanCardVisible(plan)) setOpen(false);
  }, [plan]);

  // 关掉弹框后「有未保存改动」不再成立（草稿随 PlanEditor 卸载而消失）。计划本身变化时
  // **不**在这里清 —— 有未保存改动时 PlanEditor 会保留草稿，由它自己上报真实的 dirty。
  useEffect(() => {
    if (!open) setDirty(false);
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!isPlanCardVisible(plan) || !plan) return null;

  return (
    <section
      aria-label={t("teams.plan.title")}
      data-testid="team-plan-card"
      style={{ ...S.bar, flexDirection: "column", alignItems: "stretch" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={S.icon}>
          <UsersIcon />
        </span>
        <div style={S.text}>
          <span style={S.label}>{t("teams.plan.title")}</span>
          <span style={S.name} title={plan.teamName}>
            {plan.teamName}
          </span>
          <span style={S.meta} role="status">
            <span style={{ ...S.badge, color: planStateToneColor(plan.state) }}>
              {t(planStateLabelKey(plan.state))}
            </span>
            <span>{t("teams.plan.memberCount", { count: plan.members.length })}</span>
          </span>
        </div>
        <button type="button" style={S.review} data-testid="team-plan-open" onClick={() => setOpen(true)}>
          {t("teams.plan.review")}
        </button>
      </div>
      {error ? (
        <p style={S.alert} role="alert">
          {error}
        </p>
      ) : null}
      {open
        ? planModalView(t, plan, {
            busy,
            onApprove,
            onClose: () => setOpen(false),
            editor: true,
            cwd,
            saving,
            saveError,
            conflict,
            dirty,
            approveError,
            onDirtyChange: setDirty,
            ...(onSave ? { onSave } : {}),
            ...(onReload ? { onReload } : {}),
          })
        : null}
    </section>
  );
}
