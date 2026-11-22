import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS_MIN_WIDTH,
  FORMATION_HEIGHT,
  FORMATION_BOTTOM,
  LEAD_BUS_Y,
  LEAD_IDLE_AFTER_MS,
  LEAD_TOP,
  MAX_MEMBERS_PER_ROW,
  MEMBER_FOOT,
  MEMBER_PITCH,
  MEMBER_ROW_GAP,
  MEMBER_ROW_PITCH,
  MEMBER_SLOT_WIDTH,
  MEMBER_TOP,
  MEMBER_WORK_STATE_WEIGHT,
  PEER_BUS_Y,
  TASKS_TITLE_Y,
  arrangeFormationRows,
  formationBandBottom,
  formationBandHeight,
  formationNaturalWidth,
  formationRowCount,
  getMemberWorkState,
  identityAliases,
  identityMatches,
  layoutFormation,
  membersPerRow,
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

test("formationNaturalWidth：至少 1280，随成员数按 MEMBER_PITCH 撑开，但单行饱和", () => {
  assert.equal(formationNaturalWidth(1), 1280);
  assert.equal(formationNaturalWidth(6), 1280, "564 < 1280，取最小值");
  assert.equal(formationNaturalWidth(7), 460 + 5 * MEMBER_PITCH);
  assert.ok(formationNaturalWidth(12) > formationNaturalWidth(6));
  // 单行上限 MAX_MEMBERS_PER_ROW：再多的人也分成新行，画布不再横向膨胀
  // （旧实现 60 人 = 58 * 200 + 176 ≈ 11.8k px）。
  assert.equal(formationNaturalWidth(9), 460 + 7 * MEMBER_PITCH, "8 个成员 = 单行上限");
  assert.equal(formationNaturalWidth(60), formationNaturalWidth(9), "超过上限后宽度饱和");
  assert.ok(formationNaturalWidth(60) < 2000, "60 个成员也不再撑出 11.8k px 的画布");
});

test("分行几何常量：行距容得下 peer 总线与下一行行总线，互不重叠", () => {
  assert.equal(MEMBER_ROW_GAP, 56);
  assert.equal(MEMBER_ROW_PITCH, MEMBER_FOOT - MEMBER_TOP + MEMBER_ROW_GAP);
  assert.equal(MAX_MEMBERS_PER_ROW, 8);
  // peer 总线（脚下方 20）必须落在下一行行总线（顶边上方 26）之上。
  assert.ok(PEER_BUS_Y + MEMBER_ROW_GAP - MEMBER_ROW_PITCH + MEMBER_ROW_PITCH > 0);
  assert.ok(MEMBER_ROW_PITCH > MEMBER_FOOT - MEMBER_TOP, "行距大于卡高，行间留出总线空间");
  // 首行行总线仍然正好是 LEAD_BUS_Y（既有几何不被打破）。
  assert.equal(MEMBER_TOP - (MEMBER_TOP - LEAD_BUS_Y), LEAD_BUS_Y);
});

test("membersPerRow：按可用宽度算，被单行上限钉住，窄画布至少 1 张", () => {
  assert.equal(membersPerRow(1280), 6, "(1280-176)/200 + 1 = 6");
  assert.equal(membersPerRow(900), 4);
  assert.equal(membersPerRow(2000), MAX_MEMBERS_PER_ROW, "再宽也不超过单行上限");
  assert.equal(membersPerRow(300), 1, "极窄画布也至少一行一张，不出现 0 张/行");
  assert.equal(membersPerRow(0), membersPerRow(CANVAS_MIN_WIDTH), "非法宽度回落画布最小宽");
  assert.equal(membersPerRow(Number.NaN), membersPerRow(CANVAS_MIN_WIDTH));
});

test("formationRowCount / formationBandHeight / formationBandBottom：单一成员的带几何不变", () => {
  assert.equal(formationRowCount(0, 1280), 0);
  assert.equal(formationRowCount(1, 1280), 1);
  assert.equal(formationRowCount(7, 1280), 2, "6 张/行 → 7 人两行");
  assert.equal(formationRowCount(19, 1280), 4);
  assert.equal(formationBandHeight(0), FORMATION_HEIGHT, "无成员时保持既有带高");
  assert.equal(formationBandHeight(1), FORMATION_HEIGHT);
  assert.equal(formationBandHeight(2), FORMATION_HEIGHT + MEMBER_ROW_PITCH);
  assert.equal(formationBandBottom(1), FORMATION_BOTTOM, "单行时任务泳道起点不动");
  assert.equal(formationBandBottom(3), FORMATION_BOTTOM + 2 * MEMBER_ROW_PITCH);
  assert.ok(formationBandBottom(3) > formationBandBottom(1), "多行时带底边下移");
});

