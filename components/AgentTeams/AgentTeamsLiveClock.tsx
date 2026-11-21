"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatElapsedClock } from "@/lib/format-units";
import type { TranslationParams } from "@/lib/i18n/types";

/**
 * 秒级时钟叶子组件：把「每秒 now」关在这一个组件里。
 *
 * 此前 now 是工作台根 state——每秒 setState 会把整页（泳道、画布、通信流、
 * 检查器）全部重渲染一遍，只为刷新两行时间文本。现在根视图只在实时跟随时挂载
 * 本组件、把快照里的静态字段传进来；tick 只让这一小块重渲染。
 *
 * 定时器只在页面可见时推进（后台 tab 的 setInterval 被浏览器节流，且没人看），
 * 切回前台时 visibilitychange 立即补一次，时钟不会停在切走那一刻。
 */

/** 毫秒 → HH:MM:SS（>1h）或 MM:SS；负值夹到 0。统一走 lib/format-units 的时钟口径。 */
function formatDuration(valueMs: number): string {
  return formatElapsedClock(valueMs);
}

/** ISO → 本地 HH:MM:SS（C9 会话时钟）；不可解析回退 --:--:--。 */
export function formatClock(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "--:--:--";
  try {
    return new Date(time).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "--:--:--";
  }
}

/** C9 Live 指示的纯派生输入（全部来自快照 + 时钟，无副作用）。 */
export interface LiveIndicatorInput {
  /** snapshot.team.status。 */
  teamStatus: string;
  /** 运行中的成员数（不含队长）。 */
  workingCount: number;
  /** 是否实时跟随（回放时 elapsed/clock 冻结到当前帧）。 */
  isLive: boolean;
  /** 团队创建时间（ISO）。 */
  createdAt: string;
  /** 当前帧生成时间（ISO）。 */
  generatedAt: string;
  /** 当前毫秒时间戳（仅实时跟随时每秒推进）。 */
  now: number;
}

export interface LiveIndicator {
  /** forming / running / waiting 三态提示。 */
  hint: string;
  /** 已用时长（团队创建 → 现在，或回放时的当前帧）。 */
  elapsed: string;
  /** 会话时钟（实时=now，回放=帧时间）。 */
  clock: string;
}

/**
 * C9：把 Live 指示需要的三样（三态 hint / 已用时长 / 会话时钟）从快照与时钟纯派生出来。
 * 抽成模块级纯函数是为了能在没有 DOM 的测试里直接覆盖三态与时长/时钟的边界
 * （工作台视图本身 SSR 时 snapshot 为 null，起不到断言作用）。
 */
export function deriveLiveIndicator(
  input: LiveIndicatorInput,
  t: (key: string, params?: TranslationParams) => string,
  locale: string,
): LiveIndicator {
  const hint = input.teamStatus === "forming"
    ? t("teams.live.formingHint")
    : input.workingCount > 0
      ? t("teams.live.runningHint", { count: input.workingCount })
      : t("teams.live.waitingHint");
  const startMs = Date.parse(input.createdAt);
  const frameMs = Date.parse(input.generatedAt);
  const start = Number.isFinite(startMs) ? startMs : Number.isFinite(frameMs) ? frameMs : input.now;
  const end = input.isLive ? input.now : Number.isFinite(frameMs) ? frameMs : input.now;
  const clock = input.isLive
    ? formatClock(new Date(input.now).toISOString(), locale)
    : formatClock(input.generatedAt, locale);
  return { hint, elapsed: formatDuration(end - start), clock };
}

interface Props {
  /** snapshot.team.status。 */
  teamStatus: string;
  /** 运行中的成员数（不含队长）。 */
  workingCount: number;
  /** 团队创建时间（ISO）。 */
  createdAt: string;
  /** 当前帧生成时间（ISO）。 */
  generatedAt: string;
}

/** 实时跟随时的工作台 Live 条：following 徽标 + 三态提示 + 已用时长 + 会话时钟。 */
export function AgentTeamsLiveClock({ teamStatus, workingCount, createdAt, generatedAt }: Props) {
  const { t, locale } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const doc = typeof document === "undefined" ? null : document;
    const tick = () => {
      if (doc && doc.visibilityState !== "visible") return;
      setNow(Date.now());
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    doc?.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      doc?.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const liveIndicator = deriveLiveIndicator({ teamStatus, workingCount, isLive: true, createdAt, generatedAt, now }, t, locale);

  return (
    <div
      className="agent-teams-live"
      data-testid="agent-teams-live-controls"
      style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
    >
      <span className="agent-teams-timeline-state agent-teams-timeline-state--live">
        <span className="agent-teams-timeline-dot agent-teams-timeline-dot--live" aria-hidden="true" />
        {t("teams.live.following")}
      </span>
      <span className="agent-teams-live-hint" style={{ color: "var(--text-muted)", fontSize: "var(--fs-small)" }}>
        {liveIndicator.hint}
      </span>
      <span className="agent-teams-live-stat" style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
        <span className="agent-teams-member-role" style={{ fontSize: "var(--fs-micro)" }}>{t("teams.live.elapsed")}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{liveIndicator.elapsed}</span>
      </span>
      <span className="agent-teams-live-stat" style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
        <span className="agent-teams-member-role" style={{ fontSize: "var(--fs-micro)" }}>{t("teams.live.sessionClock")}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{liveIndicator.clock}</span>
      </span>
    </div>
  );
}
