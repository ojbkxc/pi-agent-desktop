"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { AppSelect } from "@/components/AppSelect";
import { ConfigButton } from "@/components/SettingsUi";
import type { TeamPlanView } from "@/lib/agent-teams-plan";

/**
 * B3 计划卡的**可编辑**内容（对齐 cc-haha AgentTeamsPlanCard 的弹框）。
 *
 * 本轮补上的能力（原先弹框只读）：
 * - 成员列表可勾选 → 批量设模型 / 跟随队长；
 * - 逐个成员改 agent 预设与服务商+模型；
 * - 任务负责人下拉（含「未分配」）。
 *
 * 数据流：本地草稿 → 点「保存改动」→ `PATCH /api/teams/[team]/plan` → 回填服务端
 * 返回的 plan（revision +1）。**保存不是批准**：批准仍走 `onApprove`（投递 prompt
 * 给 lead，由它 approve + launch）；保存只改字段，状态保持 review_pending。
 *
 * 模型目录来自 `useModelCatalog()`（与团队成员换模型面板同源）；agent 预设来自
 * `/api/subagents/profiles?cwd=`，读不到时只展示当前值、不阻塞模型与任务编辑。
 */

export interface PlanEditorDeps {
  /** 保存草稿（PATCH）。返回新的 plan；失败抛出带 message 的错误。 */
  onSave?: (edits: { members: PlanMemberEditDraft[]; tasks: PlanTaskEditDraft[] }) => Promise<TeamPlanView>;
}

export interface PlanMemberEditDraft {
  id: string;
  agentType?: string;
  runtime?: { providerId: string; modelId: string; effortLevel?: string };
}

export interface PlanTaskEditDraft {
  id: string;
  ownerId?: string;
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

/** 只把**真正改过**的字段放进 PATCH 体（与 cc-haha teamPlansApi.save 同口径）。 */
export function diffPlanEdits(
  plan: TeamPlanView,
  draft: { members: Record<string, { agentType: string; modelRef: string }>; tasks: Record<string, string> },
): { members: PlanMemberEditDraft[]; tasks: PlanTaskEditDraft[] } {
  const members: PlanMemberEditDraft[] = [];
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
    if (runtime && (runtime.providerId !== member.runtime.providerId || runtime.modelId !== member.runtime.modelId)) {
      next.runtime = runtime;
      changed = true;
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
export function draftFromPlan(plan: TeamPlanView): {
  members: Record<string, { agentType: string; modelRef: string }>;
  tasks: Record<string, string>;
} {
  const members: Record<string, { agentType: string; modelRef: string }> = {};
  for (const member of plan.members) {
    members[member.id] = {
      agentType: member.agentType,
      modelRef: joinModelRef(member.runtime.providerId, member.runtime.modelId),
    };
  }
  const tasks: Record<string, string> = {};
  for (const task of plan.tasks) tasks[task.id] = task.ownerId ?? "";
  return { members, tasks };
}

/** 草稿是否与服务端一致（「有未保存的更改」提示与保存按钮的 enabled 口径）。 */
export function isDraftDirty(
  plan: TeamPlanView,
  draft: { members: Record<string, { agentType: string; modelRef: string }>; tasks: Record<string, string> },
): boolean {
  const edits = diffPlanEdits(plan, draft);
  return edits.members.length > 0 || edits.tasks.length > 0;
}

interface Props {
  plan: TeamPlanView;
  /**
   * 读 agent 预设用的项目目录（通常是该会话的 cwd）。缺省时不请求预设接口，
   * 成员详情只显示当前 agentType、不允许改它（模型与任务仍可编辑）。
   */
  cwd?: string | null;
  /** 是否允许编辑（draft / review_pending）。 */
  editable: boolean;
  /** 保存进行中。 */
  saving?: boolean;
  /** 保存错误。 */
  saveError?: string | null;
  /** 保存；成功后由上层回填 plan。缺省时不显示保存按钮（纯只读）。 */
  onSave?: (edits: { members: PlanMemberEditDraft[]; tasks: PlanTaskEditDraft[] }) => void;
  /** 计划已被别人改过（409）：提示重新载入。 */
  conflict?: boolean;
  onReload?: () => void;
}

const S = {
  roster: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  row: (active: boolean) => ({
    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8,
    background: active ? "var(--bg-selected)" : "transparent", cursor: "pointer",
  }),
  rowMeta: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 },
  name: { fontSize: "var(--fs-body)", fontWeight: "var(--fw-semibold)", color: "var(--text)" },
  mono: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)", color: "var(--text-muted)" },
  section: { marginTop: 16 },
  h4: { fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)", color: "var(--text-muted)", margin: "0 0 6px" },
  field: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  label: { fontSize: "var(--fs-micro)", color: "var(--text-muted)" },
  batch: { marginTop: 12, padding: 10, borderRadius: 10, background: "var(--bg-subtle, var(--bg-panel))", display: "flex", flexDirection: "column", gap: 8 },
  taskRow: { display: "grid", gap: 8, gridTemplateColumns: "minmax(0,1fr) minmax(160px, 220px)", alignItems: "start", padding: "6px 0", borderTop: "1px solid var(--border)" },
  footer: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12, flexWrap: "wrap" },
  alert: { color: "var(--danger)", fontSize: "var(--fs-caption)", margin: "6px 0" },
  hint: { fontSize: "var(--fs-micro)", color: "var(--text-dim)", margin: "4px 0 0" },
} as const;

