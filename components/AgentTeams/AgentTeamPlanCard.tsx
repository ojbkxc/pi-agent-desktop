"use client";

import { useEffect, useState, type CSSProperties, type Ref } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useModalDismiss } from "@/hooks/useModalDismiss";
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
 * 停止按钮（对齐 cc-haha AgentTeamsPlanCard.tsx:170-174）：`canStop = Boolean(plan.parentPlanId)`
 * 时显示——只有「加入运行中团队的新增计划」才需要停 lead 会话生成；点击调 `onStop`
 * （ChatWindow 接 `handleAbort` 停本会话生成）。点击后按钮禁用并显示「正在停止…」，
 * 不主动复位（停止生效后计划流转自然退场）。
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
  /** 点「停止」；停 lead 会话生成（由调用方接 abort，cc-haha stopGeneration 同款）。 */
  onStop?: () => void;
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
    // 层叠令牌，不用 literal 60：60 < 顶栏 --z-chrome=90，于是 backdrop 与对话框
    // 顶带被顶栏盖住，aria-modal 期间顶栏仍可点。卡片挂在聊天列（不在 .scheduled-view
    // 的 z 30 上下文里，也未被任何祖先 overflow 裁切——overlay 是 inset:0 的 fixed），
    // 所以无需门户，换成 --z-modal 令牌即与全局对话框同层。
    zIndex: "var(--z-modal)",
  },
  dialog: {
    // 920px 在宽屏上几乎横跨整个窗口，两列编辑器拉得很长；720px 刚好
    // 容下 280px 成员列 + 432px 详情/任务列，又不至于把弹框铺满。
    width: "min(720px, 100%)",
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
  confirmRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "6px 0", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--danger)", background: "var(--bg-panel)" },
  footer: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 },
  ghost: { border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: 7, padding: "5px 11px", fontSize: "var(--fs-caption)", cursor: "pointer" },
  stop: { border: "1px solid var(--danger)", background: "transparent", color: "var(--danger)", borderRadius: 7, padding: "5px 12px", fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", cursor: "pointer" },
  stopOff: { border: "1px solid var(--danger)", background: "transparent", color: "var(--text-dim)", borderRadius: 7, padding: "5px 12px", fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", cursor: "not-allowed" },
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
    /** 关闭确认进行中（dirty 时点关闭进入此态，面板内出现二次确认行）。 */
    discardPrompt?: boolean;
    /** 二次确认：放弃未保存改动并关闭。 */
    onDiscard?: () => void;
    /** 二次确认里点「取消」：留在卡片里继续编辑。 */
    onCancelDiscard?: () => void;
    /** dirty 时点关闭/遮罩/Esc/Close 走这里（必须走 requestClose，不能直接 onClose）。 */
    onRequestClose?: () => void;
    /** 关闭按钮是否禁用（busy 时禁用，dirty 时仍可点以进入二次确认）。 */
    closeDisabled?: boolean;
    /** 模态面板 ref（useModalDismiss 返回；纯视图不传时降级为无焦点管理）。 */
    panelRef?: Ref<HTMLDivElement>;
    /** 批准失败的原因（投递失败 / 409 等），由 useTeamPlan 记录。 */
    approveError?: string | null;
    /** 点「停止」（停 lead 会话生成）；缺省时停止按钮不出现。 */
    onStop?: () => void;
    /** 正在执行停止（按钮禁用并显示「正在停止…」）。 */
    stopping?: boolean;
  } = {},
) {
  const review = derivePlanReview(plan);
  const approveDisabled =
    isApproveDisabled(plan) || !isPlanApprovable(plan) || Boolean(options.busy) || Boolean(options.dirty);
  // cc-haha 同款口径：带 parentPlanId 的卡片（加入运行中团队的新增计划）才给停止按钮。
  const canStop = Boolean(plan.parentPlanId) && Boolean(options.onStop);
  // 三条关闭路径（遮罩 / Close / Esc）统一走 requestClose：dirty 时先进二次确认，
  // 不再静默卸载 PlanEditor 丢掉模型/负责人草稿（interaction.md P1）。没有可编辑
  // 区时 requestClose 就是 onClose 的同义词。
  const requestClose = options.onRequestClose ?? options.onClose;
  const ownerName = (ownerId: string | undefined) =>
    plan.members.find((member) => member.id === ownerId)?.name ?? t("teams.plan.unassigned");
  const editable = options.editor === true && (plan.state === "draft" || plan.state === "review_pending");
  return (
    <div style={S.overlay} data-testid="team-plan-overlay" onClick={requestClose}>
      <div
        ref={options.panelRef}
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

        {options.dirty && !options.discardPrompt ? (
          <p style={S.alert} role="alert" data-testid="team-plan-unsaved">
            {t("teams.plan.saveBeforeApprove")}
          </p>
        ) : null}
        {/* dirty 时点关闭 → 二次确认行（interaction.md P1：草稿不能被静默丢弃）。
            Esc / 遮罩 / Close 三条路径都由 requestClose 走进这里，不再直接卸载。 */}
        {options.discardPrompt ? (
          <div style={S.confirmRow} data-testid="team-plan-discard-prompt">
            <p style={{ ...S.alert, margin: 0, flex: 1 }} role="alert">
              {t("teams.plan.discardUnsaved")}
            </p>
            <button type="button" data-testid="team-plan-discard-cancel" style={S.ghost} onClick={options.onCancelDiscard}>
              {t("i18n.cancel")}
            </button>
            <button type="button" data-testid="team-plan-discard-confirm" style={S.stop} onClick={options.onDiscard}>
              {t("teams.plan.discardAndClose")}
            </button>
          </div>
        ) : null}
        {options.approveError ? (
          <p style={S.alert} role="alert" data-testid="team-plan-approve-error">
            {options.approveError}
          </p>
        ) : null}

        <div style={S.footer}>
          <button type="button" data-testid="team-plan-close" style={S.ghost} onClick={requestClose} disabled={options.closeDisabled ?? options.busy}>
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
          {canStop ? (
            <button
              type="button"
              data-testid="team-plan-stop"
              style={options.stopping ? S.stopOff : S.stop}
              onClick={options.stopping ? undefined : options.onStop}
              disabled={Boolean(options.stopping)}
            >
              {options.stopping ? t("teams.plan.stopping") : t("teams.plan.stop")}
            </button>
          ) : null}
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
  onStop,
  onApprove,
  onSave,
  onReload,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // 可编辑区有未保存改动时，批准必须被拦住（否则按旧模型启动团队）。
  const [dirty, setDirty] = useState(false);
  // dirty 时点关闭 → 停在卡片里问「放弃未保存的修改？」（interaction.md P1）。
  // 三条关闭路径（Esc / 遮罩 / Close）都先到这里，确认后才真关。
  const [discardPrompt, setDiscardPrompt] = useState(false);
  // 正在执行停止的 planId（按钮禁用 + 「正在停止…」）；对齐 cc-haha：不主动清，
  // 停止生效后计划流转（取消/中断/批准）自然让卡片退场。
  const [stoppingPlanId, setStoppingPlanId] = useState<string | null>(null);

  // 审批通过（state 变 launching）后卡片本就隐藏；这里顺手把 Modal 关掉，避免退场残留。
  useEffect(() => {
    if (!isPlanCardVisible(plan)) { setOpen(false); setDiscardPrompt(false); }
  }, [plan]);

  // 关掉弹框后「有未保存改动」不再成立（草稿随 PlanEditor 卸载而消失）。计划本身变化时
  // **不**在这里清 —— 有未保存改动时 PlanEditor 会保留草稿，由它自己上报真实的 dirty。
  useEffect(() => {
    if (!open) {
      setDirty(false);
      setDiscardPrompt(false);
    }
  }, [open]);

  // 关闭的唯一入口：busy 时按住不放（批准/停止在途）；二次确认已展开时先撤掉它
  // （Esc / 再点遮罩 = 取消这次关闭，不是放弃草稿）；dirty 时先进二次确认。
  const requestClose = (): void => {
    if (busy) return;
    if (discardPrompt) {
      setDiscardPrompt(false);
      return;
    }
    if (dirty) setDiscardPrompt(true);
    else setOpen(false);
  };
  const discardAndClose = (): void => {
    setDiscardPrompt(false);
    setDirty(false);
    setOpen(false);
  };

  // 共享模态 hook：Esc 在 capture 段收口（preventDefault + stopPropagation，
  // 不会再冒泡到全局 Esc 停掉正在运行的 agent、也不会冒泡到 Settings 的
  // listenForPanelEscape），Tab 圈禁在面板内，打开时焦点进面板、关闭归还
  // 「审阅」按钮（a11y.md P1）。Esc 与遮罩/Close 走同一条 requestClose。
  // `enabled` 只取决于 open：dirty 切换不能重挂模态（否则模态栈被反复压入）。
  const panelRef = useModalDismiss<HTMLDivElement>(requestClose, open);

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
            onRequestClose: requestClose,
            onDiscard: discardAndClose,
            onCancelDiscard: () => setDiscardPrompt(false),
            discardPrompt,
            panelRef,
            editor: true,
            cwd,
            saving,
            saveError,
            conflict,
            dirty,
            approveError,
            onDirtyChange: setDirty,
            ...(onStop
              ? {
                  onStop: () => {
                    setStoppingPlanId(plan.planId);
                    onStop();
                  },
                }
              : {}),
            stopping: stoppingPlanId === plan.planId,
            ...(onSave ? { onSave } : {}),
            ...(onReload ? { onReload } : {}),
          })
        : null}
    </section>
  );
}
