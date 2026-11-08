/**
 * 团队忙闲/积压派生（#54，只读建议端点的纯核心）。
 *
 * 输入 = config.json 名册 + tickets/*.json 的真实落盘（assignment 三态
 * {pending, running, ended}），输出 = 每成员负载四分类 + 一键调度建议。
 * 纯函数、零副作用：文件读取由 route 装配，这里不做任何 IO。
 *
 * 口径（与 v5 设计钉死，#55 前端按此消费）：
 * - running：名下存在 status="running" 的 assignment；
 * - pending：名下存在 status="pending" 的 assignment（被派未跑——**不是空闲**，
 *   不作为接收者候选）；
 * - idle：名册成员且名下零未 ended（零 pending/running）assignment（唯一接收者候选）；
 * - orphan：某票的 assignee 不在名册（成员已删/名字写错）——单列 orphans，永不进
 *   接收者候选；**orphan 中 status="running" 者严禁改派**（票面在跑、桌面无从停它，
 *   改派即双主），不产生任何 reassign 建议；
 * - 贪心去重：一张票至多一条建议；同一 idle 成员在本响应内只推荐一次——杜绝 UI
 *   批量点击把多张票塞给同一人造成多主。
 */

/** tickets/<id>.json 的投影子集（route 从落盘原样读入）。 */
export interface WorkloadTicket {
  id: string;
  subject: string;
  status: string;
  assignments: Array<{ id: string; assignee: string; status: string; updatedAt: number }>;
}

export interface TeamWorkloadMember {
  name: string;
  state: "running" | "pending" | "idle";
  runningCount: number;
  pendingCount: number;
}

export interface TeamWorkloadOrphan {
  ticketId: string;
  assignmentId: string;
  assignee: string;
  status: string;
  subject: string;
}

export interface WorkloadSuggestion {
  kind: "assign" | "reassign" | "add-member";
  ticketId: string;
  assignmentId?: string;
  fromMember?: string;
  toMember?: string;
  expectedUpdatedAt?: number;
  reason: string;
}

export interface TeamWorkloadQuota {
  perTeamLimit: number;
  globalLimit: number;
  rosterWorkers: number;
  globalWorkers: number;
}

export interface TeamWorkload {
  members: TeamWorkloadMember[];
  orphans: TeamWorkloadOrphan[];
  suggestions: WorkloadSuggestion[];
  quota: TeamWorkloadQuota;
}

function isUnended(status: string): boolean {
  return status === "pending" || status === "running";
}

/**
 * 派生忙闲与建议。`memberNames` 是 config 名册的全部成员名（含 lead——lead 不接活，
 * 由调用方剔除后传入，或传入含 lead 的名单也只按「无未 ended 派活」归类，不会被
 * 推荐为接收者：建议的接收者从 `idleNames` 取，见下）。
 *
 * `idleNames`：可作接收者的名册名（route 传入时排除 lead），确定性顺序。
 * `globalCandidatesExhausted` 由 quota 侧判断：rosterWorkers ≥ perTeamLimit 时，
 * 即使有 idle 也无法再接（配额满），建议转为 add-member。
 */
