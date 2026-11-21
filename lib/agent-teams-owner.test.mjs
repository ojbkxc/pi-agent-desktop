import assert from "node:assert/strict";
import test from "node:test";

import { resolveTicketOwner } from "./agent-teams-owner.ts";

function member(id, name = id, overrides = {}) {
  return {
    id,
    name,
    role: "member",
    model: null,
    providerName: null,
    color: "blue",
    status: "idle",
    activity: "idle",
    isLead: false,
    sessionId: null,
    cwd: "",
    worktreePath: null,
    lastError: null,
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function assignment(memberId, overrides = {}) {
  return {
    id: `as-${memberId}`,
    status: "running",
    memberId,
    assignee: memberId ?? "ghost",
    sessionId: null,
    startedAt: null,
    lastActivityAt: null,
    result: null,
    outcome: null,
    ...overrides,
  };
}

function ticket(overrides = {}) {
  return {
    id: "t1",
    subject: "Do work",
    description: "",
    ownerId: null,
    status: "open",
    dependencies: [],
    assignments: [],
    source: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: "m1",
    from: "team-lead",
    to: "w1",
    recipients: ["w1"],
    kind: "direct",
    text: JSON.stringify({ type: "task_assignment", taskId: "t1" }),
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("显式 ownerId：直接采纳，inferred=false，名称取自名册", () => {
  const resolved = resolveTicketOwner(ticket({ ownerId: "w1" }), [member("w1", "worker-one")], []);
  assert.deepEqual(resolved, { memberId: "w1", memberName: "worker-one", inferred: false });
});

test("显式 ownerId 优先于 assignments / 消息回填", () => {
  const resolved = resolveTicketOwner(
    ticket({ ownerId: "w1", assignments: [assignment("w2")] }),
    [member("w1"), member("w2")],
    [message({ to: "w3", recipients: ["w3"] })],
  );
  assert.equal(resolved.memberId, "w1");
  assert.equal(resolved.inferred, false);
});

test("ownerId 缺失 → assignments 回填（取最后一条带 memberId 的），inferred=true", () => {
  const resolved = resolveTicketOwner(
    ticket({ ownerId: null, assignments: [assignment("w1"), assignment("w2")] }),
    [member("w1"), member("w2")],
    [],
  );
  assert.deepEqual(resolved, { memberId: "w2", memberName: "w2", inferred: true }, "最后一条带 memberId 的派活胜出");
});

test("assignments 里没有 memberId 的条目被跳过，落到消息回填", () => {
  const resolved = resolveTicketOwner(
    ticket({
      ownerId: null,
      assignments: [assignment(null, { assignee: "not-in-roster" })],
    }),
    [member("w2")],
    [message({ taskId: "t1", protocolType: "task_assignment", to: "w2", recipients: ["w2"] })],
  );
  assert.deepEqual(resolved, { memberId: "w2", memberName: "w2", inferred: true });
});

test("消息回填：该票 task_assignment 的收件人被采纳，inferred=true", () => {
  const resolved = resolveTicketOwner(
    ticket({ id: "t9", ownerId: null }),
    [member("w1", "worker-one")],
    [message({ id: "m-other", taskId: "t1", protocolType: "task_assignment", to: "w2", recipients: ["w2"] }),
      message({ id: "m-hit", taskId: "t9", protocolType: "task_assignment", to: "w1", recipients: ["w1"] })],
  );
  assert.deepEqual(resolved, { memberId: "w1", memberName: "worker-one", inferred: true });
});

test("消息回填：非 task_assignment 的消息不算数", () => {
  const resolved = resolveTicketOwner(
    ticket({ id: "t9", ownerId: null }),
    [member("w1")],
    [message({ taskId: "t9", protocolType: "idle_notification", to: "w1", recipients: ["w1"] })],
  );
  assert.deepEqual(resolved, { memberId: null, memberName: null, inferred: false });
});

test("显式空 owner（空串）不回填：assignments / 消息都不参与", () => {
  const resolved = resolveTicketOwner(
    ticket({
      ownerId: "",
      assignments: [assignment("w1")],
    }),
    [member("w1")],
    [message({ taskId: "t1", protocolType: "task_assignment", to: "w1", recipients: ["w1"] })],
  );
  assert.deepEqual(resolved, { memberId: null, memberName: null, inferred: false });
});

test("ownerId 不在名册：保留原 id 作为展示名，仍算显式归属", () => {
  const resolved = resolveTicketOwner(ticket({ ownerId: "ghost" }), [member("w1")], []);
  assert.deepEqual(resolved, { memberId: "ghost", memberName: "ghost", inferred: false });
});

test("完全无归属：返回空（不是推断）", () => {
  const resolved = resolveTicketOwner(ticket({ ownerId: null }), [member("w1")], []);
  assert.deepEqual(resolved, { memberId: null, memberName: null, inferred: false });
});

test("assignments 的 memberId 不在名册：退回 assignee 展示名", () => {
  const resolved = resolveTicketOwner(
    ticket({ ownerId: null, assignments: [assignment("missing-id", { assignee: "worker-x" })] }),
    [member("w1")],
    [],
  );
  assert.equal(resolved.inferred, true);
  assert.equal(resolved.memberId, "missing-id");
  assert.equal(resolved.memberName, "worker-x");
});
