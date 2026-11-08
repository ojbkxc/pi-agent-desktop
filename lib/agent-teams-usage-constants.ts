/**
 * 团队占用的前后端共用常量（#66 复核返工抽出）：**零 import、零 Node 依赖**——
 * lib/agent-teams-team-usage.ts（node:fs 顶层依赖）不能进任何 "use client" 图，
 * 客户端要同源阈值只能从这里引。改阈值只改这一处，前后端天然同步。
 */

/** 闲置提示阈值（天）：≥7 由 UI 仅提示（无定时器、无自动清理，动作只来自用户显式点击）。 */
export const TEAM_USAGE_IDLE_NOTICE_DAYS = 7;
