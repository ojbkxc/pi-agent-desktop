"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { deriveTeamStripPhase } from "@/hooks/useActiveTeamStrip";
import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";

/**
 * `team_create` 的工具名。与 pi-team 的 `TEAM_CREATE_TOOL_NAME` 一致；
 * MessageView 用它决定「在这个工具调用处渲染内联卡」而不是普通工具行。
 */
export const AGENT_TEAM_CREATE_TOOL_NAME = "team_create";

/**
 * `team_delete` 的工具名（pi-team 删除团队及其全部数据，不可恢复）。
 * MessageView 用它渲染终态卡，隐藏那行原始工具 JSON。
 */
export const AGENT_TEAM_DELETE_TOOL_NAME = "team_delete";

export type AgentTeamInlineCardProps = {
  /** 发起该团队的会话 id；用来反查团队快照。缺省时渲染 disabled 占位。 */
  sessionId?: string;
  /** `team_create` 的工具结果是否为错误；错误时不编造团队，渲染 disabled 占位。 */
  isError?: boolean;
  /**
   * `team_create` 是否已经有工具结果。成功结果的 `isError` 通常是 undefined，
   * 只靠它无法感知「结果刚到达」，所以单独给一个信号，让卡片在工具完成时重拉快照
   * （流式过程中首次挂载往往还没有团队，不能一次 404 就一直停在占位）。
   */
  hasResult?: boolean;
  /** 打开团队工作台。缺省时「打开」不可点（例如历史记录里没有可用的导航回调）。 */
  onOpen?: () => void;
};

type SnapshotState =
  | { kind: "loading" }
  /** 查到团队快照（团队已建好）。 */
  | { kind: "ready"; snapshot: TeamWorkbenchSnapshot }
  /** 还没有团队 / 会话对不上 / 拉取失败——都按「尚未创建」处理，绝不编造数据。 */
  | { kind: "absent" };

/**
 * 阶段（含派生出的 interrupted / failed）→ 界面标签。
 * 正常全部走 `teams.status.*` 词条 —— forming/running/finishing/completed/ended/interrupted
 * 以及 failed 均已三语齐备，且与头部条 `teams.phase.*` 同词（team-lead 已在 key 层对齐）。
 * 因此下表已退化为**纯防御性回退**：仅当某语言缺词条（`t` 原样返回 key）时才用于兜底，
 * 保证任何情况下都不会把 i18n key 渲染到界面（与 AgentTeamsView.roleLabel 同思路）。
 * 保留不删。
 */
const PHASE_FALLBACK: Record<string, string> = {
  forming: "组建中",
  finishing: "收尾中",
  ended: "已结束",
  interrupted: "已中断",
  failed: "失败",
};

/** 取词条；缺失（`t` 原样返回 key）时回退到内置文案，绝不把 i18n key 渲染到界面。 */
function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const label = t(key);
  return label === key ? fallback : label;
}

/** 阶段标签：有词条用词条，缺词条回退内置中文；两者都没有才退回原文（仍不渲染 key）。 */
function resolvePhaseLabel(phase: string, t: (key: string) => string): string {
  return tOr(t, `teams.status.${phase}`, PHASE_FALLBACK[phase] ?? phase);
}

/** 两张团队卡共用的外壳样式（与工具行同族的等宽小卡）。 */
const CARD_SHELL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  minWidth: 0,
  padding: "7px 10px",
  border: "var(--hairline) solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "var(--tool-bg)",
  fontFamily: "var(--font-mono)",
  fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
  lineHeight: 1.5,
};

/**
 * `team_create` 工具调用处的内联卡（对齐 cc-haha 的内联团队卡）。
 * 数据来源单一：`GET /api/teams/session/[id]/workbench`（按会话 id 反查团队并返回
 * 泳道快照）。拿不到快照时不编造数据源，只渲染「尚未创建」的 disabled 占位。
 *
 * 阶段不直接读 `snapshot.team.status`，而是复用头部条同款派生 `deriveTeamStripPhase`
 * （有 failed 派活 → failed、成员 aborted → interrupted），避免「头部条说中断、卡还停在
 * running」的自相矛盾。
 */
