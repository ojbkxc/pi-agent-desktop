"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { interpolateMessage } from "@/lib/i18n/format";
import type { TranslationParams } from "@/lib/i18n/types";
import type { GoalState } from "@/lib/goal/goal-types";

/**
 * `/goal` 目标进度条（会话消息列表上方的常驻条，对齐 cc-haha 的 ActiveGoalStrip）。
 *
 * **纯展示组件**：数据由调用方用 `useGoalState(sessionId)` 提供（本文件不取数）。
 * 无目标 / 已完成 / 已清除 / 目标文本为空时返回 `null`，不占位。
 * 样式内联 + 主题 CSS 变量，不新增全局类（避免与 native-theme.css 抢）。
 */
interface Props {
  /** 目标状态；null = 无目标。 */
  goal: GoalState | null;
  /**
   * 会话是否正在跑。`goal.status === "active"` 时用它区分「Loop running」（正在跑）
   * 与「Active」（已启动但当前空闲）。缺省 false → 显示 Active。
   */
  isRunning?: boolean;
  /** 窄屏紧凑档：隐藏元信息（Budget / Continuations / Elapsed）。 */
  compact?: boolean;
}

/** 状态 → 状态点颜色（主题 token）。completed 正常不会渲染，保留以防万一。 */
function statusToneColor(status: GoalState["status"]): string {
  if (status === "paused") return "var(--warning)";
  if (status === "completed") return "var(--success)";
  return "var(--accent)";
}

/** 取词条；缺失（`t` 原样返回 key）时回退到内置文案（同样做 `{value}` 插值），绝不把 i18n key 渲染到界面。 */
function tOr(t: (key: string, params?: TranslationParams) => string, key: string, fallback: string, params?: TranslationParams): string {
  const label = t(key, params);
  return label === key ? interpolateMessage(fallback, params ?? {}) : label;
}

/** 毫秒 → 紧凑时长（`3m 05s` / `42s`），供 Elapsed 元信息用。 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

const S: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    maxWidth: "100%",
    minWidth: 0,
    marginBottom: 8,
    padding: "6px 10px",
    border: "var(--hairline) solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--bg-panel)",
    fontSize: "var(--fs-caption)",
  },
  barCompact: { fontSize: "var(--fs-micro)" },
  icon: { flexShrink: 0, color: "var(--accent)" },
  title: { flexShrink: 0, fontWeight: "var(--fw-semibold)", color: "var(--text)", whiteSpace: "nowrap" },
  dot: { flexShrink: 0, width: 6, height: 6, borderRadius: 999 },
  status: { flexShrink: 0, color: "var(--text-dim)", whiteSpace: "nowrap" },
  objective: { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: "var(--fw-medium)", color: "var(--text)" },
  meta: { flexShrink: 0, display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: "var(--fs-micro)" },
  metaItem: { maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
};

export function GoalStrip({ goal, isRunning = false, compact = false }: Props) {
  const { t } = useI18n();

  // 无目标 / 已完成 / 已清除 → 不渲染（用户拍板：completed 或没有目标都不占位）。
  if (!goal || goal.status === "completed" || goal.status === "cleared") return null;
  const objective = goal.objective?.trim();
  if (!objective) return null;

  const statusLabel = isRunning
    ? tOr(t, "chat.activeGoal.running", "Loop running")
    : goal.status === "paused"
      ? tOr(t, "chat.activeGoal.paused", "Paused")
      : tOr(t, "chat.activeGoal.active", "Active");

  const meta: string[] = [];
  if (typeof goal.budget === "number" && goal.budget > 0) {
    meta.push(tOr(t, "chat.activeGoal.budget", "Budget {value}", { value: goal.budget }));
  }
  if (goal.continuations > 0) {
    meta.push(tOr(t, "chat.activeGoal.continuations", "{value} continuations", { value: goal.continuations }));
  }
  if (goal.elapsedMs > 0) {
    meta.push(tOr(t, "chat.activeGoal.elapsed", "Elapsed {value}", { value: formatElapsed(goal.elapsedMs) }));
  }

  return (
    <div
      data-testid="active-goal-strip"
      style={{ ...S.bar, ...(compact ? S.barCompact : null) }}
    >
      {/* 目标靶心图标：纯装饰，不使用彩色 emoji。 */}
      <svg width={compact ? 13 : 14} height={compact ? 13 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" style={S.icon} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4.5" />
        <circle cx="12" cy="12" r="0.6" fill="currentColor" />
      </svg>

      <span style={S.title}>{tOr(t, "chat.activeGoal.title", "Active goal")}</span>

      <span style={{ ...S.dot, background: statusToneColor(goal.status) }} aria-hidden="true" />

      <span data-active-goal-status style={S.status}>{statusLabel}</span>

      <span data-active-goal-objective style={S.objective} title={objective}>{objective}</span>

      {!compact && meta.length > 0 ? (
        <span data-active-goal-meta style={S.meta}>
          {meta.map((item) => (
            <span key={item} style={S.metaItem}>{item}</span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
