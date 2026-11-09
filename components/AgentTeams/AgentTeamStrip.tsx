"use client";

import { useI18n } from "@/hooks/useI18n";
import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";
import type { TeamStripPhase, TeamStripProgress } from "@/hooks/useActiveTeamStrip";

/**
 * 会话头部常驻团队条（B1，对齐 cc-haha 的 header Agent Teams 条）。
 *
 * 渲染：`[Users] Agent Team · 头像堆叠（≤5 +N）· ●阶段 · 完成/总数 · 打开 ›`。
 * 整个条是一个按钮，点击由 `onOpen` 打开团队工作台。
 *
 * - `snapshot === null` 或显示态为 `none`（含未进成员就取消的团队）→ 渲染 null，不占位；
 * - 头像为成员首字母/首字的圆形堆叠，不引外部资源（配色走 `agent-team-strip-avatar--{color}` 类，由 CSS 提供）；
 * - 阶段点类名 `agent-team-strip-dot--{phase}`：running 脉冲、interrupted 黄、failed 红等由 CSS 提供；
 * - `compact`（窄屏）收敛为「头像堆叠 + 阶段点 + 打开」，文字标签与任务数由 CSS 隐藏。
 *
 * 样式不在本文件内联——统一交给 `agent-team-strip` 前缀的 CSS（由 lead 添加），
 * 以免内联样式压过主题规则。
 */
const MAX_AVATARS = 5;

interface Props {
  snapshot: TeamWorkbenchSnapshot | null;
  /** 显示态（由 useActiveTeamStrip 派生）。 */
  phase: TeamStripPhase;
  progress: TeamStripProgress;
  /** 打开该会话对应团队的工作台。 */
  onOpen: () => void;
  /** 窄屏紧凑档。 */
  compact?: boolean;
}

/** 成员头像字：取名称首字符，拉丁首字母大写；空名回退 "?"。 */
function initialOf(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 1).toUpperCase();
}

/**
 * 阶段标签键：正常走 `teams.phase.{phase}`（forming/running/finishing/completed/
 * ended/interrupted 三语齐备）；**failed 没有 teams.phase 词条**，复用成员态的
 * `teams.status.failed`（"失败"/"Failed"），避免把键名渲染到界面。
 */
function phaseLabelKey(phase: TeamStripPhase): string {
  return phase === "failed" ? "teams.status.failed" : `teams.phase.${phase}`;
}

export function AgentTeamStrip({ snapshot, phase, progress, onOpen, compact = false }: Props) {
  const { t } = useI18n();

  // 无快照 / 未进成员就取消的团队：不渲染，不占位。
  if (!snapshot || phase === "none") return null;

  const members = snapshot.members;
  const shown = members.slice(0, MAX_AVATARS);
  const overflow = members.length - shown.length;
  const phaseLabel = t(phaseLabelKey(phase));

  return (
    <button
      type="button"
      className={`agent-team-strip agent-team-strip--${phase}${compact ? " agent-team-strip--compact" : ""}`}
      onClick={onOpen}
      title={t("teams.strip.open")}
      aria-label={`${t("teams.strip.label")} · ${phaseLabel}`}
    >
      <svg
        className="agent-team-strip-icon"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span className="agent-team-strip-label">{t("teams.strip.label")}</span>
      <span className="agent-team-strip-avatars" aria-hidden="true">
        {shown.map((member) => (
          <span
            key={member.id}
            className={`agent-team-strip-avatar agent-team-strip-avatar--${member.color}`}
            title={member.name}
          >
            {initialOf(member.name)}
          </span>
        ))}
        {overflow > 0 && (
          <span className="agent-team-strip-avatar agent-team-strip-avatar--overflow">{`+${overflow}`}</span>
        )}
      </span>
      <span className="agent-team-strip-phase">
        <span
          className={`agent-team-strip-dot agent-team-strip-dot--${phase}`}
          aria-hidden="true"
        />
        <span className="agent-team-strip-phase-label">{phaseLabel}</span>
      </span>
      <span className="agent-team-strip-progress">
        {t("teams.strip.tasks", { completed: progress.completed, total: progress.total })}
      </span>
      <span className="agent-team-strip-open" aria-hidden="true">
        {t("teams.strip.open")}
        <span className="agent-team-strip-open-chevron"> ›</span>
      </span>
    </button>
  );
}
