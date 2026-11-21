"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TranslationParams } from "@/lib/i18n/types";
import {
  teamRuntimeControl,
  teamRuntimeScope,
  teamRuntimeControlKey,
  useTeamRuntimeControlEntry,
  type TeamRuntimeScope,
} from "@/hooks/useTeamRuntimeControlStore";
import type { RuntimeControlView, RuntimeControlMemberView } from "@/lib/agent-teams-runtime-control";
import type { WorkbenchTeam } from "@/lib/agent-teams-swimlane";

/**
 * 团队运行时控件（工作台顶部的暂停/恢复区）——移植 cc-haha AgentTeamsRuntimeControls
 * 的可观测语义，桌面化简：**不做成员运行时编辑弹框**（pi 的工作台已有
 * TeamMemberModelPanel 提供成员模型编辑；暂停门禁已由服务端 runtime-control/member
 * 路由承担——running 时 PATCH 会 409）。
 *
 * 三个动作（cc-haha 同款）：
 * - **暂停**：markPauseRequested（客户端立即进入请求态）+ POST pause（服务端逐成员
 *   release，**不含 lead**）；同时停 lead 生成（onAbort，由调用方接 handleAbort——
 *   cc-haha 是 stopGeneration(leadSessionId)）。
 * - **恢复**：POST resume（服务端逐成员 ensureLive 复活）。
 * - **状态徽标**：running / pausing(客户端请求态) / paused / resuming(客户端请求态)
 *   / partial(部分成员未确认)。
 *
 * 1.5s 轮询（cc-haha 同款）；视图不可见时暂停。readOnly 或 scope 不全 ⇒ 不渲染。
 * 样式内联 + 主题 CSS 变量，不新增全局类（对齐 AgentTeamPlanCard 口径）。
 */
interface Props {
  /** 工作台快照的团队头（name / leadSessionId / incarnationId / members）。 */
  team: WorkbenchTeam | null;
  /** 停 lead 会话生成（暂停时与服务端 pause 同时发起；cc-haha stopGeneration 同位）。 */
  onAbort?: () => void;
  /** 只读（回放中 / 非实时）⇒ 不渲染。 */
  readOnly?: boolean;
  /** 打开成员编辑入口（工作台的「编辑成员」）；只在暂停态可点，running 时禁用并提示。 */
  onEditMembers?: () => void;
}

type TFn = (key: string, params?: TranslationParams) => string;

/** 成员状态 → i18n 键（teams.runtime.member.*）。 */
function memberStatusKey(status: RuntimeControlMemberView["status"]): string {
  return `teams.runtime.member.${status}`;
}

/** 状态徽标的 i18n 键与色（只主题 token）。 */
function statePresentation(
  view: RuntimeControlView,
  pauseRequested: boolean,
  resuming: boolean,
): { key: string; color: string } {
  if (pauseRequested) return { key: "teams.runtime.pausing", color: "var(--warning, var(--accent))" };
  if (resuming) return { key: "teams.runtime.resuming", color: "var(--accent)" };
  switch (view.status) {
    case "paused":
      return { key: "teams.runtime.paused", color: "var(--text-muted)" };
    case "partial":
      return { key: "teams.runtime.partial", color: "var(--danger)" };
    default:
      return { key: "teams.runtime.running", color: "var(--accent)" };
  }
}

const S: Record<string, React.CSSProperties> = {
  section: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    padding: "8px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    marginBottom: 10,
  },
  badge: { padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border)", fontSize: "var(--fs-micro)" },
  hint: { fontSize: "var(--fs-caption)", color: "var(--text-muted)", minWidth: 0 },
  members: { fontSize: "var(--fs-micro)", color: "var(--text-dim)", display: "flex", gap: 8, flexWrap: "wrap" },
  button: {
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text)",
    borderRadius: 7,
    padding: "5px 11px",
    fontSize: "var(--fs-caption)",
    cursor: "pointer",
  },
  buttonOff: {
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-dim)",
    borderRadius: 7,
    padding: "5px 11px",
    fontSize: "var(--fs-caption)",
    cursor: "not-allowed",
  },
  primary: {
    border: "none",
    background: "var(--accent)",
    color: "var(--accent-contrast)",
    borderRadius: 7,
    padding: "5px 12px",
    fontSize: "var(--fs-caption)",
    fontWeight: "var(--fw-semibold)",
    cursor: "pointer",
  },
  error: { color: "var(--danger)", fontSize: "var(--fs-caption)" },
};

