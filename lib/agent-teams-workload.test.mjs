import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { deriveTeamWorkload } = await jiti.import("@/lib/agent-teams-workload.ts");

const QUOTA = { perTeamLimit: 12, globalLimit: 32, rosterWorkers: 3, globalWorkers: 5 };

function ticket(id, subject, status, assignments) {
  return { id, subject, status, assignments };
}

test("四分类：running/pending/idle 按 assignment 状态归类", () => {
  const workload = deriveTeamWorkload({
    memberNames: ["alice", "bob", "carol"],
    idleNames: ["alice", "bob", "carol"],
    tickets: [
      ticket("t1", "在跑的票", "open", [
        { id: "a1", assignee: "alice", status: "running", updatedAt: 1 },
        { id: "a2", assignee: "bob", status: "pending", updatedAt: 2 },
      ]),
    ],
    quota: QUOTA,
  });
  const byName = new Map(workload.members.map((member) => [member.name, member]));
  assert.equal(byName.get("alice").state, "running");
  assert.equal(byName.get("bob").state, "pending");
  assert.equal(byName.get("carol").state, "idle");
});

test("孤儿票：assignee 不在名册 ⇒ orphans 单列，永不进接收者候选", () => {
  const workload = deriveTeamWorkload({
    memberNames: ["alice", "bob"],
    idleNames: ["alice", "bob"],
    tickets: [
      ticket("t1", "孤儿票", "open", [
        { id: "a1", assignee: "ghost", status: "pending", updatedAt: 10 },
      ]),
    ],
    quota: QUOTA,
  });
  assert.deepEqual(workload.orphans.map((orphan) => `${orphan.ticketId}/${orphan.assignmentId}`), ["t1/a1"]);
  // alice 空闲 ⇒ 有 reassign 建议，接收者不可能是 ghost。
  const reassign = workload.suggestions.find((suggestion) => suggestion.kind === "reassign");
  assert.ok(reassign);
  assert.equal(reassign.toMember, "alice");
  assert.equal(reassign.fromMember, "ghost");
  assert.equal(reassign.expectedUpdatedAt, 10);
});

test("orphan-running 严禁改派：running 的孤儿派活不产生 reassign 建议", () => {
  const workload = deriveTeamWorkload({
    memberNames: ["alice"],
    idleNames: ["alice"],
    tickets: [
      ticket("t1", "孤儿在跑", "open", [
        { id: "a1", assignee: "ghost", status: "running", updatedAt: 10 },
      ]),
    ],
    quota: QUOTA,
  });
  assert.ok(workload.orphans.length === 1);
  assert.equal(workload.suggestions.filter((suggestion) => suggestion.kind === "reassign").length, 0);
});

test("open 无主票产出 kind:assign 建议；无 idle 时计积压", () => {
  const withIdle = deriveTeamWorkload({
    memberNames: ["alice"],
    idleNames: ["alice"],
    tickets: [ticket("t1", "新票", "open", [])],
    quota: QUOTA,
  });
  assert.equal(withIdle.suggestions[0].kind, "assign");
  assert.equal(withIdle.suggestions[0].toMember, "alice");

  const noIdle = deriveTeamWorkload({
    memberNames: ["alice"],
    idleNames: [],
    tickets: [ticket("t1", "新票", "open", [])],
    quota: QUOTA,
  });
  // 无 idle ⇒ assign 无法落地 ⇒ 计积压 ⇒ add-member 建议（配额有余量）。
  assert.equal(noIdle.suggestions.filter((suggestion) => suggestion.kind === "assign").length, 0);
  assert.ok(noIdle.suggestions.some((suggestion) => suggestion.kind === "add-member"));
});

test("一票一条建议 + idle 本轮去重：多张积压 × 单 idle ⇒ 仅一条 reassign", () => {
  const workload = deriveTeamWorkload({
    memberNames: ["alice", "busy1", "busy2"],
    idleNames: ["alice"],
    tickets: [
      ticket("t1", "积压一", "open", [{ id: "a1", assignee: "busy1", status: "pending", updatedAt: 1 }]),
      ticket("t2", "积压二", "open", [{ id: "a2", assignee: "busy2", status: "pending", updatedAt: 2 }]),
    ],
    quota: QUOTA,
  });
  const reassigns = workload.suggestions.filter((suggestion) => suggestion.kind === "reassign");
  assert.equal(reassigns.length, 1, "alice 只被推荐一次");
  assert.equal(reassigns[0].toMember, "alice");
});

