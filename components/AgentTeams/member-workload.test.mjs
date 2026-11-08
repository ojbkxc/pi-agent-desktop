import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
});
const { deriveMemberWorkloads, idleMemberIds, workloadBadgeKind } = await jiti.import("./member-workload.ts");

// 注意：本文件必须保持纯 JS（裸 node --test 可跑）；.ts 实现经 jiti 加载。

function member(id) {
  return { id, name: id, role: "member", model: null, providerName: null, color: "blue", status: "running", activity: "active", sessionId: `${id}-s`, cwd: "", worktreePath: null, lastError: null, joinedAt: "2026-01-01T00:00:00.000Z" };
}

function assignment(status, overrides = {}) {
  // 注意别用 `?? "w1"` 兜底：`null ?? "w1"` 会把显式 null 吞成 "w1"（孤儿票变有主）。
  const memberId = "memberId" in overrides ? overrides.memberId : "w1";
  return {
    id: `a-${Math.random().toString(36).slice(2)}`,
    status,
    memberId,
    assignee: memberId ?? "w1",
    sessionId: null,
    startedAt: null,
    lastActivityAt: overrides.lastActivityAt ?? null,
    result: null,
    outcome: null,
  };
}

function ticket(assignments) {
  return { id: `t-${Math.random().toString(36).slice(2)}`, subject: "s", description: "", ownerId: null, status: "open", dependencies: [], assignments, source: "plan", createdAt: "2026-01-01T00:00:00.000Z" };
}

function snapshot(members, tickets) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    team: { id: "t", name: "demo", description: "", createdAt: "2026-01-01T00:00:00.000Z", leadSessionId: null, status: "running", incarnationId: "i" },
    members,
    tickets,
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
  };
}

test("零票成员：计数全 0 且判定空闲", () => {
  const { byMemberId, orphan } = deriveMemberWorkloads(snapshot([member("w1")], []));
  const entry = byMemberId.get("w1");
  assert.ok(entry);
  assert.equal(entry.runningCount, 0);
  assert.equal(entry.pendingCount, 0);
  assert.equal(entry.latestActivityAt, null);
  assert.equal(entry.idle, true);
  assert.deepEqual(orphan, { runningCount: 0, pendingCount: 0 });
});

test("全是 pending：running=0、pending=N、不判定空闲", () => {
  const { byMemberId } = deriveMemberWorkloads(snapshot(
    [member("w1")],
    [ticket([assignment("pending"), assignment("pending")])],
  ));
  const entry = byMemberId.get("w1");
  assert.equal(entry.runningCount, 0);
  assert.equal(entry.pendingCount, 2);
  assert.equal(entry.idle, false);
});

test("running 与 pending 混合计数；ended 不计入忙闲也不参与最近活动", () => {
  const { byMemberId } = deriveMemberWorkloads(snapshot(
    [member("w1")],
    [
      ticket([
        assignment("running", { lastActivityAt: "2026-01-02T00:00:00.000Z" }),
        assignment("ended", { lastActivityAt: "2026-01-03T00:00:00.000Z" }),
        assignment("pending", { lastActivityAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    ],
  ));
  const entry = byMemberId.get("w1");
  assert.equal(entry.runningCount, 1);
  assert.equal(entry.pendingCount, 1);
  assert.equal(entry.latestActivityAt, "2026-01-02T00:00:00.000Z");
});

test("memberId 解析不到成员（null 或不在名册）→ 归入 orphan 桶", () => {
  const { byMemberId, orphan } = deriveMemberWorkloads(snapshot(
    [member("w1")],
    [
      ticket([
        assignment("running", { memberId: null }),
        assignment("pending", { memberId: "ghost" }),
        assignment("running", { memberId: "ghost" }),
      ]),
    ],
  ));
  assert.equal(byMemberId.get("w1").idle, true);
  assert.deepEqual(orphan, { runningCount: 2, pendingCount: 1 });
});

test("latestActivityAt 取名下未结束派活的最新值（全 null 则 null）", () => {
  const { byMemberId } = deriveMemberWorkloads(snapshot(
    [member("w1")],
    [
      ticket([
        assignment("running", { lastActivityAt: "2026-01-05T00:00:00.000Z" }),
        assignment("running", { lastActivityAt: null }),
      ]),
    ],
  ));
  assert.equal(byMemberId.get("w1").latestActivityAt, "2026-01-05T00:00:00.000Z");
});

test("idleMemberIds 按名册顺序输出空闲者；忙者不出现", () => {
  const ids = idleMemberIds(snapshot(
    [member("w1"), member("w2"), member("w3")],
    [ticket([assignment("running", { memberId: "w1" })])],
  ));
  assert.deepEqual(ids, ["w2", "w3"]);
});

// #55 独立复核判红项：lead 不接票，绝不进「空闲接派候选」。旧实现（不排除 lead）
// 在下面两个用例都会返回含 lead 的名单而红——判别力：排除逻辑删掉即红。
test("idleMemberIds 排除 lead：leadSessionId 命中口径（lead+空票 worker ⇒ 只 worker）", () => {
  const lead = { ...member("lead-1"), name: "team-lead", sessionId: "lead-session", role: "orchestrator" };
  const snap = snapshot([lead, member("w1")], []);
  snap.team.leadSessionId = "lead-session";
  assert.deepEqual(idleMemberIds(snap), ["w1"]);
});

test("idleMemberIds 排除 lead：leadSessionId 缺失时退化为名字 team-lead 口径", () => {
  const lead = { ...member("lead-1"), name: "team-lead", sessionId: null, role: "orchestrator" };
  const snap = snapshot([lead, member("w1")], []);
  assert.deepEqual(idleMemberIds(snap), ["w1"]);
});

test("空名册 + 有票：orphan 聚合，byMemberId 为空 Map", () => {
  const { byMemberId, orphan } = deriveMemberWorkloads(snapshot([], [ticket([assignment("pending")])]));
  assert.equal(byMemberId.size, 0);
  assert.deepEqual(orphan, { runningCount: 0, pendingCount: 1 });
});

test("workloadBadgeKind：running 优先、pending 次之、双 0 即空闲", () => {
  assert.equal(workloadBadgeKind({ runningCount: 1, pendingCount: 2 }), "running");
  assert.equal(workloadBadgeKind({ runningCount: 0, pendingCount: 2 }), "pending");
  assert.equal(workloadBadgeKind({ runningCount: 0, pendingCount: 0 }), "idle");
});
