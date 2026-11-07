import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS_MIN_WIDTH,
  FORMATION_HEIGHT,
  FORMATION_BOTTOM,
  LEAD_BUS_Y,
  LEAD_IDLE_AFTER_MS,
  LEAD_TOP,
  MEMBER_FOOT,
  MEMBER_PITCH,
  MEMBER_SLOT_WIDTH,
  MEMBER_TOP,
  MEMBER_WORK_STATE_WEIGHT,
  PEER_BUS_Y,
  TASKS_TITLE_Y,
  formationNaturalWidth,
  getMemberWorkState,
  layoutFormation,
  sortWorkersByUrgency,
} from "./agent-teams-formation-layout.ts";

function member(id, overrides = {}) {
  return {
    id,
    name: id,
    role: "member",
    model: null,
    providerName: null,
    color: "blue",
    status: "idle",
    activity: "idle",
    sessionId: `${id}-session`,
    cwd: "",
    worktreePath: null,
    lastError: null,
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ticket(id, overrides = {}) {
  return {
    id,
    subject: `任务 ${id}`,
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

function snapshot(members, tickets = [], leadSessionId = "lead-session") {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    team: { id: "t", name: "demo", description: "", createdAt: "2026-01-01T00:00:00.000Z", leadSessionId, status: "running", incarnationId: "i" },
    members,
    tickets,
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
  };
}

test("几何常量与 cc-haha AgentTeamsCanvas:76-90 一致", () => {
  assert.equal(LEAD_TOP, 20);
  assert.equal(LEAD_BUS_Y, 196);
  assert.equal(MEMBER_TOP, 222);
  assert.equal(MEMBER_FOOT, 352);
  assert.equal(PEER_BUS_Y, 372);
  assert.equal(MEMBER_PITCH, 200);
  assert.equal(MEMBER_SLOT_WIDTH, 176);
  assert.equal(TASKS_TITLE_Y, 388);
  assert.equal(FORMATION_HEIGHT, 388);
  assert.equal(FORMATION_BOTTOM, 410, "编队带底边必须对齐任务泳道起点");
  assert.equal(CANVAS_MIN_WIDTH, 1280);
});

test("formationNaturalWidth：至少 1280，随成员数按 MEMBER_PITCH 撑开", () => {
  assert.equal(formationNaturalWidth(1), 1280);
  assert.equal(formationNaturalWidth(6), 1280, "564 < 1280，取最小值");
  assert.equal(formationNaturalWidth(7), 460 + 5 * MEMBER_PITCH);
  assert.ok(formationNaturalWidth(12) > formationNaturalWidth(6));
});

test("getMemberWorkState：只读名册，与票级 urgency 解耦", () => {
  assert.equal(getMemberWorkState(member("a", { status: "completed" })), "exited");
  assert.equal(getMemberWorkState(member("a", { status: "aborted" })), "stopped");
  assert.equal(getMemberWorkState(member("a", { status: "parked" })), "parked", "parked 是独立态，不并入 idle/stopped");
  assert.equal(getMemberWorkState(member("a", { status: "failed" })), "error");
  assert.equal(getMemberWorkState(member("a", { status: "running" })), "working");
  assert.equal(getMemberWorkState(member("a", { status: "idle" })), "idle");
  assert.equal(getMemberWorkState(member("a", { status: "queued" })), "idle");
  // lead：没有独立 turn 标记，由调用方的 leadIsStreaming 决定
  assert.equal(getMemberWorkState(member("lead", { status: "running" }), { isLead: true, leadIsStreaming: true }), "working");
  assert.equal(getMemberWorkState(member("lead", { status: "running" }), { isLead: true, leadIsStreaming: false }), "idle");
  assert.equal(getMemberWorkState(member("lead", { status: "failed" }), { isLead: true }), "error");
  // 权重表把 parked 与 idle/stopped 区分开
  assert.ok(MEMBER_WORK_STATE_WEIGHT.parked > MEMBER_WORK_STATE_WEIGHT.idle);
  assert.ok(MEMBER_WORK_STATE_WEIGHT.stopped > MEMBER_WORK_STATE_WEIGHT.parked);
});

test("layoutFormation：队长空闲（长时间无活动）显示 idle，而非永远 working", () => {
  const lead = member("lead", { name: "team-lead", status: "running", sessionId: "lead-session" });
  const withEvent = (at) => ({
    version: 1,
    generatedAt: "2026-01-01T00:20:00.000Z",
    team: { id: "t", name: "demo", description: "", createdAt: "2026-01-01T00:00:00.000Z", leadSessionId: "lead-session", status: "running", incarnationId: "i" },
    members: [lead],
    tickets: [],
    lanes: [{ memberId: "lead", name: "team-lead", role: "orchestrator", color: "gray", status: "running", events: [{ seq: 1, at, type: "report", detail: "" }] }],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
  });

  const fresh = layoutFormation(withEvent("2026-01-01T00:19:30.000Z"), 1280);
  assert.equal(fresh.lead.workState, "working", "30 秒内活动过 → working");

  const stale = layoutFormation(withEvent("2026-01-01T00:00:00.000Z"), 1280);
  assert.equal(stale.lead.workState, "idle", "20 分钟无活动 → idle");

  // 完全没有活动可依时不误判为空闲
  const quiet = layoutFormation(snapshot([lead]), 1280);
  assert.equal(quiet.lead.workState, "working");
  assert.equal(LEAD_IDLE_AFTER_MS, 10 * 60_000);
});

test("layoutFormation：队长居中、成员以 MEMBER_PITCH 居中排布", () => {
  const members = [
    member("lead", { name: "team-lead", color: "gray", status: "running", sessionId: "lead-session" }),
    member("w1"),
    member("w2"),
  ];
  const layout = layoutFormation(snapshot(members), 1280);
  assert.equal(layout.width, 1280);
  assert.equal(layout.height, FORMATION_HEIGHT);
  assert.ok(layout.lead);
  assert.equal(layout.lead.centerX, 640, "队长水平居中于画布");
  assert.equal(layout.lead.top, LEAD_TOP);
  assert.equal(layout.workers.length, 2);
  assert.equal(layout.workers[1].centerX - layout.workers[0].centerX, MEMBER_PITCH);
  assert.equal((layout.workers[0].centerX + layout.workers[1].centerX) / 2, 640, "成员行整体居中");
  assert.equal(layout.workers[0].top, MEMBER_TOP);
  assert.equal(layout.bus.leadX, 640);
  assert.equal(layout.bus.firstWorkerX, layout.workers[0].centerX);
  assert.equal(layout.bus.lastWorkerX, layout.workers[1].centerX);
});

test("layoutFormation：无成员时不崩，lead 为 null", () => {
  const layout = layoutFormation(snapshot([]), 1280);
  assert.equal(layout.lead, null);
  assert.deepEqual(layout.workers, []);
  assert.equal(layout.bus.leadX, null);
});

test("layoutFormation：分段进度条按紧急度分桶，完成率独立", () => {
  const members = [
    member("lead", { name: "team-lead", status: "running", sessionId: "lead-session" }),
    member("w1"),
  ];
  const tickets = [
    ticket("t1", { ownerId: "w1", status: "ended", assignments: [{ id: "a1", status: "ended", outcome: "completed", assignee: "w1", memberId: "w1", sessionId: null, startedAt: null, result: null }] }),
    ticket("t2", { ownerId: "w1", assignments: [{ id: "a2", status: "running", outcome: null, assignee: "w1", memberId: "w1", sessionId: null, startedAt: null, result: null }] }),
    ticket("t3", { ownerId: "w1", status: "ended", assignments: [{ id: "a3", status: "ended", outcome: "failed", assignee: "w1", memberId: "w1", sessionId: null, startedAt: null, result: null }] }),
    ticket("t4", { ownerId: "lead", assignments: [] }),
  ];
  const layout = layoutFormation(snapshot(members, tickets), 1280);
  const worker = layout.workers[0];
  assert.equal(worker.total, 3);
  assert.equal(worker.completed, 1, "只有非失败的 ended 计入完成");
  assert.equal(worker.percent, 33);
  assert.deepEqual(worker.segments, [
    { urgency: "failed", count: 1 },
    { urgency: "running", count: 1 },
    { urgency: "completed", count: 1 },
  ]);
  assert.equal(worker.urgency, "failed", "最紧急的段排最前");
  assert.equal(layout.lead.total, 1);
});

test("sortWorkersByUrgency：按最紧急度降序，同权重保持加入顺序", () => {
  const make = (id, urgency) => ({
    member: member(id),
    isLead: false,
    centerX: 0,
    top: MEMBER_TOP,
    accent: "blue",
    workState: "idle",
    total: 1,
    completed: 0,
    percent: 0,
    segments: urgency ? [{ urgency, count: 1 }] : [],
    urgency,
  });
  const sorted = sortWorkersByUrgency([
    make("idle", null),
    make("failed", "failed"),
    make("blocked", "blocked"),
    make("blocked2", "blocked"),
  ]);
  assert.deepEqual(sorted.map((w) => w.member.id), ["failed", "blocked", "blocked2", "idle"]);
});
