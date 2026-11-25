"use client";

import { useEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
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
 * - 传 `editor: true` → 渲染 `PlanEditor`（成员勾选/批量设模型/跟随队长/逐个改 agent 与模型/
 *   任务负责人；`draft` / `review_pending` 才可编辑）；
 * - 没传 → 退回只读名册（纯展示场景与静态断言用）。
 *
 * 批准按钮的 disabled 口径 = `isApproveDisabled`（图校验：未分配任务 / 非法成员名）
 * || **状态不是 review_pending**（批准路由对其它状态一律 409） || busy。**有未保存的
 * 编辑不再禁用批准**：点批准时先把编辑器 diff PATCH 落盘，再用保存后的 revision 投递，
 * 所以用户不需要「保存改动」这个中间步骤。
 *
 * 阶段显示（对齐 cc-haha AgentTeamsPlanCard.tsx:83）：draft / review_pending / launch_failed
 * / interrupted 显示；无 plan、launching、running、cancelled 且无 parentPlanId 隐藏。
 * approve 成功 → 状态变 launching → 卡片自动消失。
 *
 * 停止按钮（对齐 cc-haha AgentTeamsPlanCard.tsx:170-174）：`canStop = Boolean(plan.parentPlanId)`
 * 时显示——只有「加入运行中团队的新增计划」才需要停 lead 会话生成；点击调 `onStop`
 * （ChatWindow 接 `handleAbort` 停本会话生成）。点击后按钮禁用并显示「正在停止…」。
 *
 * **停止态必须能复位**：abort 不保证带来计划状态变化（计划可能停在 interrupted 之外的
 * 状态、或 aborts 后被新回合接着跑），旧实现「不主动清」会让按钮永远停在「正在停止…」，
 * 再也没法点第二次。现在三条复位路径：计划 id / state 变化（真的走过去了）、弹框关闭
 * （重新打开就是一次新操作）、以及 15s 兜底（请求没有落地时按钮必须自己活过来）。
 *
 * 纯展示 + 回调：数据由调用方用 `useTeamPlan(teamName)` 提供；approve 只是回调（由 hook
 * 投递给 lead，桌面不写盘），save 走 PATCH。本组件自判断可见性，不满足时返回 null。
 * 样式内联 + 主题 CSS 变量，不新增全局类。
 */
interface Props {
  plan: TeamPlanView | null;
  /** 读 agent 预设用的项目目录（会话 cwd）；缺省时成员详情只显示当前 agentType。 */
  cwd?: string | null;
  /**
   * 当前会话的主模型（`provider/modelId`）。计划里成员 runtime 是 `unknown/unknown` 占位时
   * 用它预填模型栏——用户看到的就是「默认主模型」，想改再改，而不是一个空下拉。
   */
  defaultModelRef?: string;
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
  /**
   * 批准指令已送达 lead。到达即收起弹框——否则要等 lead 跑完一整轮、再等一拍轮询，
   * 用户看到的就是「点了批准，好久才关」。
   */
  delivered?: { planId: string; revision: number } | null;
  /** 点「停止」；停 lead 会话生成（由调用方接 abort，cc-haha stopGeneration 同款）。 */
  onStop?: () => void;
  /** 点「批准」；携带编辑器里待保存的改动（无改动为 null），由上层先保存再投递。 */
  onApprove?: (edits: PlanEdits | null) => void;
  /** 409 后重新载入。 */
  onReload?: () => void;
}

export type PlanEdits = { members: PlanMemberEditDraft[]; tasks: PlanTaskEditDraft[] };

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
  // 收缩态卡片：**宽度由外层容器决定**（ChatWindow 的聊天列 wrapper 管 max-width / 内边距，
  // 见 lead 在 ChatWindow.tsx 的改动）。这里只保证「容器多窄都不溢出」，绝不写死宽度：
  // - width/maxWidth 100% + boxSizing border-box：padding 与 border 不再额外吃宽
  //   （content-box 下 100% 宽 + 24px padding 会横向溢出 24px）；
  // - minWidth 0：作为 flex/grid 子项时允许收缩到内容 min-content 以下，
  //   否则长团队名/长错误文本会把卡片顶出聊天列；
  // - overflow 不裁切：弹框走 createPortal 到 body，不受这里影响。
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
  },
  /** 收缩态第一行（图标 + 文案 + 查看配置）：minWidth 0 让中间文案列可收缩。 */
  barRow: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  icon: { flex: "0 0 auto", color: "var(--text-muted)" },
  text: { display: "flex", flexDirection: "column", gap: 2, flex: "1 1 auto", minWidth: 0 },
  label: { fontSize: "var(--fs-micro)", color: "var(--text-dim)" },
  name: { fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", overflowWrap: "anywhere", maxWidth: "100%" },
  // 徽标 + 成员数：窄容器里换行而不是把「查看配置」挤出去。
  meta: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0, fontSize: "var(--fs-caption)", color: "var(--text-muted)" },
  badge: { flex: "0 0 auto", whiteSpace: "nowrap", padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border)", fontSize: "var(--fs-micro)" },
  // flexShrink 0：按钮文案不换行、不被长团队名挤掉（用户反馈里它必须始终可点）。
  review: {
    flex: "0 0 auto",
    flexShrink: 0,
    whiteSpace: "nowrap",
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
    // 顶带被顶栏盖住，aria-modal 期间顶栏仍可点。卡片挂载处（ChatWindow 的 composer
    // 上方包装层）带 overflow 会裁切 fixed 子元素，所以 AgentTeamPlanCard 在 `open`
    // 时把整棵 modal 树 createPortal 到 document.body（脱掉裁剪上下文），这里只需
    // 与全局对话框同层。
    zIndex: "var(--z-modal)",
  },
  dialog: {
    // 与输入框等宽：跟随聊天内容列的实际宽度（--chat-content-region-width 由 ChatWindow
    // 的 ResizeObserver 写入 = 聊天列容器宽 - 左右内边距），聊天列变窄时弹框同步收窄；
    // 聊天列宽于上限时取 --chat-content-max-width。
    //
    // 兜底必须是**真实像素**，不能是 100%：region 变量只在 ChatWindow 挂载时写入，
    // 计划卡在别的页面/未挂载时拿到的就是 fallback。旧写法 `var(..., 100%)` 让弹框
    // 铺满整屏（用户截图里的「横跨整个聊天列甚至更宽」）。现在 fallback = 820px，
    // 三种情况都对：变量缺失 → 820 上限；变量存在 → 跟随聊天列；100% 仍保留，
    // 小窗口（<480px 视口、遮罩左右各 16px 内边距）不溢出。
    //
    // `boxSizing: border-box` 必须保留：content-box 下 width 不含 padding/border，
    // 100% 宽时每侧会多出 16px，弹框在窄窗口里左右各溢出一截。
    width: "min(var(--chat-content-max-width, 820px), var(--chat-content-region-width, 820px), 100%)",
    maxWidth: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    overflowWrap: "anywhere",
    // 高度自适应、内容超出时**面板内滚动**（12 行成员 + 20 个任务也不会把关闭/批准按钮
    // 推到视口外）。overscroll-behavior 防滚到底后带动背后的聊天列滚动。
    //
    // 滚动放在**内容区**而不是面板本身：面板整体 `overflow:auto` 时，底部那排
    // 「关闭 / 批准 / 停止」会跟着内容一起滚走，用户翻到任务列表中间就找不到批准按钮了
    // （用户报的「按钮要一直固定在下面」）。现在面板是 flex 列、`overflow:hidden`，
    // 中间内容自己滚，footer 用 `flexShrink: 0` 常驻底部。
    maxHeight: "min(78vh, 640px)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    overscrollBehavior: "contain",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    // 小窗口（<480px 视口）里 16px 固定内边距会把内容压到 300px 以下，用 clamp 收一档。
    padding: "clamp(10px, 2.5vw, 16px)",
  },
  dialogHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  // 标题里带团队名（模型生成，可能很长）：minWidth 0 + anywhere 让标题换行/收缩，
  // 而不是把状态徽标挤出面板。
  h2: { minWidth: 0, overflowWrap: "anywhere", fontSize: "var(--fs-title)", fontWeight: "var(--fw-semibold)", color: "var(--text)", margin: 0 },
  section: { marginTop: 14 },
  h4: { fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", color: "var(--text-muted)", margin: "0 0 6px" },
  member: { padding: "6px 0", borderTop: "1px solid var(--border)" },
  memberName: { fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", color: "var(--text)", overflowWrap: "anywhere" },
  mono: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--text-muted)", overflowWrap: "anywhere" },
  muted: { fontSize: "var(--fs-caption)", color: "var(--text-muted)", overflowWrap: "anywhere" },
  prompt: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--text-dim)", whiteSpace: "pre-wrap", margin: "4px 0 0", overflowWrap: "anywhere" },
  task: { padding: "6px 0", borderTop: "1px solid var(--border)", fontSize: "var(--fs-caption)", color: "var(--text)", overflowWrap: "anywhere" },
  // 告警行：服务端 / 模型写的错误文本可能很长（路径、URL、模型名），必须能断行，
  // 否则一条 alert 就能把弹框撑出横向滚动。
  alert: { color: "var(--danger)", fontSize: "var(--fs-caption)", margin: "6px 0", overflowWrap: "anywhere" },
  confirmRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "6px 0", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--danger)", background: "var(--bg-panel)" },
  // 面板内唯一滚动区：标题与底部按钮都留在外面，翻内容不会把按钮带走。
  // `minHeight: 0` 是 flex 子项能真正收缩、出现滚动条的前提（少了它子项按内容撑开，
  // 溢出会被面板的 `overflow: hidden` 裁掉，底部内容直接看不见）。
  dialogScroll: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" },
  // 窄窗口里三个按钮换行，不挤出面板。`flexShrink: 0` + 上边框：常驻底部、与内容分界。
  footer: { flexShrink: 0, display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 },
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
    defaultModelRef?: string;
    saving?: boolean;
    saveError?: string | null;
    conflict?: boolean;
    onReload?: () => void;
    /** 传 true 才渲染可编辑区（需要 React hook，无 DOM 的纯视图测试默认不传）。 */
    editor?: boolean;
    /** 可编辑区有未保存改动（关闭时二次确认用；不再禁用批准）。 */
    dirty?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    /** 编辑器草稿 diff 变化回调（批准时由卡片先保存）。 */
    onDraftChange?: (edits: PlanEdits | null) => void;
    /** 关闭确认进行中（dirty 时点关闭进入此态，面板内出现二次确认行）。 */
    discardPrompt?: boolean;
    /** 二次确认：放弃未保存改动并关闭。 */
    onDiscard?: () => void;
    /** 二次确认里点「取消」：留在卡片里继续编辑。 */
    onCancelDiscard?: () => void;
    /** dirty 时点关闭/遮罩/Esc/Close 走这里（必须走 requestClose，不能直接 onClose）。 */
    onRequestClose?: () => void;
    /** 关闭按钮是否禁用（缺省不禁用：busy 时也允许关，理由见 requestClose）。 */
    closeDisabled?: boolean;
    /** 模态面板 ref（useModalDismiss 返回；纯视图不传时降级为无焦点管理）。 */
    panelRef?: Ref<HTMLDivElement>;
    /** 批准失败的原因（投递失败 / 409 等），由 useTeamPlan 记录。 */
    approveError?: string | null;
    /** 批准指令已送达 lead 的信号（`useTeamPlan` 的 `delivered`）：到达即收起弹框。 */
    delivered?: { planId: string; revision: number } | null;
    /** 点「停止」（停 lead 会话生成）；缺省时停止按钮不出现。 */
    onStop?: () => void;
    /** 正在执行停止（按钮禁用并显示「正在停止…」）。 */
    stopping?: boolean;
  } = {},
) {
  const review = derivePlanReview(plan);
  const approveDisabled =
    isApproveDisabled(plan) || !isPlanApprovable(plan) || Boolean(options.busy);
  // cc-haha 同款口径：带 parentPlanId 的卡片（加入运行中团队的新增计划）才给停止按钮。
  const canStop = Boolean(plan.parentPlanId) && Boolean(options.onStop);
  // 三条关闭路径（遮罩 / Close / Esc）统一走 requestClose：dirty 时先进二次确认，
  // 不再静默卸载 PlanEditor 丢掉模型/负责人草稿（interaction.md P1）。没有可编辑
  // 区时 requestClose 就是 onClose 的同义词。
  const requestClose = options.onRequestClose ?? options.onClose;
  const editable = options.editor === true && (plan.state === "draft" || plan.state === "review_pending");
  // 启动失败的错误信息：空串/纯空白不渲染（plan.json 里可能留着 " "）。
  const launchError = plan.launch?.error?.trim() ? plan.launch.error : null;
  return (
    <div style={S.overlay} data-testid="team-plan-overlay" onClick={requestClose}>
      <div
        ref={options.panelRef}
        className="team-plan-dialog"
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
        {/* 可滚动内容区：标题与底部按钮都在它外面，翻到任务列表中间也看得见「批准」。 */}
        <div style={S.dialogScroll} data-testid="team-plan-scroll">
        <p style={S.muted}>{t("teams.plan.reviewHint")}</p>
        {/* 告警区：把「为什么不能批准 / 上次为什么失败」集中到弹框顶部，按
            启动失败 → 非法成员名 → 未分配任务 → 批准失败 的顺序自上而下排（严重度递减），
            不再一半在顶部、一半在编辑器下面（用户反馈层级混乱、容易漏看）。每条都带
            role="alert" + anywhere 断行，长错误文本不会把弹框撑出横向滚动。 */}
        {launchError ? (
          <p style={S.alert} role="alert" data-testid="team-plan-launch-error">
            {launchError}
          </p>
        ) : null}
        {review.invalidNames.length > 0 ? (
          <p style={S.alert} role="alert" data-testid="team-plan-invalid-names">
            {t("teams.plan.invalidNames", { names: review.invalidNames.join(", ") })}
          </p>
        ) : null}
        {review.hasUnassignedTasks ? (
          <p style={S.alert} role="alert" data-testid="team-plan-unassigned-summary">
            {t("teams.plan.assignRequired")}
          </p>
        ) : null}
        {options.approveError ? (
          <p style={S.alert} role="alert" data-testid="team-plan-approve-error">
            {options.approveError}
          </p>
        ) : null}

        {options.editor ? (
          <PlanEditor
            plan={plan}
            cwd={options.cwd ?? null}
          defaultModelRef={options.defaultModelRef ?? ""}
            editable={editable}
            saving={options.saving ?? false}
            saveError={options.saveError ?? null}
            conflict={options.conflict ?? false}
            {...(options.onReload ? { onReload: options.onReload } : {})}
            {...(options.onDirtyChange ? { onDirtyChange: options.onDirtyChange } : {})}
            {...(options.onDraftChange ? { onDraftChange: options.onDraftChange } : {})}
          />
        ) : (
          <>
            <section style={S.section} aria-label={t("teams.plan.roster")}>
              {/* 成员数文案与可编辑分支**同一个 key**（teams.plan.memberCount），
                  两个分支长得一样，用户来回切换不会看到两套计数写法。 */}
              <h4 style={S.h4}>{t("teams.plan.memberCount", { count: plan.members.length })}</h4>
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
                plan.tasks.map((task) => {
                  // owner 指到一个已不存在的成员也算「未分配」：只发 assignRequired 一条，
                  // 而不是「负责人：未分配」再叠一条同样的告警（旧实现同义行重复两遍）。
                  const owner = plan.members.find((member) => member.id === task.ownerId);
                  return (
                    <div key={task.id} style={S.task} data-task-id={task.id}>
                      <div style={{ overflowWrap: "anywhere" }}>{task.subject}</div>
                      <div style={S.mono}>
                        {t("teams.plan.owner")}: {owner ? owner.name : t("teams.plan.unassigned")}
                        {task.dependencies.length > 0
                          ? ` · ${t("teams.plan.dependencies")}: ${task.dependencies.join(", ")}`
                          : ""}
                      </div>
                      {!owner ? (
                        <div style={S.alert} role="alert" data-testid="team-plan-unassigned">
                          {t("teams.plan.assignRequired")}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </section>
          </>
        )}

        {/* dirty 时点关闭 → 二次确认行（interaction.md P1：草稿不能被静默丢弃）。
            Esc / 遮罩 / Close 三条路径都由 requestClose 走进这里，不再直接卸载。 */}
        {options.discardPrompt ? (
          <div style={S.confirmRow} data-testid="team-plan-discard-prompt">
            <p style={{ ...S.alert, margin: 0, flex: 1, minWidth: 0 }} role="alert">
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

        </div>

        <div style={S.footer}>
          {/* busy 不再禁用关闭：批准已投递出去，弹框只是展示层；把 Close 变灰、
              Esc/遮罩又「点了没反应」是用户报的那个死路。禁用只留给调用方显式传
              closeDisabled 的场景。 */}
          <button type="button" data-testid="team-plan-close" style={S.ghost} onClick={requestClose} disabled={options.closeDisabled ?? false}>
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
  defaultModelRef = "",
  busy = false,
  saving = false,
  saveError = null,
  conflict = false,
  error = null,
  approveError = null,
  delivered = null,
  onStop,
  onApprove,
  onReload,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // 编辑器草稿 diff（null = 无改动）：点批准时随批准一起保存。
  const editsRef = useRef<PlanEdits | null>(null);
  // 可编辑区有未保存改动：只用于关闭时二次确认，不再拦住批准。
  const [dirty, setDirty] = useState(false);
  // dirty 时点关闭 → 停在卡片里问「放弃未保存的修改？」（interaction.md P1）。
  // 三条关闭路径（Esc / 遮罩 / Close）都先到这里，确认后才真关。
  const [discardPrompt, setDiscardPrompt] = useState(false);
  // 正在执行停止的 planId（按钮禁用 + 「正在停止…」）。
  //
  // 旧实现「不主动复位」是死路：abort 并不保证带来计划状态变化（用户可能压根不在
  // 生成中 / abort 后又被新一轮消息接着跑），按钮就永远卡在「正在停止…」，再也点不动。
  // 现在三条复位路径（见下面两个 effect）：planId 或 state 变化、弹框关闭、15s 兜底。
  const [stoppingPlanId, setStoppingPlanId] = useState<string | null>(null);

  // 审批通过（state 变 launching）后卡片本就隐藏；这里顺手把 Modal 关掉，避免退场残留。
  useEffect(() => {
    if (!isPlanCardVisible(plan)) { setOpen(false); setDiscardPrompt(false); }
  }, [plan]);

  /**
   * 批准指令**已送达 lead** ⇒ 立刻收起弹框。
   *
   * 为什么需要这条（用户报「都审批了好久了，才关闭」）：唯一的自动关闭路径在上面——
   * 它等的是 `plan` 从 `review_pending` 走到 `launching`，而状态只能由**被唤醒后的 lead**
   * 调 `team_plan approve` 写入。也就是「点批准 → 弹框关」中间隔着一整个模型回合，
   * 轮询还得再等一拍（2s）。
   *
   * 送达就收起：用户表达的意图已经交付，不必盯着弹框等模型跑完。真实流转仍由轮询在后台
   * 确认；**失败一定可见**——`approveError` 非空时卡片会重新出现（见下面的可见性判据），
   * 收缩态也会把这句话显示出来。
   */
  useEffect(() => {
    if (!delivered) return;
    if (plan && delivered.planId !== plan.planId) return;
    setOpen(false);
    setDiscardPrompt(false);
  }, [delivered, plan]);

  // 计划换了一条、或状态真的流转了 → 上次那次「停止」已经落地，复位进行态。
  // 依赖 planId/state 而不是 plan 对象：轮询每 2s 重新解析一份 JSON，对象身份不稳定。
  const stoppingResetKey = `${plan?.planId ?? ""}:${plan?.state ?? ""}`;
  useEffect(() => {
    setStoppingPlanId(null);
  }, [stoppingResetKey]);

  // 兜底：请求没落地（abort 无响应 / 计划状态不变）时也不能一直禁用，15s 后自己活过来。
  useEffect(() => {
    if (!stoppingPlanId) return;
    const timer = setTimeout(() => setStoppingPlanId(null), 15_000);
    return () => clearTimeout(timer);
  }, [stoppingPlanId]);

  // 关掉弹框后「有未保存改动」不再成立（草稿随 PlanEditor 卸载而消失），停止态也一并复位
  // （重新打开弹框就是一次新操作，按钮必须可点）。计划本身变化时**不**在这里清 —— 有未保存
  // 改动时 PlanEditor 会保留草稿，由它自己上报真实的 dirty。
  useEffect(() => {
    if (!open) {
      setDirty(false);
      setDiscardPrompt(false);
      setStoppingPlanId(null);
      editsRef.current = null;
    }
  }, [open]);

  // 关闭的唯一入口：三条路径（遮罩 / Close / Esc）都到这里。
  // - 二次确认已展开时先撤掉它（Esc / 再点遮罩 = 取消这次关闭，不是放弃草稿）；
  // - dirty 时进二次确认（草稿不能被静默丢弃）；
  // - **busy（批准在途）也照样关**：批准请求已经带着 diff 投递出去了，弹框只是展示层，
  //   旧写法 `if (busy) return` 会让 Esc/遮罩变成「点了没反应」的死路（用户反馈）。
  //   计划流转到 launching 时卡片自己也会退场，不会残留半开的面板。
  const requestClose = (): void => {
    if (discardPrompt) {
      setDiscardPrompt(false);
      return;
    }
    if (busy || !dirty) {
      setOpen(false);
      return;
    }
    setDiscardPrompt(true);
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

  // 无 plan 且拉取失败：不能再直接 return null 把错误吞掉——否则轮询失败时计划卡
  // 静默消失，用户不知道后台还在重试。给一条可见提示（teams.plan.loadFailed）。
  if (!plan) {
    if (!error) return null;
    return (
      <section
        aria-label={t("teams.plan.title")}
        data-testid="team-plan-card"
        data-plan-error="true"
        role="status"
        style={{ ...S.bar, flexDirection: "column", alignItems: "stretch" }}
      >
        <p style={S.alert} role="alert" data-testid="team-plan-load-error" title={error}>
          {t("teams.plan.loadFailed")}
        </p>
      </section>
    );
  }

  if (!isPlanCardVisible(plan)) return null;

  return (
    <section
      aria-label={t("teams.plan.title")}
      data-testid="team-plan-card"
      style={{ ...S.bar, flexDirection: "column", alignItems: "stretch" }}
    >
      <div style={S.barRow}>
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
        // 轮询/接口错误文本可能很长（URL、堆栈式描述）：换行而不是把卡片撑出聊天列；
        // title 保留完整文本，方便鼠标悬停看全。
        <p style={{ ...S.alert, margin: "6px 0 0", minWidth: 0 }} role="alert" title={error}>
          {error}
        </p>
      ) : null}
      {approveError ? (
        // 批准已经「送达即收弹框」（乐观关闭），失败的可见性必须搬到这里：弹框一关，
        // 里面那条 approveError 就没人看得到了。收缩态带上它，用户才不会以为已批准。
        <p style={{ ...S.alert, margin: "6px 0 0", minWidth: 0 }} role="alert" data-testid="team-plan-approve-error-bar" title={approveError}>
          {approveError}
        </p>
      ) : null}
      {open && typeof document !== "undefined"
        ? // Portal 到 body：卡片挂在 composer 上方的包装层里，那一层带
          // `overflow-y: auto`（ChatWindow 限高 45dvh/440px），fixed 遮罩会被它
          // 裁切——遮罩只盖住那条窄带、对话框被切掉大半。脱到 body 才与全屏
          // 对话框同层（--z-modal），遮罩覆盖全视口、弹框完整居中。
          createPortal(
            planModalView(t, plan, {
              busy,
              // 批准携带编辑器 diff：上层先 PATCH 再用新 revision 投递。
              onApprove: () => onApprove?.(editsRef.current),
              onClose: () => setOpen(false),
              onRequestClose: requestClose,
              onDiscard: discardAndClose,
              onCancelDiscard: () => setDiscardPrompt(false),
              discardPrompt,
              panelRef,
              editor: true,
              cwd,
              defaultModelRef,
              saving,
              saveError,
              conflict,
              dirty,
              approveError,
              onDirtyChange: setDirty,
              onDraftChange: (edits) => { editsRef.current = edits; },
              ...(onStop
                ? {
                    onStop: () => {
                      setStoppingPlanId(plan.planId);
                      onStop();
                    },
                  }
                : {}),
              stopping: stoppingPlanId === plan.planId,
              ...(onReload ? { onReload } : {}),
            }),
            document.body,
          )
        : null}
    </section>
  );
}
