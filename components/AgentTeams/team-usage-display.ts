/**
 * 团队占用展示的纯函数层（#63）：格式化 GET /api/teams 平铺的 usage 字段。
 * 硬规则：null/缺字段一律返回 null/不渲染信号——**绝不编造占用**；展示只读，
 * 动作只来自用户在生命周期区的显式点击（无定时器、无自动清理）。
 */

/** 与后端同源的闲置阈值（#66 复核返工：从零 Node 依赖的共用常量模块引——
 *  lib/agent-teams-team-usage.ts 顶层 node:fs 不能进 "use client" 图）。 */
import { TEAM_USAGE_IDLE_NOTICE_DAYS } from "@/lib/agent-teams-usage-constants";

/** GET /api/teams 平铺占用字段（真实契约，app/api/teams/route.ts @ 9b7c083）。 */
export interface TeamUsageFields {
  bytes?: number | null;
  files?: number;
  truncated?: boolean;
  lastActivityAt?: number | null;
  ended?: boolean | null;
  idleDays?: number | null;
  usageError?: string;
}

/** 字节数 → 可读标签；null/负值返回 null（不编造）。1024 进制，一位小数。 */
export function formatTeamBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** epoch ms → 本地日期标签；null/非法返回 null（不编造）。 */
export function formatTeamActivityDate(lastActivityAt: number | null | undefined, locale: string): string | null {
  if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return null;
  const date = new Date(lastActivityAt);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale || "en", { dateStyle: "medium" }).format(date);
  } catch {
    return null;
  }
}

/** 「已结束且闲置 ≥ 阈值」提示的判定（ended 必须**严格 true**——false/null 都不提示，
 *  null 是「无法判定」，不能编造成已结束）。 */
export function shouldNoticeIdleTeam(
  usage: TeamUsageFields | undefined,
  threshold: number = TEAM_USAGE_IDLE_NOTICE_DAYS,
): boolean {
  return usage?.ended === true
    && typeof usage.idleDays === "number"
    && Number.isFinite(usage.idleDays)
    && usage.idleDays >= threshold;
}

/** 占用行是否有任何可如实展示的内容（usageError 也是内容——失败必须如实带出）。 */
export function hasDisplayableUsage(usage: TeamUsageFields | undefined): boolean {
  if (!usage) return false;
  return usage.bytes !== undefined
    || usage.files !== undefined
    || usage.usageError !== undefined
    || usage.lastActivityAt !== undefined
    || usage.truncated === true;
}
