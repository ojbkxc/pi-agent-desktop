"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { AppSelect } from "@/components/AppSelect";
import { ConfigButton } from "@/components/SettingsUi";
import { isUsableRuntime, type PlanRuntimeView, type TeamPlanView } from "@/lib/agent-teams-plan";

/**
 * B3 计划卡的**可编辑**内容（对齐 cc-haha AgentTeamsPlanCard 的弹框）。
 *
 * 本轮补上的能力（原先弹框只读）：
 * - 成员列表可勾选 → 批量设模型 / 跟随队长；
 * - 逐个成员改 agent 预设与服务商+模型；
 * - 任务负责人下拉（含「未分配」）。
 *
 * 数据流：本地草稿 → 上报 diff（`onDraftChange`）→ 卡片点「批准」时先
 * `PATCH /api/teams/[team]/plan` 再投递批准 prompt。没有独立的「保存改动」按钮：
 * 编辑只在批准时一并落盘，避免「改了模型但忘了保存」的多余步骤。
 *
 * 模型目录来自 `useModelCatalog()`（与团队成员换模型面板同源）；agent 预设来自
 * `/api/subagents/profiles?cwd=`，读不到时只展示当前值、不阻塞模型与任务编辑。
 */

export interface PlanMemberEditDraft {
  id: string;
  agentType?: string;
  runtime?: { providerId: string; modelId: string; effortLevel?: string };
}

export interface PlanTaskEditDraft {
  id: string;
  ownerId?: string;
}

/** 思考级别（与 pi SDK 的 `ThinkingLevel` 同集；空串 = 未设置）。 */
export const PLAN_EFFORT_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 编辑器里的成员草稿（`effortLevel` 空串 = 未设置）。 */
export interface PlanMemberDraft {
  agentType: string;
  modelRef: string;
  effortLevel: string;
}
export interface PlanDraft {
  members: Record<string, PlanMemberDraft>;
  tasks: Record<string, string>;
}