export function AgentTeamInlineCard({ sessionId, isError, hasResult, onOpen }: AgentTeamInlineCardProps) {
  const { t } = useI18n();
  const [state, setState] = useState<SnapshotState>({ kind: "loading" });

  useEffect(() => {
    if (!sessionId || isError) {
      setState({ kind: "absent" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const response = await fetch(
          `/api/teams/session/${encodeURIComponent(sessionId)}/workbench`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          if (!cancelled) setState({ kind: "absent" });
          return;
        }
        const snapshot = await response.json() as TeamWorkbenchSnapshot;
        if (!cancelled) setState({ kind: "ready", snapshot });
      } catch {
        if (!cancelled) setState({ kind: "absent" });
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, isError, hasResult]);

  const snapshot = state.kind === "ready" ? state.snapshot : null;
  const teamName = snapshot?.team.name ?? "";
  // 派生阶段；"none" 仅表示空名册（未进成员就取消），不能据此把卡片判成不可见——
  // 退回团队自身阶段做标签，卡片照常显示。
  const derivedPhase = snapshot ? deriveTeamStripPhase(snapshot) : null;
  const phase: string | null = derivedPhase === "none" ? (snapshot?.team.status ?? null) : derivedPhase;
  // 「已取消 / 已结束」的团队不再提供打开入口；其余（组队中/运行中/收尾中/已完成/中断/失败）可点。
  const canOpen = state.kind === "ready" && phase !== "ended" && !!onOpen;

  const phaseLabelText = phase ? resolvePhaseLabel(phase, t) : "";
  const phaseColor = phase === "failed"
    ? "var(--danger)"
    : phase === "interrupted"
      ? "var(--warning)"
      : "var(--accent)";

  const totalTasks = snapshot?.tasks.length ?? 0;
  const doneTasks = snapshot?.tasks.filter((task) => task.status === "completed").length ?? 0;
  const memberCount = snapshot?.members.length ?? 0;

  return (
    <div
      data-agent-team-inline-card
      style={CARD_SHELL_STYLE}
    >
      {/* 团队图标：两个小圆点，纯装饰，不使用彩色 emoji。 */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--accent)" }} aria-hidden="true">
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20a6 6 0 0 1 12 0" />
        <circle cx="18" cy="9" r="2.2" />
        <path d="M15 19.5a4.5 4.5 0 0 1 6-4.2" />
      </svg>

      {state.kind === "loading" ? (
        <span style={{ color: "var(--text-dim)" }}>…</span>
      ) : snapshot ? (
        <>
          <span
            data-agent-team-inline-name
            style={{ color: "var(--text)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}
          >
            {teamName}
          </span>

          {phase && (
            <span
              data-agent-team-inline-phase
              data-agent-team-phase={phase}
              style={{
                flexShrink: 0,
                padding: "1px 7px",
                borderRadius: 999,
                border: `var(--hairline) solid ${phaseColor}`,
                color: phaseColor,
                fontSize: "var(--fs-micro)",
                whiteSpace: "nowrap",
              }}
            >
              {phaseLabelText}
            </span>
          )}

          <span style={{ flexShrink: 0, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            {t("teams.inline.created", { count: memberCount })}
          </span>

          <span
            data-agent-team-inline-progress
            style={{ flexShrink: 0, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
          >
            {`${doneTasks}/${totalTasks}`}
          </span>
        </>
      ) : (
        <span data-agent-team-inline-not-started style={{ color: "var(--text-dim)" }}>
          {t("teams.inline.notStarted")}
        </span>
      )}

      <button
        type="button"
        data-agent-team-inline-open
        onClick={canOpen ? onOpen : undefined}
        disabled={!canOpen}
        aria-disabled={!canOpen || undefined}
        style={{
          marginLeft: "auto",
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          padding: "2px 8px",
          background: "none",
          border: "none",
          borderRadius: "var(--radius-sm)",
          color: canOpen ? "var(--accent)" : "var(--text-dim)",
          cursor: canOpen ? "pointer" : "not-allowed",
          opacity: canOpen ? 1 : 0.55,
          font: "inherit",
          whiteSpace: "nowrap",
        }}
      >
        {t("teams.inline.open")}
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

/**
 * `team_delete` 工具调用处的终态卡（与 team_create 的内联卡对称）。
 *
 * 删除成功后团队目录被移除、`/api/teams/session/[id]/workbench` 会 404，所以这张卡
 * **不拉数据源**，只表达终态；团队名优先取工具入参 `team_name`，取不到就不显示名
 * （绝不编造）。删除失败（工具报错）时团队其实还在，卡片显示「删除未成功」而不是
 * 「已删除」，避免误导。
 */
export function AgentTeamDeleteCard({ teamName, isError, hasResult }: {
  teamName?: string;
  isError?: boolean;
  hasResult?: boolean;
}) {
  const { t } = useI18n();
  const failed = !!hasResult && !!isError;
  const stateLabel = hasResult
    ? (failed
      ? tOr(t, "teams.inline.deleteFailed", "删除未成功")
      : tOr(t, "teams.inline.deleted", "团队已删除"))
    : "…";
  const stateColor = failed ? "var(--danger)" : "var(--text-dim)";

  return (
    <div data-agent-team-delete-card style={CARD_SHELL_STYLE}>
      {/* 归档/删除图标：纯装饰，不使用彩色 emoji。 */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: failed ? "var(--danger)" : "var(--text-muted)" }} aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </svg>

      {teamName && (
        <span
          data-agent-team-delete-name
          style={{ color: "var(--text)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}
        >
          {teamName}
        </span>
      )}

      <span data-agent-team-delete-state style={{ color: stateColor, whiteSpace: "nowrap" }}>
        {stateLabel}
      </span>
    </div>
  );
}