test("layoutFormation：成员多时分行（不再一排 60 张卡撑出 11.8k 的画布）", () => {
  const lead = member("lead", { name: "team-lead", status: "running", sessionId: "lead-session" });
  const workers = Array.from({ length: 59 }, (_, index) => member(`w${index}`));
  const layout = layoutFormation(snapshot([lead, ...workers]), 1280);
  assert.equal(layout.workers.length, 59);
  assert.equal(layout.rowCount, 10, "6 张/行 → 59 人十行");
  assert.equal(layout.rows.length, 10);
  assert.equal(layout.rows[0].members.length, 6);
  assert.equal(layout.rows[9].members.length, 59 - 9 * 6);
  // 行内仍是 MEMBER_PITCH、仍居中；行间按 MEMBER_ROW_PITCH 递减排布。
  assert.equal(layout.rows[0].members[1].centerX - layout.rows[0].members[0].centerX, MEMBER_PITCH);
  assert.equal(layout.rows[1].members[0].top, MEMBER_TOP + MEMBER_ROW_PITCH);
  assert.equal(layout.rows[1].members[0].top - layout.rows[0].members[0].top, MEMBER_ROW_PITCH);
  // 所有卡片都在画布内（旧实现首卡会是负坐标、尾卡在画布外）。
  for (const node of layout.workers) {
    assert.ok(node.centerX - MEMBER_SLOT_WIDTH / 2 >= 0, `${node.member.name} 左缘不越界`);
    assert.ok(node.centerX + MEMBER_SLOT_WIDTH / 2 <= layout.width, `${node.member.name} 右缘不越界`);
  }
  // 带高与带底边随行数增长（任务泳道据此下移）。
  assert.equal(layout.height, formationBandHeight(10));
  assert.equal(layout.bottom, formationBandBottom(10));
  assert.ok(layout.height > FORMATION_HEIGHT);
  // 行总线几何：首行仍是 LEAD_BUS_Y，peer 总线在卡片脚下方。
  assert.equal(layout.rows[0].busY, LEAD_BUS_Y);
  assert.equal(layout.rows[0].peerBusY, PEER_BUS_Y);
  assert.equal(layout.rows[1].busY, LEAD_BUS_Y + MEMBER_ROW_PITCH);
});

test("arrangeFormationRows：重排复用同一套换行几何（不就地修改入参）", () => {
  const nodes = Array.from({ length: 9 }, (_, index) => ({
    member: member(`w${index}`),
    isLead: false,
    centerX: 0,
    top: MEMBER_TOP,
    accent: "blue",
    workState: "idle",
    total: 0,
    completed: 0,
    percent: 0,
    segments: [],
    urgency: null,
    currentTicketId: null,
    blockedDependencyId: null,
    inboxCount: 0,
  }));
  const rows = arrangeFormationRows(nodes, 1280);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].members.length, 6);
  assert.equal(rows[1].members.length, 3);
  assert.equal(rows[1].members[1].centerX, 1280 / 2, "短行也整体居中");
  assert.equal(nodes[0].centerX, 0, "入参不被就地改写（纯函数）");
  assert.equal(nodes[0].top, MEMBER_TOP);
  assert.deepEqual(arrangeFormationRows([], 1280), []);
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

test("identityAliases / identityMatches：认全名与 name@team 短名", () => {
  assert.deepEqual(identityAliases("Alice@Demo"), ["alice@demo", "alice"]);
  assert.deepEqual(identityAliases("  "), []);
  assert.equal(identityMatches("w1", "alice", "alice@demo"), true);
  assert.equal(identityMatches("w1", "alice", "w1"), true);
  assert.equal(identityMatches("w1", "alice", "bob"), false);
  assert.equal(identityMatches("w1", "alice", "*"), false);
});

test("当前票 / 阻塞依赖 / 收件数：layoutFormation 填充成员卡字段", () => {
  const members = [
    member("lead", { name: "team-lead", status: "running", sessionId: "lead-session" }),
    member("w1"),
  ];
  const running = (memberId, at) => ({
    id: `a-${memberId}-${at}`,
    status: "running",
    outcome: null,
    assignee: memberId,
    memberId,
    sessionId: null,
    startedAt: null,
    lastActivityAt: at,
    result: null,
  });
  const tickets = [
    ticket("dep", { status: "open" }),
    // 两张 running 票：lastActivityAt 更新者胜出
    ticket("t-old", { ownerId: "w1", dependencies: ["dep"], assignments: [running("w1", "2026-01-01T00:01:00.000Z")] }),
    ticket("t-new", { ownerId: "w1", dependencies: ["dep"], assignments: [running("w1", "2026-01-01T00:05:00.000Z")] }),
  ];
  const snap = snapshot(members, tickets);
  snap.messages = [
    { id: "m1", from: "team-lead", to: "w1", recipients: ["w1"], kind: "direct", text: "", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "m2", from: "team-lead", to: "w1", recipients: ["w1"], kind: "direct", text: "", timestamp: "2026-01-01T00:01:00.000Z" },
    { id: "m3", from: "w1", to: "team-lead", recipients: ["team-lead"], kind: "direct", text: "", timestamp: "2026-01-01T00:02:00.000Z" },
  ];
  const layout = layoutFormation(snap, 1280);
  const worker = layout.workers[0];
  assert.equal(worker.currentTicketId, "t-new", "lastActivityAt 最新的 running 票");
  assert.equal(worker.blockedDependencyId, "dep", "当前票首个未 ended 依赖");
  assert.equal(worker.inboxCount, 2, "自己发出的不计入收件");
  assert.equal(layout.lead.currentTicketId, null);
  assert.equal(layout.lead.inboxCount, 1, "lead 收到 w1 的汇报");
});

test("当前票无未满足依赖时 blockedDependencyId 为 null", () => {
  const members = [member("lead", { name: "team-lead", status: "running", sessionId: "lead-session" }), member("w1")];
  const tickets = [
    ticket("dep", { status: "ended" }),
    ticket("t-run", {
      ownerId: "w1",
      dependencies: ["dep", "ghost"],
      assignments: [{
        id: "a1", status: "running", outcome: null, assignee: "w1", memberId: "w1",
        sessionId: null, startedAt: null, lastActivityAt: "2026-01-01T00:05:00.000Z", result: null,
      }],
    }),
  ];
  const layout = layoutFormation(snapshot(members, tickets), 1280);
  assert.equal(layout.workers[0].currentTicketId, "t-run");
  assert.equal(layout.workers[0].blockedDependencyId, null, "已 ended 与缺失依赖都跳过");
  assert.equal(layout.workers[0].inboxCount, 0);
});
