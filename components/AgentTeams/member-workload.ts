/**
 * 成员忙闲/积压派生（#55 第一段，纯读）：从快照的 tickets[].assignments[] 派生
 * 每个名册成员的 running/pending 计数与最近活动时间，供编队带徽标与成员区
 * 「空闲成员」标注消费。零副作用、不依赖 DOM，可被组件与测试直接 import。
 *
 * 已知降级（需求方要求显式定义）：assignment.memberId 在投影里解析不到成员时
 * 是 null（运行时票的 assignee 不在名册）；这类派活不归任何成员卡，聚合进
 * orphan 桶，由调用方决定降级展示（AgentTeamsView 成员区 hint）。
 */

import type { TeamWorkbenchSnapshot } from "@/lib/agent-teams-swimlane";

/** 单个名册成员的忙闲计数（只统计未结束的派活：running / pending）。 */
export interface MemberWorkload {
  memberId: string;
  /** 名下 running 派活数。 */
  runningCount: number;
  /** 名下 pending（未开工）派活数。 */
  pendingCount: number;
  /** 名下派活的最新 lastActivityAt（ISO 字符串；一条都没有时为 null）。 */
  latestActivityAt: string | null;
  /** 空闲 = 名下无 running 且无 pending 派活（与工作态 MemberWorkState 的
   *  idle「静默」语义不同：这里只看票面归属）。 */
  idle: boolean;
}

/** 未落在任何名册成员上的派活聚合（memberId 为 null 或不在名册）。 */
export interface OrphanWorkload {
  runningCount: number;
  pendingCount: number;
}

export interface DerivedWorkloads {
  /** 名册成员 id → 忙闲计数（只含名册成员）。 */
  byMemberId: Map<string, MemberWorkload>;
  /** 未认领派活聚合（降级显示用）。 */
  orphan: OrphanWorkload;
}

export function deriveMemberWorkloads(snapshot: TeamWorkbenchSnapshot): DerivedWorkloads {
  const byMemberId = new Map<string, MemberWorkload>();
  for (const member of snapshot.members) {
    byMemberId.set(member.id, {
      memberId: member.id,
      runningCount: 0,
      pendingCount: 0,
      latestActivityAt: null,
      idle: true,
    });
  }

  const orphan: OrphanWorkload = { runningCount: 0, pendingCount: 0 };

  for (const ticket of snapshot.tickets) {
    for (const assignment of ticket.assignments) {
      // 名下派活只有未结束的才构成「忙/积压」；ended 是历史，不计数。
      if (assignment.status === "running") {
        const entry = assignment.memberId !== null ? byMemberId.get(assignment.memberId) : undefined;
        if (entry) {
          entry.runningCount += 1;
          if (assignment.lastActivityAt && assignment.lastActivityAt > (entry.latestActivityAt ?? "")) {
            entry.latestActivityAt = assignment.lastActivityAt;
          }
        } else {
          orphan.runningCount += 1;
        }
      } else if (assignment.status === "pending") {
        const entry = assignment.memberId !== null ? byMemberId.get(assignment.memberId) : undefined;
        if (entry) {
          entry.pendingCount += 1;
          if (assignment.lastActivityAt && assignment.lastActivityAt > (entry.latestActivityAt ?? "")) {
            entry.latestActivityAt = assignment.lastActivityAt;
          }
        } else {
          orphan.pendingCount += 1;
        }
      }
    }
  }

  for (const entry of byMemberId.values()) {
    entry.idle = entry.runningCount === 0 && entry.pendingCount === 0;
  }

  return { byMemberId, orphan };
}

/**
 * 队长判定——与 lib/agent-teams-formation-layout.ts 的 pickLead 同口径（sessionId
 * 命中 team.leadSessionId → 名字 "team-lead" → 首位兜底；该函数未导出，故此处本地
 * 复刻，两处需同步维护）。lead 不接票，绝不进空闲接派候选：否则成员区「空闲成员」
 * 名单会列出 team-lead（#55 独立复核判红项）。
 */
function isLeadMember(snapshot: TeamWorkbenchSnapshot, memberId: string): boolean {
  const members = snapshot.members;
  if (members.length === 0) return false;
  const lead = (snapshot.team.leadSessionId
    ? members.find((member) => member.sessionId && member.sessionId === snapshot.team.leadSessionId)
    : undefined)
    ?? members.find((member) => member.name === "team-lead")
    ?? members[0];
  return lead?.id === memberId;
}

/** 名下无未结束派活的成员 id 列表（按名册顺序，**不含 lead**），供「空闲成员：…」标注。 */
export function idleMemberIds(snapshot: TeamWorkbenchSnapshot): string[] {
  const { byMemberId } = deriveMemberWorkloads(snapshot);
  const idle: string[] = [];
  for (const member of snapshot.members) {
    if (isLeadMember(snapshot, member.id)) continue;
    const entry = byMemberId.get(member.id);
    if (entry?.idle) idle.push(member.id);
  }
  return idle;
}

/** 忙闲徽标形态（#55 第一段，纯展示决策）：running 优先于 pending；两者皆 0 即空闲。 */
export function workloadBadgeKind(
  entry: Pick<MemberWorkload, "runningCount" | "pendingCount">,
): "idle" | "running" | "pending" {
  if (entry.runningCount > 0) return "running";
  if (entry.pendingCount > 0) return "pending";
  return "idle";
}
