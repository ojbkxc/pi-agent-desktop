"use client";

import type { KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { REPLAY_SPEEDS, type ReplaySpeed } from "@/hooks/useTeamTimeline";
import { formatClock } from "@/components/AgentTeams/AgentTeamsLiveClock";

/**
 * 回放控制条（cc-haha AgentTeamsReplayBar 移植，T7）：
 *
 * - 四档倍速（0.5 / 1 / 2 / 4）只影响自动播放的帧间隔（见 replayStepMs）；
 * - `input[type=range]` 直接拖动定位任意历史帧（timeline.seek）；
 * - ←/→ 跳一帧（timeline.stepBack / stepForward）；
 * - 显示「当前帧 / 总帧」与当前帧时间，拖动时用户始终知道自己在时间线哪一格。
 *
 * 组件只管展示与输入，不持有回放状态——倍速/游标都来自 useTeamTimeline，
 * 由上层决定何时渲染（仅在回放模式）。
 */

interface Props {
  /** 当前帧下标（0 基）。 */
  selectedIndex: number;
  /** 最新帧下标（总帧数 - 1）；<= 0 时没有可回放的历史。 */
  latestIndex: number;
  /** 当前帧的生成时间（ISO）；不可解析时显示占位。 */
  frameAt: string | null;
  /** 当前倍速。 */
  speed: ReplaySpeed;
  /** 切换倍速。 */
  onSpeedChange: (speed: ReplaySpeed) => void;
  /** 跳到指定帧下标。 */
  onSeek: (index: number) => void;
  /** 相对当前帧前进/后退（-1 / +1）。 */
  onStep: (delta: number) => void;
}

export function AgentTeamsReplayBar({
  selectedIndex,
  latestIndex,
  frameAt,
  speed,
  onSpeedChange,
  onSeek,
  onStep,
}: Props) {
  const { t, locale } = useI18n();
  const hasFrames = latestIndex > 0;
  const frameTime = frameAt ? formatClock(frameAt, locale) : "--:--:--";

  // ←/→ 在整条控制条上统一跳帧：滑轨聚焦时浏览器默认也会响应方向键，
  // 这里 preventDefault 后只走 timeline.stepBack/stepForward 一条路径，避免双跳。
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!hasFrames) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onStep(event.key === "ArrowLeft" ? -1 : 1);
  };

  return (
    <div
      className="agent-teams-replay-bar"
      data-testid="agent-teams-replay-bar"
      role="group"
      aria-label={t("teams.replay.timeline")}
      onKeyDown={handleKeyDown}
      style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 16px" }}
    >
      <div
        className="agent-teams-replay-speeds"
        role="group"
        aria-label={t("teams.replay.speed")}
        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        <span className="agent-teams-replay-label">{t("teams.replay.speed")}</span>
        {REPLAY_SPEEDS.map((option) => (
          <button
            key={option}
            type="button"
            className={`agent-teams-timeline-button agent-teams-replay-speed${option === speed ? " agent-teams-replay-speed--active" : ""}`}
            data-speed={option}
            aria-pressed={option === speed}
            disabled={!hasFrames}
            onClick={() => onSpeedChange(option)}
          >
            {option}×
          </button>
        ))}
      </div>

      <span className="agent-teams-timeline-position agent-teams-replay-position">
        {t("teams.replay.position", { index: selectedIndex + 1, total: latestIndex + 1 })}
      </span>

      <span className="agent-teams-replay-time" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
        {frameTime}
      </span>

      <input
        type="range"
        className="agent-teams-replay-range"
        data-testid="agent-teams-replay-range"
        aria-label={t("teams.replay.seek")}
        min={0}
        max={Math.max(0, latestIndex)}
        step={1}
        value={Math.max(0, selectedIndex)}
        disabled={!hasFrames}
        onChange={(event) => onSeek(Number(event.currentTarget.value))}
        style={{ flex: 1, minWidth: 120 }}
      />
    </div>
  );
}