export function deriveTeamWorkload(input: {
  memberNames: readonly string[];
  idleNames: readonly string[];
  tickets: readonly WorkloadTicket[];
  quota: TeamWorkloadQuota;
}): TeamWorkload {
  const memberNames = [...input.memberNames];
  const rosterSet = new Set(memberNames);

  // 每成员 running/pending 计数（orphan assignee 不占 members）。
  const runningByMember = new Map<string, number>();
  const pendingByMember = new Map<string, number>();
  for (const name of memberNames) {
    runningByMember.set(name, 0);
    pendingByMember.set(name, 0);
  }
  const orphans: TeamWorkloadOrphan[] = [];
  for (const ticket of input.tickets) {
    // ended 票是历史账：整票不计负载、不计孤儿（lead 复核：只排 assignment.ended
    // 会漏「票已 ended 但 assignment 未同步」的形态）。
    if (ticket.status === "ended") continue;
    for (const assignment of ticket.assignments ?? []) {
      // ended 的派活（不管在不在名册）都不是「需要处置的孤儿」——它已是历史账；
      // orphan 只关心需要接管/改派的活派活（lead 复核：ended orphan 必须排除）。
      if (assignment.status === "ended") continue;
      if (!rosterSet.has(assignment.assignee)) {
        orphans.push({
          ticketId: ticket.id,
          assignmentId: assignment.id,
          assignee: assignment.assignee,
          status: assignment.status,
          subject: ticket.subject,
        });
        continue;
      }
      if (assignment.status === "running") {
        runningByMember.set(assignment.assignee, (runningByMember.get(assignment.assignee) ?? 0) + 1);
      } else if (assignment.status === "pending") {
        pendingByMember.set(assignment.assignee, (pendingByMember.get(assignment.assignee) ?? 0) + 1);
      }
    }
  }

  const members: TeamWorkloadMember[] = memberNames.map((name) => {
    const runningCount = runningByMember.get(name) ?? 0;
    const pendingCount = pendingByMember.get(name) ?? 0;
    const state = runningCount > 0 ? "running" : pendingCount > 0 ? "pending" : "idle";
    return { name, state, runningCount, pendingCount };
  });

  // ── 建议：一票一条、idle 本轮去重 ──────────────────────────────────────────
  const idleOrder = [...input.idleNames];
  const available = new Set(idleOrder);
  const suggestions: WorkloadSuggestion[] = [];
  let unmetBacklog = 0;
  for (const ticket of input.tickets) {
    if (ticket.status !== "open") continue;
    const unended = (ticket.assignments ?? []).filter((assignment) => isUnended(assignment.status));
    if (unended.length === 0) {
      // open 且无任何未 ended 派活 ⇒ 首次分配建议。
      const toMember = takeIdle();
      if (toMember) {
        suggestions.push({
          kind: "assign",
          ticketId: ticket.id,
          toMember,
          reason: `工单「${ticket.subject}」尚无进行中的派活，建议派给空闲成员 ${toMember}。`,
        });
      } else {
        unmetBacklog += 1;
      }
      continue;
    }
    // orphan 派活：pending 可建议改派；running（含 orphan-running）严禁改派。
    for (const assignment of unended) {
      if (assignment.status === "running") continue; // 严禁改派（双主）
      const orphan = !rosterSet.has(assignment.assignee);
      const toMember = takeIdle();
      if (toMember) {
        suggestions.push({
          kind: "reassign",
          ticketId: ticket.id,
          assignmentId: assignment.id,
          fromMember: assignment.assignee,
          toMember,
          expectedUpdatedAt: assignment.updatedAt,
          reason: orphan
            ? `工单「${ticket.subject}」的派活归属「${assignment.assignee}」已不在名册，建议改派给空闲成员 ${toMember}。`
            : `工单「${ticket.subject}」在「${assignment.assignee}」名下排队（pending），而 ${toMember} 空闲，建议改派以并行推进。`,
        });
      } else {
        unmetBacklog += 1;
      }
    }
  }

  // 全员非 idle 且仍有未满足的积压 ⇒ 建议加成员；**per-team 配额满或全局配额满都不
  // 发**（加了也进不来，给了按钮必 409——队长裁定：不能悄悄改契约，满即不发；lead
  // 复核补：globalWorkers ≥ globalLimit 同样不发）。
  if (
    unmetBacklog > 0
    && memberNames.length < input.quota.perTeamLimit
    && input.quota.globalWorkers < input.quota.globalLimit
  ) {
    const toMember = takeIdle();
    suggestions.push({
      kind: "add-member",
      ticketId: input.tickets[0]?.id ?? "",
      ...(toMember ? { toMember } : {}),
      reason:
        `还有 ${unmetBacklog} 张工单缺人且团队无空闲成员` +
        `（每团队配额还剩 ${input.quota.perTeamLimit - memberNames.length} 名，全局已用 ${input.quota.globalWorkers}/${input.quota.globalLimit}）。`,
    });
  }

  return { members, orphans, suggestions, quota: input.quota };

  /** 从空闲池取一个未推荐过的成员（确定性顺序）。 */
  function takeIdle(): string | undefined {
    for (const name of idleOrder) {
      if (available.has(name)) {
        available.delete(name);
        return name;
      }
    }
    return undefined;
  }
}
