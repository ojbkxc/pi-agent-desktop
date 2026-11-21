import assert from "node:assert/strict";
import test from "node:test";

import { ticketProgress, ticketStalled } from "./agent-teams-task-progress.ts";

function assignment(over = {}) {
  return {
    id: "a1",
    status: "pending",
    memberId: "m1",
    assignee: "m1",
    sessionId: null,
    startedAt: null,
    lastActivityAt: null,
    result: null,
    outcome: null,
    ...over,
  };
}

function ticket(over = {}) {
  return {
    id: "t1",
    subject: "t1",
    description: "",
    ownerId: "m1",
    status: "open",
    dependencies: [],
    assignments: [],
    source: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function member(id, status) {
  return { id, name: id, status };
}

test("无派活 → none / 0", () => {
  assert.deepEqual(ticketProgress(ticket()), { mode: "none", percent: 0 });
});

test("只有 running 派活 → 不确定进度", () => {
  assert.deepEqual(
    ticketProgress(ticket({ assignments: [assignment({ status: "running" })] })),
    { mode: "indeterminate", percent: 0 },
  );
});

test("有 ended 锚点 + running → 确定比例", () => {
  const progress = ticketProgress(ticket({
    assignments: [
      assignment({ id: "a1", status: "ended", outcome: "completed" }),
      assignment({ id: "a2", status: "running" }),
    ],
  }));
  assert.deepEqual(progress, { mode: "determinate", percent: 50 });
});

test("全部 ended（含失败）→ 100%", () => {
  const progress = ticketProgress(ticket({
    assignments: [
      assignment({ id: "a1", status: "ended", outcome: "completed" }),
      assignment({ id: "a2", status: "ended", outcome: "failed" }),
    ],
  }));
  assert.deepEqual(progress, { mode: "determinate", percent: 100 });
});

test("只有 pending → 确定 0%", () => {
  assert.deepEqual(
    ticketProgress(ticket({ assignments: [assignment({ status: "pending" })] })),
    { mode: "determinate", percent: 0 },
  );
});

test("停滞：未结束票 + running 派活落在 failed/parked/aborted 成员上", () => {
  const t = ticket({ assignments: [assignment({ status: "running", memberId: "m1" })] });
  assert.equal(ticketStalled(t, [member("m1", "failed")]), true);
  assert.equal(ticketStalled(t, [member("m1", "parked")]), true);
  assert.equal(ticketStalled(t, [member("m1", "aborted")]), true);
  assert.equal(ticketStalled(t, [member("m1", "running")]), false, "成员仍在跑不算停滞");
  assert.equal(ticketStalled(t, [member("m1", "idle")]), false);
});

test("停滞：票已结束、成员不在名册、memberId 为 null 都不算", () => {
  const ended = ticket({
    status: "ended",
    assignments: [assignment({ status: "running", memberId: "m1" })],
  });
  assert.equal(ticketStalled(ended, [member("m1", "failed")]), false);

  const running = ticket({ assignments: [assignment({ status: "running", memberId: "m1" })] });
  assert.equal(ticketStalled(running, []), false, "成员不在名册不臆断");
  assert.equal(
    ticketStalled(running, [member("other", "failed")]),
    false,
    "只认该派活的成员",
  );

  const orphan = ticket({ assignments: [assignment({ status: "running", memberId: null })] });
  assert.equal(ticketStalled(orphan, [member("m1", "failed")]), false);
});

test("停滞：非 running 派活不受成员态影响", () => {
  const t = ticket({ assignments: [assignment({ status: "pending", memberId: "m1" })] });
  assert.equal(ticketStalled(t, [member("m1", "failed")]), false);
});