test("名册内 pending 积压：有 idle ⇒ reassign 建议；无 idle ⇒ 计入 add-member", () => {
  const withIdle = deriveTeamWorkload({
    memberNames: ["alice", "bob"],
    idleNames: ["alice"],
    tickets: [ticket("t1", "积压", "open", [{ id: "a1", assignee: "bob", status: "pending", updatedAt: 5 }])],
    quota: QUOTA,
  });
  assert.ok(withIdle.suggestions.some((suggestion) => suggestion.kind === "reassign" && suggestion.toMember === "alice"));

  const noIdle = deriveTeamWorkload({
    memberNames: ["alice", "bob"],
    idleNames: [],
    tickets: [ticket("t1", "积压", "open", [{ id: "a1", assignee: "bob", status: "pending", updatedAt: 5 }])],
    quota: QUOTA,
  });
  assert.equal(noIdle.suggestions.filter((suggestion) => suggestion.kind === "reassign").length, 0);
  assert.ok(noIdle.suggestions.some((suggestion) => suggestion.kind === "add-member"), "无 idle 积压 ⇒ add-member");
});

test("per-team 配额满 ⇒ 不发 add-member 建议（给了按钮必 409）", () => {
  const workload = deriveTeamWorkload({
    memberNames: ["m1", "m2"],
    idleNames: [],
    tickets: [ticket("t1", "积压", "open", [{ id: "a1", assignee: "m1", status: "pending", updatedAt: 5 }])],
    quota: { ...QUOTA, perTeamLimit: 2 },
  });
  assert.equal(workload.suggestions.filter((suggestion) => suggestion.kind === "add-member").length, 0);
});

test("ended orphan 排除：ended 的派活不是孤儿（lead 复核）", () => {
  const workload = deriveTeamWorkload({
    memberNames: ["alice"],
    idleNames: ["alice"],
    tickets: [
      ticket("t1", "历史票", "open", [{ id: "a1", assignee: "ghost", status: "ended", updatedAt: 1 }]),
    ],
    quota: QUOTA,
  });
  assert.deepEqual(workload.orphans, [], "ended 派活不得计入 orphans");
});

test("全局配额满 ⇒ 不发 add-member（lead 复核）", () => {
  const workload = deriveTeamWorkload({
    memberNames: ["m1"],
    idleNames: [],
    tickets: [ticket("t1", "积压", "open", [{ id: "a1", assignee: "m1", status: "pending", updatedAt: 5 }])],
    quota: { ...QUOTA, globalWorkers: 32, globalLimit: 32 },
  });
  assert.equal(workload.suggestions.filter((suggestion) => suggestion.kind === "add-member").length, 0);
});

test("ended 票整票排除：不计负载、不计孤儿（lead 复核）", () => {
  const workload = deriveTeamWorkload({
    memberNames: ["alice", "bob"],
    idleNames: ["alice", "bob"],
    tickets: [
      ticket("t-done", "已结束", "ended", [
        { id: "a1", assignee: "ghost", status: "pending", updatedAt: 1 },
        { id: "a2", assignee: "alice", status: "running", updatedAt: 2 },
      ]),
    ],
    quota: QUOTA,
  });
  assert.deepEqual(workload.orphans, [], "ended 票的孤儿不算");
  const byName = new Map(workload.members.map((member) => [member.name, member]));
  assert.equal(byName.get("alice").runningCount, 0, "ended 票的 running 不计负载");
  assert.equal(byName.get("alice").state, "idle");
});

test("route 两段式语义：pending/running 成员不再被推荐（先派生后选 idle）", () => {
  // 模拟 route 的两段式：第一遍全成员派生 → 只把 idle 传第二遍。
  const memberNames = ["alice", "bob", "carol"];
  const tickets = [
    ticket("t1", "积压", "open", [{ id: "a1", assignee: "bob", status: "pending", updatedAt: 1 }]),
  ];
  const firstPass = deriveTeamWorkload({ memberNames, idleNames: memberNames, tickets, quota: QUOTA });
  const idleNames = firstPass.members.filter((member) => member.state === "idle").map((member) => member.name);
  const suggestions = deriveTeamWorkload({ memberNames, idleNames, tickets, quota: QUOTA }).suggestions;
  assert.deepEqual(idleNames, ["alice", "carol"], "bob=pending 不在候选");
  const targets = suggestions.filter((suggestion) => suggestion.kind === "reassign").map((suggestion) => suggestion.toMember);
  assert.ok(!targets.includes("bob"), "pending 成员不得被推荐（重复派活）");
  assert.ok(targets.every((name) => idleNames.includes(name)), "接收者全部来自 idle");
});