export function AgentTeamsRuntimeControls({ team, onAbort, readOnly = false, onEditMembers }: Props) {
  const { t } = useI18n();
  const scope: TeamRuntimeScope | null = useMemo(
    () => teamRuntimeScope({ name: team?.name, leadSessionId: team?.leadSessionId, incarnationId: team?.incarnationId }),
    [team?.name, team?.leadSessionId, team?.incarnationId],
  );
  const scopeKey = scope ? teamRuntimeControlKey(scope) : null;
  const entry = useTeamRuntimeControlEntry(scopeKey);

  // 1.5s 轮询（cc-haha 同款）；页面不可见时暂停。
  useEffect(() => {
    if (readOnly || !scope) return;
    void teamRuntimeControl.refresh(scope);
    const doc = typeof document === "undefined" ? null : document;
    const timer = window.setInterval(() => {
      if (doc && doc.visibilityState !== "visible") return;
      void teamRuntimeControl.refresh(scope);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [scope, readOnly]);

  const [aborting, setAborting] = useState(false);
  const handlePause = () => {
    if (!scope || aborting) return;
    teamRuntimeControl.markPauseRequested(scope);
    setAborting(true);
    try {
      onAbort?.();
    } finally {
      setAborting(false);
    }
  };

  if (readOnly || !scope) return null;
  const view = entry?.view ?? null;
  const pauseRequested = entry?.pauseRequested ?? false;
  const resuming = entry?.operation === "resume";
  if (!view && !entry?.loading && !entry?.error) return null;

  const state = statePresentation(view ?? ({ status: "running" } as RuntimeControlView), pauseRequested, resuming);
  const canPause = !pauseRequested && !resuming && view?.status !== "paused";
  const canResume = view !== null
    && (view.status === "paused" || view.status === "partial")
    && !entry?.busy
    && !pauseRequested;
  // 成员编辑只在**暂停态**开放：running 时改成员会与服务端 runtime-control/member 的
  // 409 门禁冲突，故禁用并给「暂停团队后才能编辑成员」提示（disabled = status !== "paused"）。
  const canEditMembers = view?.status === "paused";
  const errors: string[] = [];
  if (entry?.error) errors.push(entry.error);
  if (view?.error) errors.push(view.error);
  for (const member of view?.members ?? []) {
    if (member.error) errors.push(`${member.name}: ${member.error}`);
  }

  return (
    <section
      aria-label={t("teams.runtime.title")}
      data-testid="agent-teams-runtime-controls"
      style={S.section}
    >
      <span style={{ ...S.badge, color: state.color }} role="status" data-testid="runtime-state">
        {t(state.key)}
      </span>
      {view ? (
        <span style={S.hint}>
          {t("teams.runtime.eligible", { count: view.resumeEligibleCount })}
        </span>
      ) : null}
      {view && view.members.length > 0 ? (
        <span style={S.members} data-testid="runtime-members">
          {view.members.map((member) => (
            <span key={member.agentId} data-member-name={member.name}>
              {member.name} · {t(memberStatusKey(member.status))}
            </span>
          ))}
        </span>
      ) : null}
      <span style={{ flex: 1 }} />
      {canPause && onAbort ? (
        <button
          type="button"
          data-testid="runtime-pause"
          style={S.button}
          onClick={handlePause}
        >
          {t("teams.runtime.pause")}
        </button>
      ) : null}
      {view && (view.status === "paused" || view.status === "partial") ? (
        <button
          type="button"
          data-testid="runtime-resume"
          style={canResume ? S.primary : S.buttonOff}
          disabled={!canResume}
          onClick={() => {
            if (!scope || !canResume) return;
            void teamRuntimeControl.resume(scope).catch(() => {});
          }}
        >
          {resuming
            ? t("teams.runtime.resuming")
            : t(view.status === "partial" ? "teams.runtime.retry" : "teams.runtime.resume")}
        </button>
      ) : null}
      {onEditMembers ? (
        <>
          {canEditMembers ? null : (
            <span style={S.hint} data-testid="runtime-edit-members-hint">
              {t("teams.runtime.pauseToEdit")}
            </span>
          )}
          <button
            type="button"
            data-testid="runtime-edit-members"
            className="agent-teams-runtime-edit-members"
            style={canEditMembers ? S.button : S.buttonOff}
            disabled={!canEditMembers}
            onClick={canEditMembers ? onEditMembers : undefined}
          >
            {t("teams.runtime.editMembers")}
          </button>
        </>
      ) : null}
      {errors.length > 0 ? (
        <p style={S.error} role="alert" data-testid="runtime-errors">
          {errors.join("；")}
        </p>
      ) : null}
    </section>
  );
}

/** 供测试引用的纯函数（成员状态键 / 状态展示不依赖 hook）。 */
export { memberStatusKey, statePresentation };

// 供测试驱动组件内部使用的**同一** store 实例（jiti 各次 import 各建模块实例，
// 测试旁路 import store 会拿到另一份，驱动不到组件读的桶——故从这里转发）。
export { teamRuntimeControl, resetTeamRuntimeControlForTest } from "@/hooks/useTeamRuntimeControlStore";