/** `provider/modelId` → 两个字段（provider 里不含斜杠，模型 id 可能含）。 */
export function splitModelRef(ref: string): { providerId: string; modelId: string } | null {
  if (!ref) return null;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export function joinModelRef(providerId: string, modelId: string): string {
  return providerId && modelId ? `${providerId}/${modelId}` : "";
}

/** 成员在计划里的模型 ref。运行时是 `unknown/unknown` 占位（`isUsableRuntime` = false）时
 * 返回**空串**，不是 `"unknown/unknown"`。
 *
 * 这是旧实现最脏的一处：pi-team 从不设置 PI_PROVIDER_ID/PI_MODEL_ID，真实机器上成员/队长
 * 运行时经常是 `unknown/unknown`。把它原样拼成 ref 会有三重坏处——下拉里出现一个假选项、
 * 「跟随队长」写进一个必然 spawn 失败的模型、以及 diff 把占位值当「用户改过」发回服务端。
 * 空串在下拉里显示「未设置」，也只有空串能让 `diffPlanEdits` 正确判定「这一项没动」。 */
export function planMemberModelRef(runtime: PlanRuntimeView | null | undefined): string {
  if (!runtime || !isUsableRuntime(runtime)) return "";
  return joinModelRef(runtime.providerId, runtime.modelId);
}

/** `provider/model` 形式的 ref 是否是一个能真正跑起来的模型（非空、非 unknown 占位）。 */
export function isUsableModelRef(ref: string | null | undefined): boolean {
  const runtime = splitModelRef(ref ?? "");
  return Boolean(runtime) && isUsableRuntime(runtime);
}

/** 从计划里取单个成员的草稿基线（批量操作落到「草稿里还没有的成员」时用它兜底）。 */
export function baselineMemberDraft(plan: TeamPlanView, id: string): PlanMemberDraft | null {
  const member = plan.members.find((item) => item.id === id);
  if (!member) return null;
  return {
    agentType: member.agentType,
    modelRef: planMemberModelRef(member.runtime),
    effortLevel: member.runtime.effortLevel ?? "",
  };
}

/** 只把**真正改过**的字段放进 PATCH 体（与 cc-haha teamPlansApi.save 同口径）。
 *
 * 思考级别随模型一起打包：`runtime` 是个整体，只改模型时也要**带上草稿里现有的级别**，
 * 否则写路径按「未给出 = 清空」处理，会静默丢掉计划里原本设好的级别（用户看不到这一项，
 * 也就无从察觉）。
 */
export function diffPlanEdits(plan: TeamPlanView, draft: PlanDraft, fallbackModelRef = ""): {
  members: PlanMemberEditDraft[];
  tasks: PlanTaskEditDraft[];
} {
  const members: PlanMemberEditDraft[] = [];
  // 预填的「主模型」必须与草稿基线同口径，否则一打开弹框就被判成「有未保存更改」：
  // `draftFromPlan` 用 fallback 填了模型栏，这里若拿 `unknown/unknown` 去比，`modelChanged`
  // 恒为 true —— 用户什么都没动，卡片却提示改过，`dirty` 还会拦住草稿基线随轮询更新
  // （`if (!dirtyRef.current)` 那条），于是一路停在旧 revision 上。
  const fallback = isUsableModelRef(fallbackModelRef) ? fallbackModelRef : "";
  const fallbackRuntime = fallback ? splitModelRef(fallback) : null;
  for (const member of plan.members) {
    const edited = draft.members[member.id];
    if (!edited) continue;
    const next: PlanMemberEditDraft = { id: member.id };
    let changed = false;
    if (edited.agentType && edited.agentType !== member.agentType) {
      next.agentType = edited.agentType;
      changed = true;
    }
    const runtime = splitModelRef(edited.modelRef);
    // 空 ref 与 unknown 占位都不进 PATCH：runtime 是个整体，把 `unknown/unknown` 写回去
    // 等于给成员装一个必然 spawn 失败的模型（旧实现照抄占位值）。
    if (runtime && isUsableRuntime(runtime)) {
      const effort = edited.effortLevel ?? "";
      // 基线：计划里有可用 runtime 就用它；否则用预填的主模型（与草稿同源）。
      const base = isUsableRuntime(member.runtime)
        ? { providerId: member.runtime.providerId, modelId: member.runtime.modelId }
        : fallbackRuntime;
      const modelChanged = !base
        || runtime.providerId !== base.providerId
        || runtime.modelId !== base.modelId;
      const effortChanged = effort !== (member.runtime.effortLevel ?? "");
      if (modelChanged || effortChanged) {
        next.runtime = { ...runtime, ...(effort ? { effortLevel: effort } : {}) };
        changed = true;
      }
    }
    if (changed) members.push(next);
  }
  const tasks: PlanTaskEditDraft[] = [];
  for (const task of plan.tasks) {
    if (!(task.id in draft.tasks)) continue;
    const ownerId = draft.tasks[task.id];
    if ((ownerId || undefined) !== (task.ownerId || undefined)) tasks.push({ id: task.id, ownerId });
  }
  return { members, tasks };
}

/** 从 plan 生成编辑草稿（保存成功后用它重置基线）。 */
/**
 * 从计划里取出编辑草稿的基线。
 *
 * `fallbackModelRef` 是**当前会话的主模型**：计划里成员的 runtime 在真实机器上常常是
 * `unknown/unknown`（pi-team 读 `PI_PROVIDER_ID`/`PI_MODEL_ID`，本服务从不设置它们），
 * 归一后就成了空串，模型栏显示「未设置」——用户看到的是一个空下拉，只能自己从头挑，
 * 而他要的是「默认就是主模型，想改再改」。
 *
 * 所以：计划里没有可用模型时，用主模型预填。这是**真值**而不是 placeholder——用户不动它
 * 就按主模型批准（`diffPlanEdits` 会因为「草稿 ≠ 计划基线」把它写进 PATCH），动了就按他选的。
 */
export function draftFromPlan(plan: TeamPlanView, fallbackModelRef = ""): PlanDraft {
  const members: Record<string, PlanMemberDraft> = {};
  const fallback = isUsableModelRef(fallbackModelRef) ? fallbackModelRef : "";
  for (const member of plan.members) {
    members[member.id] = {
      agentType: member.agentType,
      // unknown 占位 → 主模型；连主模型都没有才留空（那时「未设置」才是实情）。
      modelRef: planMemberModelRef(member.runtime) || fallback,
      effortLevel: member.runtime.effortLevel ?? "",
    };
  }
  const tasks: Record<string, string> = {};
  for (const task of plan.tasks) tasks[task.id] = task.ownerId ?? "";
  return { members, tasks };
}

/** 草稿是否与服务端一致（「有未保存的更改」提示与保存按钮的 enabled 口径）。 */
export function isDraftDirty(plan: TeamPlanView, draft: PlanDraft, fallbackModelRef = ""): boolean {
  const edits = diffPlanEdits(plan, draft, fallbackModelRef);
  return edits.members.length > 0 || edits.tasks.length > 0;
}

interface Props {
  plan: TeamPlanView;
  /**
   * 读 agent 预设用的项目目录（通常是该会话的 cwd）。缺省时不请求预设接口，
   * 成员详情只显示当前 agentType、不允许改它（模型与任务仍可编辑）。
   */
  cwd?: string | null;
  /**
   * 当前会话的主模型（`provider/modelId`）。计划里成员的 runtime 是 `unknown/unknown`
   * 时用它预填模型栏——「默认就是主模型，想改再改」，而不是让用户面对一个空下拉。
   * 缺省或不可用时留空（那时「未设置」是实情）。
   */
  defaultModelRef?: string;
  /** 是否允许编辑（draft / review_pending）。 */
  editable: boolean;
  /** 保存进行中（批准前自动保存时由上层置位）。 */
  saving?: boolean;
  /** 保存错误。 */
  saveError?: string | null;
  /**
   * 草稿发生变化时上报「只含真正改过字段」的 PATCH 体（null = 与服务端一致）。
   * 卡片拿它在批准时先保存；本组件不再提供独立的「保存改动」按钮。
   */
  onDraftChange?: (edits: { members: PlanMemberEditDraft[]; tasks: PlanTaskEditDraft[] } | null) => void;
  /** 计划已被别人改过（409）：提示重新载入。 */
  conflict?: boolean;
  onReload?: () => void;
  /**
   * 草稿是否与已保存的计划不同。卡片据此**禁用批准**：不这么做的话，「改了模型但忘了保存、
   * 直接点批准」会按旧模型启动团队（cc-haha 的 presetChanged 就是拦这个）。
   */
  onDirtyChange?: (dirty: boolean) => void;
}

/** 成员名册 / 任务分配两列布局由 **CSS 容器查询** 控制（app/native-theme.css 的
 * `.team-plan-editor` / `@container` 规则）：两列在编辑器容器宽 ≥760px 时出现，
 * 任务行与成员字段在 ≥560px 时排成两列。不能按视口宽切列——弹框现在与聊天
 * 输入框等宽，聊天列被收窄而视口仍宽时，视口断点不会切单列，内容反而被挤扁
 * （对齐 cc-haha AgentTeamsPlanCard.tsx 的 @container / @min-[760px] / @min-[560px]）。
 */
const S = {
  roster: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  // 行容器只做布局：`cursor: pointer` 挂在这里会骗人——整行看着可点，但点击处理在内部
  // 那个 `<button>` 上，左右各 8px 的内边距是纯死区（团队计数审计 P3-1）。指针语义交给
  // 按钮自己（它本来就带 cursor: pointer）。
  row: (active: boolean) => ({
    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8,
    background: active ? "var(--bg-selected)" : "transparent",
  }),
  rowMeta: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 },
  name: { fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", color: "var(--text)", overflowWrap: "anywhere" },
  mono: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--text-muted)", overflowWrap: "anywhere" },
  section: { marginTop: 16 },
  h4: { fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", color: "var(--text-muted)", margin: "0 0 6px" },
  field: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  label: { fontSize: "var(--fs-micro)", color: "var(--text-muted)" },
  batch: { marginTop: 10, padding: "8px 10px", borderRadius: 10, background: "var(--bg-subtle, var(--bg-panel))", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", overflowWrap: "anywhere" },
  // 列数由 `.team-plan-task-row` 的容器查询切换（app/native-theme.css）。
  taskRow: { display: "grid", gap: 8, alignItems: "start", padding: "6px 0", borderTop: "1px solid var(--border)" },
  footer: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12, flexWrap: "wrap" },
  alert: { color: "var(--danger)", fontSize: "var(--fs-caption)", margin: "6px 0" },
  hint: { fontSize: "var(--fs-micro)", color: "var(--text-dim)", margin: "4px 0 0" },
} as const;

export function PlanEditor({ plan, cwd = null, defaultModelRef = "", editable, saving = false, saveError = null, onDraftChange, conflict = false, onReload, onDirtyChange }: Props) {
  const { t } = useI18n();
  // cwd 必须传下去：不带 cwd 时 `/api/models` 退回**进程** cwd（打包版是
  // `resources/server`，不在文件白名单里）→ 400 → 目录为空，「已选 N 名」旁边的
  // 模型下拉一个选项都没有。
  const catalog = useModelCatalog(cwd);
  const [draft, setDraft] = useState(() => draftFromPlan(plan, defaultModelRef));
  const [activeMemberId, setActiveMemberId] = useState<string | null>(plan.members[0]?.id ?? null);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchRef, setBatchRef] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  /** 草稿里模型仍为空（没计划值、也没主模型可预填）的成员——批准后它们必然 spawn 失败。 */
  const missingModelMembers = useMemo(
    () => plan.members
      .filter((member) => !isUsableModelRef(draft.members[member.id]?.modelRef ?? ""))
      .map((member) => member.name),
    [plan.members, draft.members],
  );

  // 服务端 plan 变了（保存成功 / 另一个窗口改了）：重设基线，避免草稿越改越旧。
  // **但有未保存改动时不重置** —— 否则别人（或另一个窗口）一动计划，用户正在输入的内容就
  // 静默消失。保留草稿、让保存按字段合并（写路径只覆盖列出的字段），明显好于丢输入。
  // 依赖用 planKey 而不是 plan 对象：轮询每 2s 重新解析一份 JSON，对象身份不稳定。
  const planKey = `${plan.planId}:${plan.incarnationId}:${plan.revision}`;
  useEffect(() => {
    if (!dirtyRef.current) {
      setDraft(draftFromPlan(plan, defaultModelRef));
      setSelected([]);
    }
    setActiveMemberId((current) => (plan.members.some((member) => member.id === current) ? current : plan.members[0]?.id ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按 planKey 重置，plan 只用于取值
  }, [planKey]);

  // agent 预设目录：读不到（无 cwd / 未信任）就只显示当前值，不阻塞其它编辑。
  useEffect(() => {
    if (!cwd) { setAgents([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { profiles?: { name?: unknown; agentType?: unknown; enabled?: unknown }[] };
        if (cancelled) return;
        const names = (data.profiles ?? [])
          .filter((profile) => profile.enabled !== false)
          .map((profile) => (typeof profile.name === "string" ? profile.name : null))
          .filter((name): name is string => Boolean(name));
        setAgents([...new Set(names)]);
        setAgentsError(null);
      } catch (error) {
        if (!cancelled) setAgentsError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [cwd]);

  const dirty = useMemo(() => isDraftDirty(plan, draft, defaultModelRef), [plan, draft, defaultModelRef]);
  const activeMember = plan.members.find((member) => member.id === activeMemberId) ?? null;
  // 给上面的「重置草稿」effect 读最新值（effect 声明在前面，用 ref 避免顺序与闭包问题）。
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // 勾选状态跟着成员表走：计划里删掉的成员 id 必须从 selected 里剔掉，否则
  // 「全选」勾选框会永远算不满、批量设模型也会对着幽灵 id 写草稿（写了个不存在的成员，
  // diff 时被忽略 → 用户点完没反应）。数组内容不变时返回原引用，避免每 2s 轮询重渲染。
  const memberIdsKey = plan.members.map((member) => member.id).join("\u0000");
  useEffect(() => {
    const ids = new Set(memberIdsKey ? memberIdsKey.split("\u0000") : []);
    setSelected((current) => {
      const next = current.filter((id) => ids.has(id));
      return next.length === current.length ? current : next;
    });
  }, [memberIdsKey]);

  // 把 dirty 报给卡片：未保存的改动要拦住「批准」（否则按旧模型启动）。
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // 同时把「批准时要一并保存的 diff」上报给卡片；无改动时上报 null。
  useEffect(() => {
    onDraftChange?.(dirty ? diffPlanEdits(plan, draft, defaultModelRef) : null);
  }, [dirty, plan, draft, onDraftChange]);

  const setMember = useCallback((id: string, patch: Partial<PlanMemberDraft>) => {
    setDraft((current) => ({
      ...current,
      members: {
        ...current.members,
        // 草稿里还没有这个成员（计划刚被别处重排/重命名）时，用计划基线兜底，
        // 否则 spread undefined 会写出一个只有被改字段的半截草稿，其它字段全丢。
        [id]: { ...(current.members[id] ?? { agentType: "", modelRef: "", effortLevel: "" }), ...patch },
      },
    }));
  }, []);

  const setTaskOwner = useCallback((id: string, ownerId: string) => {
    setDraft((current) => ({ ...current, tasks: { ...current.tasks, [id]: ownerId } }));
  }, []);

  // 批量模型下拉：选中即应用到已勾选成员，不再需要单独的「应用到选择」按钮。
  // 只接受可用的 `provider/model`：空值、`unknown/unknown` 一律忽略（筛选掉假模型）。
  const applyModelRef = (ref: string) => {
    if (!isUsableModelRef(ref) || selected.length === 0) return;
    setDraft((current) => {
      const members = { ...current.members };
      for (const id of selected) {
        const base = members[id] ?? baselineMemberDraft(plan, id);
        if (!base) continue;
        members[id] = { ...base, modelRef: ref };
      }
      return { ...current, members };
    });
  };

  const followLead = () => {
    // 队长运行时可能是 pi-team 写的占位 unknown/unknown（本服务进程不设 PROVIDER/MODEL 环境
    // 变量）；那样的值不能写进成员模型，按钮也据此禁用。
    if (!isUsableRuntime(plan.leaderRuntime) || selected.length === 0) return;
    applyModelRef(planMemberModelRef(plan.leaderRuntime));
  };

  // 恢复建议模型：模型与 agent 预设回到计划里的值，思考级别保持用户当前的选择。
  const restoreSuggested = () => {
    setDraft((current) => {
      const members = { ...current.members };
      for (const member of plan.members) {
        members[member.id] = {
          ...(members[member.id] ?? baselineMemberDraft(plan, member.id) ?? { agentType: "", modelRef: "", effortLevel: "" }),
          agentType: member.agentType,
          // 与 draftFromPlan 同口径：unknown 占位恢复成空串，而不是写回一个假模型。
          modelRef: planMemberModelRef(member.runtime),
        };
      }
      return { ...current, members };
    });
  };

  // 保存与批准合并：卡片在批准时携带这里的 diff 先 PATCH。此处不再有独立保存按钮。
  const toggleSelected = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const modelOptions = catalog.catalog.entries.map((entry) => ({
    value: entry.ref,
    label: `${entry.name} · ${entry.provider}`,
    disabled: !entry.enabled,
  }));

  // 选中成员的当前草稿快照。约定：
  // - agentType 用 `||`（空串 = 还没选，退回计划里的值）；
  // - modelRef 空串 = 「未设置」（unknown 占位在 draftFromPlan 里已经换成空串）。
  const activeDraft = activeMember ? draft.members[activeMember.id] : undefined;
  const activeAgentType = activeDraft?.agentType || activeMember?.agentType || "";
  const activeModelRef = activeDraft?.modelRef ?? "";
  const activeEffort = activeDraft?.effortLevel ?? "";
  // 没有可用模型时思考级别**不能编辑**：runtime 是个整体，光有 effort 发不出去，
  // 旧实现允许改、diff 却因为 splitModelRef("") = null 直接跳过 → 用户改了、
  // dirty 不动、批准后也没生效（看起来就是「草稿被吞了」）。现在先选模型再选级别。
  const activeModelUsable = isUsableModelRef(activeModelRef);
  const effortOptions = [
    ...(activeEffort && !(PLAN_EFFORT_LEVELS as readonly string[]).includes(activeEffort)
      // 服务端给了不在枚举里的级别：照原样列出来，别让下拉显示空白。
      ? [{ value: activeEffort, label: activeEffort }]
      : []),
    ...PLAN_EFFORT_LEVELS.map((value) => ({ value, label: value || t("teams.plan.effortDefault") })),
  ];

  return (
    <div data-testid="team-plan-editor" className="team-plan-editor" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <p style={S.hint}>{t("teams.plan.editorHint")}</p>
      {/*
        成员模型仍是「未设置」时必须说出来（团队计数审计 P2-1）：批准照常放行，而 launch
        会拿 `unknown/unknown` 去 spawn，那个成员必然起不来。只提示、不拦批准——真实机器上
        队长 runtime 恒为 unknown，硬拦会把最常见的正常流程挡死。
        有主模型预填后这种情况已经少见，但「本机没配模型」时仍会出现。
      */}
      {missingModelMembers.length > 0 ? (
        <p role="alert" data-testid="team-plan-missing-model" style={S.alert}>
          {t("teams.plan.missingModel", { names: missingModelMembers.join("、") })}
        </p>
      ) : null}
      {conflict ? (
        <div role="alert" data-testid="team-plan-conflict" style={S.alert}>
          {t("teams.plan.conflict")}
          {onReload && (
            <ConfigButton size="small" onClick={onReload} style={{ marginLeft: 8 }}>
              {t("teams.plan.reload")}
            </ConfigButton>
          )}
        </div>
      ) : null}

      <div className="team-plan-editor-grid" style={{ display: "grid", gap: 16, alignItems: "start" }}>
        {/* 左：成员名册（勾选 + 当前模型） */}
        <section aria-label={t("teams.plan.roster")} style={S.roster}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            {/* 计数文案走 teams.plan.memberCount（与只读名册分支同一个 key）：
                两个分支文案一致，也不再把数字硬拼进标题造成两种写法。 */}
            <h4 style={S.h4}>{t("teams.plan.memberCount", { count: plan.members.length })}</h4>
            {editable && plan.members.length > 0 && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--fs-micro)", color: "var(--text-muted)" }}>
                <input
                  type="checkbox"
                  checked={selected.length === plan.members.length}
                  onChange={(event) => setSelected(event.target.checked ? plan.members.map((member) => member.id) : [])}
                  aria-label={t("teams.plan.selectAll")}
                />
                {t("teams.plan.selectAll")}
              </label>
            )}
          </div>
          {plan.members.map((member, index) => {
            const current = draft.members[member.id];
            return (
              <div key={member.id} style={S.row(member.id === activeMemberId)} data-member-id={member.id}>
                {editable && (
                  <input
                    type="checkbox"
                    checked={selected.includes(member.id)}
                    onChange={() => toggleSelected(member.id)}
                    aria-label={member.name}
                  />
                )}
                <button
                  type="button"
                  onClick={() => setActiveMemberId(member.id)}
                  aria-current={member.id === activeMemberId ? "true" : undefined}
                  style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", color: "inherit" }}
                >
                  <span style={S.mono}>{String(index + 1).padStart(2, "0")}</span>
                  <span style={S.rowMeta}>
                    <span style={S.name}>{member.name}</span>
                    <span style={S.mono}>
                      {current?.modelRef || t("teams.plan.unspecified")}
                      {current?.effortLevel ? ` · ${current.effortLevel}` : ""}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
          {isUsableRuntime(plan.leaderRuntime) && (
            <p style={S.hint}>{t("teams.plan.leader")}: {planMemberModelRef(plan.leaderRuntime)}</p>
          )}

          {editable && (
            <div style={S.batch} data-testid="team-plan-batch">
              {/* 单行紧凑布局：原来「已选 N 名」标题占一整行、下拉与三个按钮各占一行，
                  卡片在 720px 以下要占三行高度。现在计数→下拉→按钮排成一条，宽度不足
                  时按钮组整体换行。 */}
              <span style={{ ...S.label, margin: 0, whiteSpace: "nowrap" }}>
                {t("teams.plan.selectedCount", { count: selected.length })}
              </span>
              <div style={{ flex: "1 1 160px", minWidth: 140 }}>
                <AppSelect
                  aria-label={t("teams.plan.batch")}
                  value={batchRef}
                  onValueChange={(value) => {
                    // 这是一次性「动作」，不是持久选择：应用后立刻回到占位项。
                    // 旧实现把选中值留在 batchRef 里，Radix 对同值不再触发 onValueChange
                    // → 换个成员勾选后再选**同一个**模型完全没反应（用户报的「选完不生效」）。
                    setBatchRef("");
                    applyModelRef(value);
                  }}
                  options={[{ value: "", label: t("teams.plan.batchPick") }, ...modelOptions]}
                  // 两个「不能选」的原因长得一模一样，用户只能靠多点几次试：没勾成员 vs
                  // 目录还在加载。title 点明是哪一个（`AppSelect` 只透传一个 disabled）。
                  title={
                    selected.length === 0
                      ? t("teams.plan.batchNeedSelection")
                      : catalog.loading
                        ? t("teams.plan.modelsLoading")
                        : undefined
                  }
                  disabled={selected.length === 0 || catalog.loading}
                />
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "0 1 auto" }}>
                <ConfigButton size="small" disabled={selected.length === 0 || !isUsableRuntime(plan.leaderRuntime)} onClick={followLead}>
                  {t("teams.plan.followLeader")}
                </ConfigButton>
                <ConfigButton size="small" onClick={restoreSuggested}>
                  {t("teams.plan.restore")}
                </ConfigButton>
              </div>
            </div>
          )}
        </section>

        {/* 右：选中成员详情 + 任务分配 */}
        <div className="team-plan-detail-column" style={{ minWidth: 0 }}>
          {activeMember && (
            <section aria-label={t("teams.plan.configureMember", { name: activeMember.name })}>
              <h4 style={S.h4}>{t("teams.plan.assignment")} · {activeMember.name}</h4>
              <div className="team-plan-assignment-grid" style={{ display: "grid", gap: 10 }}>
                <div style={S.field}>
                  <span style={S.label}>{t("teams.plan.agent")}</span>
                  {agents.length > 0 ? (
                    <AppSelect
                      aria-label={`${activeMember.name} · ${t("teams.plan.agent")}`}
                      value={activeAgentType}
                      onValueChange={(value) => setMember(activeMember.id, { agentType: value })}
                      options={[
                        // 当前值不在预设列表里（自定义 / 预设被删）时补一个选项，
                        // 否则下拉会显示空白、看起来像「没有 agent」。
                        ...(agents.includes(activeAgentType) || !activeAgentType
                          ? []
                          : [{ value: activeAgentType, label: activeAgentType }]),
                        ...agents.map((name) => ({ value: name, label: name })),
                      ]}
                      disabled={!editable}
                    />
                  ) : (
                    <span style={S.mono}>
                      {activeAgentType || t("teams.plan.unspecified")}
                      {agentsError ? ` (${t("teams.plan.agentsUnavailable")})` : ""}
                    </span>
                  )}
                </div>
                <div style={S.field}>
                  <span style={S.label}>{t("teams.plan.model")}</span>
                  <AppSelect
                    aria-label={`${activeMember.name} · ${t("teams.plan.model")}`}
                    value={activeModelRef}
                    onValueChange={(value) => setMember(activeMember.id, { modelRef: value })}
                    options={[
                      // 当前值不在目录里（unknown 占位 / 已下架的模型）：补一个**有文案**的
                      // 选项。旧实现用 `?? t(unspecified)` 兜底，空串时标签就是空串，
                      // 下拉里出现一条看不见的空行。
                      ...(modelOptions.some((option) => option.value === activeModelRef)
                        ? []
                        : [{ value: activeModelRef, label: activeModelRef || t("teams.plan.unspecified") }]),
                      ...modelOptions,
                    ]}
                    disabled={!editable || catalog.loading}
                  />
                </div>
                <div style={S.field}>
                  <span style={S.label}>{t("teams.plan.effort")}</span>
                  <AppSelect
                    aria-label={`${activeMember.name} · ${t("teams.plan.effort")}`}
                    value={activeEffort}
                    onValueChange={(value) => setMember(activeMember.id, { effortLevel: value })}
                    options={effortOptions}
                    // 思考强度是 runtime 的一部分：没有模型就发不出去。禁用是对的，但不说清楚
                    // 用户只看到灰掉的下拉、不知道要先选模型（团队计数审计 P3-2）。
                    title={!activeModelUsable && editable ? t("teams.plan.effortNeedsModel") : undefined}
                    disabled={!editable || !activeModelUsable}
                  />
                  {!activeModelUsable && editable ? (
                    <span style={S.hint} data-testid="team-plan-effort-needs-model">
                      {t("teams.plan.effortNeedsModel")}
                    </span>
                  ) : null}
                </div>
              </div>
              <p style={S.hint}>{t("teams.plan.costHint")}</p>
              {activeMember.prompt ? (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: "var(--fs-micro)", color: "var(--text-muted)" }}>{t("teams.plan.memberBrief")}</summary>
                  <p style={{ ...S.mono, whiteSpace: "pre-wrap", marginTop: 6, overflowWrap: "anywhere" }}>{activeMember.prompt}</p>
                </details>
              ) : null}
            </section>
          )}

          <section style={S.section} aria-label={t("teams.plan.tasks")}>
            <h4 style={S.h4}>{t("teams.plan.tasks")} ({plan.tasks.length})</h4>
            {plan.tasks.length === 0 ? (
              <p style={S.hint}>{t("teams.plan.noTasks")}</p>
            ) : (
              plan.tasks.map((task) => (
                <div key={task.id} className="team-plan-task-row" style={S.taskRow} data-task-id={task.id}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "var(--fs-caption)", color: "var(--text)", overflowWrap: "anywhere" }}>{task.subject}</div>
                    {task.dependencies.length > 0 && (
                      <div style={S.mono}>{t("teams.plan.dependencies")}: {task.dependencies.join(", ")}</div>
                    )}
                  </div>
                  <AppSelect
                    aria-label={`${task.subject} · ${t("teams.plan.owner")}`}
                    // 草稿里还没有这个任务（计划刚被别处加了任务、或用户有未保存改动时基线没重置）
                    // → 显示计划里的真实负责人，而不是一律显示「未分配」（旧实现会误报未分配）。
                    value={draft.tasks[task.id] ?? task.ownerId ?? ""}
                    onValueChange={(value) => setTaskOwner(task.id, value)}
                    options={[
                      { value: "", label: t("teams.plan.unassigned") },
                      ...plan.members.map((member) => ({ value: member.id, label: member.name })),
                    ]}
                    disabled={!editable}
                  />
                </div>
              ))
            )}
          </section>
        </div>
      </div>

      {saveError ? <p role="alert" style={S.alert}>{saveError}</p> : null}
      {catalog.error ? <p style={S.hint}>{t("teams.plan.modelsUnavailable")}</p> : null}

      <div style={S.footer}>
        <span style={{ ...S.hint, marginRight: "auto", alignSelf: "center" }}>
          {saving
            ? t("teams.plan.saving")
            : dirty
              ? t("teams.plan.approveSavesHint")
              : t("teams.plan.saved")}
        </span>
      </div>
    </div>
  );
}