export function PlanEditor({ plan, cwd = null, editable, saving = false, saveError = null, onSave, conflict = false, onReload }: Props) {
  const { t } = useI18n();
  const catalog = useModelCatalog();
  const [draft, setDraft] = useState(() => draftFromPlan(plan));
  const [activeMemberId, setActiveMemberId] = useState<string | null>(plan.members[0]?.id ?? null);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchRef, setBatchRef] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  // 服务端 plan 变了（保存成功 / 另一个窗口改了）：重设基线，避免草稿越改越旧。
  useEffect(() => {
    setDraft(draftFromPlan(plan));
    setSelected([]);
    setActiveMemberId((current) => (plan.members.some((member) => member.id === current) ? current : plan.members[0]?.id ?? null));
  }, [plan]);

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

  const dirty = useMemo(() => isDraftDirty(plan, draft), [plan, draft]);
  const activeMember = plan.members.find((member) => member.id === activeMemberId) ?? null;

  const setMember = useCallback((id: string, patch: { agentType?: string; modelRef?: string }) => {
    setDraft((current) => ({
      ...current,
      members: {
        ...current.members,
        [id]: { ...current.members[id], ...patch },
      },
    }));
  }, []);

  const setTaskOwner = useCallback((id: string, ownerId: string) => {
    setDraft((current) => ({ ...current, tasks: { ...current.tasks, [id]: ownerId } }));
  }, []);

  const applyBatch = () => {
    const runtime = splitModelRef(batchRef);
    if (!runtime || selected.length === 0) return;
    setDraft((current) => {
      const members = { ...current.members };
      for (const id of selected) members[id] = { ...members[id], modelRef: batchRef };
      return { ...current, members };
    });
  };

  const followLead = () => {
    const lead = plan.leaderRuntime;
    if (!lead || selected.length === 0) return;
    const modelRef = joinModelRef(lead.providerId, lead.modelId);
    setDraft((current) => {
      const members = { ...current.members };
      for (const id of selected) members[id] = { ...members[id], modelRef };
      return { ...current, members };
    });
  };

  const restoreSuggested = () => {
    setDraft((current) => {
      const members = { ...current.members };
      for (const member of plan.members) {
        members[member.id] = {
          agentType: member.agentType,
          modelRef: joinModelRef(member.runtime.providerId, member.runtime.modelId),
        };
      }
      return { ...current, members };
    });
  };

  const save = () => {
    if (!onSave || !dirty) return;
    onSave(diffPlanEdits(plan, draft));
  };

  const toggleSelected = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const modelOptions = catalog.catalog.entries.map((entry) => ({
    value: entry.ref,
    label: `${entry.name} · ${entry.provider}`,
    disabled: !entry.enabled,
  }));

  return (
    <div data-testid="team-plan-editor" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <p style={S.hint}>{t("teams.plan.editorHint")}</p>
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

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(220px, 280px) minmax(0, 1fr)", alignItems: "start" }}>
        {/* 左：成员名册（勾选 + 当前模型） */}
        <section aria-label={t("teams.plan.roster")} style={S.roster}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <h4 style={S.h4}>{t("teams.plan.roster")} ({plan.members.length})</h4>
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
                    <span style={S.mono}>{current?.modelRef || t("teams.plan.unspecified")}</span>
                  </span>
                </button>
              </div>
            );
          })}
          {plan.leaderRuntime && (
            <p style={S.hint}>{t("teams.plan.leader")}: {joinModelRef(plan.leaderRuntime.providerId, plan.leaderRuntime.modelId)}</p>
          )}

          {editable && (
            <div style={S.batch} data-testid="team-plan-batch">
              <p style={{ ...S.label, margin: 0 }}>{t("teams.plan.selectedCount", { count: selected.length })}</p>
              <AppSelect
                aria-label={t("teams.plan.batch")}
                value={batchRef}
                onValueChange={setBatchRef}
                options={[{ value: "", label: t("teams.plan.batchPick") }, ...modelOptions]}
                disabled={selected.length === 0 || catalog.loading}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <ConfigButton size="small" disabled={selected.length === 0 || !batchRef} onClick={applyBatch}>
                  {t("teams.plan.applyBatch")}
                </ConfigButton>
                <ConfigButton size="small" disabled={selected.length === 0 || !plan.leaderRuntime} onClick={followLead}>
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
        <div style={{ minWidth: 0 }}>
          {activeMember && (
            <section aria-label={t("teams.plan.configureMember", { name: activeMember.name })}>
              <h4 style={S.h4}>{t("teams.plan.assignment")} · {activeMember.name}</h4>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)" }}>
                <div style={S.field}>
                  <span style={S.label}>{t("teams.plan.agent")}</span>
                  {agents.length > 0 ? (
                    <AppSelect
                      aria-label={`${activeMember.name} · ${t("teams.plan.agent")}`}
                      value={draft.members[activeMember.id]?.agentType ?? activeMember.agentType}
                      onValueChange={(value) => setMember(activeMember.id, { agentType: value })}
                      options={[
                        ...(agents.includes(draft.members[activeMember.id]?.agentType ?? activeMember.agentType)
                          ? []
                          : [{ value: draft.members[activeMember.id]?.agentType ?? activeMember.agentType, label: draft.members[activeMember.id]?.agentType ?? activeMember.agentType }]),
                        ...agents.map((name) => ({ value: name, label: name })),
                      ]}
                      disabled={!editable}
                    />
                  ) : (
                    <span style={S.mono}>
                      {draft.members[activeMember.id]?.agentType ?? activeMember.agentType}
                      {agentsError ? ` (${t("teams.plan.agentsUnavailable")})` : ""}
                    </span>
                  )}
                </div>
                <div style={S.field}>
                  <span style={S.label}>{t("teams.plan.model")}</span>
                  <AppSelect
                    aria-label={`${activeMember.name} · ${t("teams.plan.model")}`}
                    value={draft.members[activeMember.id]?.modelRef ?? ""}
                    onValueChange={(value) => setMember(activeMember.id, { modelRef: value })}
                    options={[
                      ...(modelOptions.some((option) => option.value === draft.members[activeMember.id]?.modelRef)
                        ? []
                        : [{ value: draft.members[activeMember.id]?.modelRef ?? "", label: draft.members[activeMember.id]?.modelRef ?? t("teams.plan.unspecified") }]),
                      ...modelOptions,
                    ]}
                    disabled={!editable || catalog.loading}
                  />
                </div>
              </div>
              <p style={S.hint}>{t("teams.plan.costHint")}</p>
              {activeMember.prompt ? (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: "var(--fs-micro)", color: "var(--text-muted)" }}>{t("teams.plan.memberBrief")}</summary>
                  <p style={{ ...S.mono, whiteSpace: "pre-wrap", marginTop: 6 }}>{activeMember.prompt}</p>
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
                <div key={task.id} style={S.taskRow} data-task-id={task.id}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "var(--fs-caption)", color: "var(--text)" }}>{task.subject}</div>
                    {task.dependencies.length > 0 && (
                      <div style={S.mono}>{t("teams.plan.dependencies")}: {task.dependencies.join(", ")}</div>
                    )}
                  </div>
                  <AppSelect
                    aria-label={`${task.subject} · ${t("teams.plan.owner")}`}
                    value={draft.tasks[task.id] ?? ""}
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
          {dirty ? t("teams.plan.unsaved") : t("teams.plan.saved")}
        </span>
        {onSave && (
          <ConfigButton
            data-testid="team-plan-save"
            disabled={!editable || !dirty || saving}
            onClick={save}
          >
            {saving ? t("teams.plan.saving") : t("teams.plan.save")}
          </ConfigButton>
        )}
      </div>
    </div>
  );
}