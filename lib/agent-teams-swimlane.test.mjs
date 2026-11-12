import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  projectTeamWorkbench,
  layoutSwimlanes,
  LANE_HEIGHT,
  LANE_GAP,
  EVENT_SPACING,
  EVENT_WIDTH,
  LANE_LABEL_WIDTH,
} = await jiti.import("./agent-teams-swimlane.ts");

const {
  readTeamWorkbench,
  findTeamBySession,
  listTeams,
  sanitizeTeamName,
  teamsRootDir,
} = await jiti.import("./agent-teams-swimlane-store.ts");

// ── 纯投影 fixture ────────────────────────────────────────────────────────────

const JOINED = Date.parse("2026-11-05T00:00:00.000Z");

function fixture() {
  return {
    teamName: "demo",
    generatedAt: "2026-11-05T03:00:00.000Z",
    team: {
      name: "demo",
      description: "泳道图示例",
      createdAt: JOINED,
      leadAgentId: "team-lead",
      leadSessionId: "lead-session",
      members: [
        { agentId: "lead-1", name: "team-lead", agentType: "orchestrator", joinedAt: JOINED, cwd: "D:/proj" },
        { agentId: "m-impl", name: "impl", agentType: "general-purpose", joinedAt: JOINED, cwd: "D:/proj" },
        { agentId: "m-qa", name: "qa", agentType: "general-purpose", joinedAt: JOINED, cwd: "D:/proj" },
      ],
    },
    plan: {
      incarnationId: "inc-1",
      state: "running",
      createdAt: Date.parse("2026-11-05T00:30:00.000Z"),
      members: [
        { id: "p-impl", name: "impl", runtime: { providerId: "ty", modelId: "claude-sonnet-4-6" } },
        { id: "p-qa", name: "qa", runtime: { providerId: "ty", modelId: "claude-sonnet-4-6" } },
      ],
      tasks: [
        { id: "t1", subject: "实现 X", ownerId: "p-impl", dependencies: [] },
        { id: "t2", subject: "验证 X", ownerId: "p-qa", dependencies: ["t1"] },
      ],
    },
    lifecycle: {
      impl: { name: "impl", status: "running", sessionId: "s-impl", updatedAt: Date.parse("2026-11-05T01:30:00.000Z") },
      qa: { name: "qa", status: "idle", sessionId: "s-qa", updatedAt: Date.parse("2026-11-05T01:30:00.000Z") },
    },
    messages: [
      { from: "team-lead", to: "impl", text: "开始实现", summary: "开始实现", timestamp: "2026-11-05T01:00:00.000Z" },
      { from: "impl", to: "team-lead", text: "做完了", summary: "完成", timestamp: "2026-11-05T02:00:00.000Z" },
    ],
    accepted: [{ member: "impl", summary: "通过", at: "2026-11-05T02:30:00.000Z" }],
  };
}

test("members: 名册顺序、lead 恒 running、颜色与计划运行时", () => {
  const snapshot = projectTeamWorkbench(fixture());
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.members.map((m) => m.name), ["team-lead", "impl", "qa"]);
  assert.equal(snapshot.members[0].status, "running");
  assert.equal(snapshot.members[1].status, "running");
  assert.equal(snapshot.members[2].status, "idle");
  assert.equal(snapshot.members[1].model, "claude-sonnet-4-6");
  assert.deepEqual(snapshot.members.map((m) => m.color), ["gray", "blue", "green"]);
  assert.equal(snapshot.team.incarnationId, "inc-1");
  assert.equal(snapshot.team.leadSessionId, "lead-session");
});

test("members：parked 保持独立态，不再并入 idle", () => {
  const snapshot = projectTeamWorkbench({
    ...fixture(),
    lifecycle: {
      impl: { name: "impl", status: "parked", sessionId: "s-impl", updatedAt: JOINED },
      qa: { name: "qa", status: "idle", sessionId: "s-qa", updatedAt: JOINED },
    },
  });
  const impl = snapshot.members.find((m) => m.name === "impl");
  const qa = snapshot.members.find((m) => m.name === "qa");
  assert.equal(impl.status, "parked", "被挂起/停止的成员必须显示为 parked，而不是 idle");
  assert.equal(qa.status, "idle");
  assert.notEqual(impl.status, qa.status, "parked 与 idle 必须可区分");
  assert.equal(impl.activity, "idle", "parked 不是活跃态");
});

test("members：plan 独有成员（team_plan launch 未写 config）出现在名册并可被票认领", () => {
  const base = fixture();
  const snapshot = projectTeamWorkbench({
    ...base,
    plan: {
      ...base.plan,
      members: [
        { id: "p-impl", name: "impl", runtime: { providerId: "ty", modelId: "claude-sonnet-4-6" } },
        // plan 独有：config.json 里没有 carol
        { id: "p-carol", name: "carol", agentType: "general-purpose", runtime: { providerId: "ty", modelId: "claude-opus-4-1" } },
      ],
      tasks: [...base.plan.tasks, { id: "t3", subject: "carol 的活", ownerId: "p-carol", dependencies: [] }],
    },
    lifecycle: {
      ...base.lifecycle,
      carol: { name: "carol", status: "running", sessionId: "s-carol", updatedAt: JOINED },
    },
  });

  assert.deepEqual(
    snapshot.members.map((m) => m.name),
    ["team-lead", "impl", "qa", "carol"],
    "plan 独有成员追加在 config 名册之后",
  );
  const carol = snapshot.members.find((m) => m.name === "carol");
  assert.equal(carol.id, "p-carol", "plan 独有成员用 plan 成员 id 作 memberId");
  assert.equal(carol.model, "claude-opus-4-1");
  assert.equal(carol.providerName, "ty");
  assert.equal(carol.sessionId, "s-carol", "sessionId 从 lifecycle 取");
  assert.equal(carol.status, "running");
  assert.ok(snapshot.lanes.some((lane) => lane.name === "carol"), "泳道里也应出现 carol");

  const t3 = snapshot.tickets.find((ticket) => ticket.id === "t3");
  assert.equal(t3.ownerId, "p-carol", "plan 独有成员的票认领到其 memberId");
  assert.equal(t3.assignments[0].assignee, "carol");
  assert.equal(t3.assignments[0].status, "running");
});

test("members：同名成员 config 为准，plan 仅补 model/provider 缺口", () => {
  const base = fixture();
  const snapshot = projectTeamWorkbench({
    ...base,
    plan: {
      ...base.plan,
      members: [{ id: "p-impl", name: "impl", runtime: { providerId: "ty", modelId: "claude-opus-4-1" } }],
    },
  });
  const impls = snapshot.members.filter((m) => m.name === "impl");
  assert.equal(impls.length, 1, "同名成员不得重复");
  assert.equal(impls[0].id, "m-impl", "身份仍取 config 的 agentId（config 为准）");
  assert.equal(impls[0].model, "claude-opus-4-1", "model 缺口由 plan 补");
  assert.equal(impls[0].providerName, "ty", "provider 缺口由 plan 的 providerId 近似补");
});

test("members：plan 独有成员 id 与 config agentId 冲突时追加确定性后缀", () => {
  const base = fixture();
  const snapshot = projectTeamWorkbench({
    ...base,
    plan: { ...base.plan, members: [{ id: "m-impl", name: "carol" }] },
  });
  const carol = snapshot.members.find((m) => m.name === "carol");
  assert.equal(carol.id, "m-impl#2", "冲突的合成 id 追加后缀");
  assert.equal(snapshot.members.find((m) => m.name === "impl").id, "m-impl", "原成员 id 不受影响");
});

test("members：没有 plan.json 时名册不引入合成成员、字段与改动前一致", () => {
  const snapshot = projectTeamWorkbench({ ...fixture(), plan: null });
  assert.deepEqual(snapshot.members.map((m) => m.name), ["team-lead", "impl", "qa"]);
  const impl = snapshot.members.find((m) => m.name === "impl");
  assert.equal(impl.id, "m-impl");
  assert.equal(impl.model, null);
  assert.equal(impl.providerName, null);
});

test("tickets/taskAnchors：owner 经计划 id 映射到成员 agentId，验收后 ended", () => {
  const snapshot = projectTeamWorkbench(fixture());
  const [t1, t2] = snapshot.tickets;
  assert.equal(t1.id, "t1");
  assert.equal(t1.ownerId, "m-impl");
  assert.equal(t1.status, "ended");
  assert.equal(t1.assignments[0].status, "ended");
  assert.equal(t1.assignments[0].sessionId, "s-impl");
  assert.equal(t2.ownerId, "m-qa");
  assert.equal(t2.status, "open");
  assert.deepEqual(t2.dependencies, ["t1"]);
  const anchor1 = snapshot.taskAnchors.find((a) => a.ticketId === "t1");
  const anchor2 = snapshot.taskAnchors.find((a) => a.ticketId === "t2");
  assert.deepEqual({ memberId: anchor1.memberId, status: anchor1.status }, { memberId: "m-impl", status: "completed" });
  assert.deepEqual({ memberId: anchor2.memberId, status: anchor2.status }, { memberId: "m-qa", status: "pending" });
});

test("D4-2 返工：同 owner 两票、runtime 只认领其一 ⇒ 未被认领的票不得由验收信号标 ended", () => {
  // verifier-b 探针场景（判别测试，旧实现 `&& !runtimeTaskIds.has(task.id)` 下必红）：
  // impl 已被验收（fixture 的 accepted 一条 member=impl），plan 给 impl 两张票 t1/t3，
  // runtime 票只认领 t1。成员粒度 accept 不得越权——t3 必须保持 open。
  const base = fixture();
  const snapshot = projectTeamWorkbench({
    ...base,
    plan: {
      ...base.plan,
      tasks: [
        ...base.plan.tasks,
        { id: "t3", subject: "impl 的另一张票", ownerId: "p-impl", dependencies: [] },
      ],
    },
    runtimeTickets: [
      {
        schemaVersion: 1, id: "t1", teamName: "demo", subject: "实现 X", status: "open",
        createdBy: "team-lead", createdAt: JOINED, updatedAt: JOINED,
        assignments: [{ id: "as-8", assignee: "impl", status: "running", createdAt: JOINED, updatedAt: JOINED }],
        subscribers: [], thread: [],
      },
    ],
  });
  const t3 = snapshot.tickets.find((t) => t.id === "t3");
  assert.equal(t3.status, "open", "owner 有 runtime 证据 ⇒ accepted 不标 ended（旧实现此处为 ended，判别）");
  assert.equal(t3.source, "plan");
  // t1 本身仍由 runtime 的真实状态说话（merge 覆盖）。
  const t1 = snapshot.tickets.find((t) => t.id === "t1");
  assert.equal(t1.status, "open");
  assert.equal(t1.assignments[0].status, "running");
});

test("D4-2 回落：全 plan-only 团队（无任何 runtime 证据）accept 仍按成员粒度标 ended", () => {
  // 没有任何 runtime 票 ⇒ 成员级近似是唯一信号，保持改动前行为（否则全 plan-only
  // 团队会显示 0% 完成，比近似更糟）。
  const snapshot = projectTeamWorkbench(fixture());
  const t1 = snapshot.tickets.find((t) => t.id === "t1");
  assert.equal(t1.status, "ended", "无 runtime 证据时 accepted 仍标 ended");
  assert.equal(t1.assignments[0].status, "ended");
  // qa 无验收记录 ⇒ 票照旧 open。
  const t2 = snapshot.tickets.find((t) => t.id === "t2");
  assert.equal(t2.status, "open");
});

test("tickets：运行时独有票追加在后，同 id 时 runtime 的 assignments/status 覆盖派生", () => {
  const base = fixture();
  const snapshot = projectTeamWorkbench({
    ...base,
    runtimeTickets: [
      // 与 plan 的 t2 同 id：runtime 的 ended + qa 派活覆盖派生值
      {
        schemaVersion: 1, id: "t2", teamName: "demo", subject: "验证 X（改）", status: "ended",
        createdBy: "team-lead", createdAt: JOINED, updatedAt: JOINED,
        assignments: [{ id: "as-9", assignee: "qa", status: "ended", createdAt: JOINED, updatedAt: JOINED, result: "过了", outcome: "completed" }],
        subscribers: [], thread: [],
      },
      // 独有票：追加在 plan 票之后
      {
        schemaVersion: 1, id: "ticket-x", teamName: "demo", subject: "真实工单", status: "open",
        createdBy: "team-lead", createdAt: Date.parse("2026-11-05T02:10:00.000Z"), updatedAt: JOINED,
        assignments: [{ id: "as-1", assignee: "impl", status: "running", createdAt: Date.parse("2026-11-05T02:11:00.000Z"), updatedAt: JOINED }],
        subscribers: ["impl"], thread: [],
      },
    ],
  });
  assert.deepEqual(snapshot.tickets.map((t) => t.id), ["t1", "t2", "ticket-x"], "plan 票在前，独有票追加");
  const t2 = snapshot.tickets.find((t) => t.id === "t2");
  assert.equal(t2.status, "ended", "同 id：runtime status 覆盖");
  assert.equal(t2.source, "merged");
  assert.deepEqual({ id: t2.assignments[0].id, status: t2.assignments[0].status, memberId: t2.assignments[0].memberId, assignee: t2.assignments[0].assignee },
    { id: "as-9", status: "ended", memberId: "m-qa", assignee: "qa" }, "同 id：runtime assignments 覆盖，成员名映射到 agentId");
  const x = snapshot.tickets.find((t) => t.id === "ticket-x");
  assert.equal(x.source, "runtime");
  assert.equal(x.ownerId, "m-impl", "独有票的 owner 取首个可映射的 assignee");
  assert.equal(snapshot.tasks.at(-1).subject, "真实工单");
  assert.equal(snapshot.tasks.at(-1).owner, "impl");
  assert.equal(snapshot.tasks.at(-1).status, "in_progress", "running assignment → in_progress");
  const anchorX = snapshot.taskAnchors.find((a) => a.ticketId === "ticket-x");
  assert.deepEqual({ memberId: anchorX.memberId, status: anchorX.status }, { memberId: "m-impl", status: "in_progress" });
});

test("assignments：lastActivityAt 语义单一（plan=lifecycle.updatedAt，runtime=assignment.updatedAt），startedAt 取值不变", () => {
  const snapshot = projectTeamWorkbench({
    ...fixture(),
    runtimeTickets: [
      {
        schemaVersion: 1, id: "ticket-x", teamName: "demo", subject: "真实工单", status: "open",
        createdBy: "team-lead", createdAt: Date.parse("2026-11-05T02:10:00.000Z"), updatedAt: Date.parse("2026-11-05T02:30:00.000Z"),
        assignments: [{ id: "as-1", assignee: "impl", status: "running", createdAt: Date.parse("2026-11-05T02:11:00.000Z"), updatedAt: Date.parse("2026-11-05T02:20:00.000Z") }],
        subscribers: [], thread: [],
      },
    ],
  });

  // plan 票：startedAt 与新增的 lastActivityAt 都来自 lifecycle.updatedAt（职责不同、此刻同源）。
  const planAssignment = snapshot.tickets.find((t) => t.id === "t1").assignments[0];
  assert.equal(planAssignment.startedAt, "2026-11-05T01:30:00.000Z", "plan startedAt 取值不变（仍是 lifecycle.updatedAt）");
  assert.equal(planAssignment.lastActivityAt, "2026-11-05T01:30:00.000Z", "plan lastActivityAt = lifecycle.updatedAt");

  // runtime 票：startedAt=createdAt（开始，取值不变），lastActivityAt=updatedAt（最后活动，新语义）。
  const runtimeAssignment = snapshot.tickets.find((t) => t.id === "ticket-x").assignments[0];
  assert.equal(runtimeAssignment.startedAt, "2026-11-05T02:11:00.000Z", "runtime startedAt 取值不变（仍是 assignment.createdAt）");
  assert.equal(runtimeAssignment.lastActivityAt, "2026-11-05T02:20:00.000Z", "runtime lastActivityAt = assignment.updatedAt");
  assert.notEqual(runtimeAssignment.lastActivityAt, runtimeAssignment.startedAt, "两种语义在 runtime 票上确实不同");
});

test("assignments：缺少时间戳来源时 lastActivityAt 与 startedAt 同为 null", () => {
  // 无 lifecycle 条目（owner 未登记）→ plan 派活没有 updatedAt 来源。
  const snapshot = projectTeamWorkbench({ ...fixture(), lifecycle: {} });
  const assignment = snapshot.tickets.find((t) => t.id === "t1").assignments[0];
  assert.equal(assignment.startedAt, null);
  assert.equal(assignment.lastActivityAt, null);
});

test("assignments：runtime 派活缺 updatedAt 时 lastActivityAt 为 null，startedAt 仍有值", () => {
  const snapshot = projectTeamWorkbench({
    ...fixture(),
    runtimeTickets: [
      {
        schemaVersion: 1, id: "ticket-y", teamName: "demo", subject: "老数据", status: "open",
        createdBy: "team-lead", createdAt: JOINED, updatedAt: JOINED,
        // 故意省略 updatedAt，模拟旧落盘数据
        assignments: [{ id: "as-2", assignee: "impl", status: "running", createdAt: Date.parse("2026-11-05T02:11:00.000Z") }],
        subscribers: [], thread: [],
      },
    ],
  });
  const assignment = snapshot.tickets.find((t) => t.id === "ticket-y").assignments[0];
  assert.equal(assignment.startedAt, "2026-11-05T02:11:00.000Z");
  assert.equal(assignment.lastActivityAt, null, "缺 updatedAt → null，不借用 createdAt");
});

test("无 runtimeTickets 输入：投影与改动前等价（tasks 全部来自 plan）", () => {
  const withField = projectTeamWorkbench({ ...fixture(), runtimeTickets: [], receipts: [] });
  const without = projectTeamWorkbench(fixture());
  assert.deepEqual(withField.tickets, without.tickets);
  assert.deepEqual(withField.taskAnchors, without.taskAnchors);
  assert.deepEqual(withField.tasks, without.tasks);
  assert.deepEqual(withField.lanes, without.lanes);
  assert.deepEqual(withField.receipts, []);
});

test("receipts：acks 回执输出，reader 名映射 agentId，损坏条目忽略", () => {
  const snapshot = projectTeamWorkbench({
    ...fixture(),
    receipts: [
      { messageId: "m-1", reader: "impl", ackedAt: Date.parse("2026-11-05T02:40:00.000Z") },
      { messageId: "m-2", reader: "ghost", ackedAt: Date.parse("2026-11-05T02:41:00.000Z") },
      { messageId: "bad" },
    ],
  });
  assert.equal(snapshot.receipts.length, 2, "缺 reader/ackedAt 的行被忽略");
  assert.deepEqual(snapshot.receipts[0], { messageId: "m-1", reader: "impl", readerId: "m-impl", ackedAt: "2026-11-05T02:40:00.000Z" });
  assert.equal(snapshot.receipts[1].readerId, null, "名册外的 reader 映射为 null");
});

test("flows：消息 from→to 与验收报告都保留", () => {
  const snapshot = projectTeamWorkbench(fixture());
  const message = snapshot.flows.filter((f) => f.kind === "message");
  assert.equal(message.length, 2);
  assert.deepEqual(message.map((f) => `${f.from}->${f.to}`), ["team-lead->impl", "impl->team-lead"]);
  const report = snapshot.flows.find((f) => f.kind === "report");
  assert.equal(report.from, "impl");
  assert.equal(report.to, "team-lead");
  assert.equal(report.text, "通过");
  assert.equal(message[0].ticketId, "t1", "发给 t1 owner 的消息挂上 ticketId");
});

test("lanes：每成员一条，事件归发起方且按时间排序", () => {
  const snapshot = projectTeamWorkbench(fixture());
  assert.deepEqual(snapshot.lanes.map((l) => l.name), ["team-lead", "impl", "qa"]);

  const impl = snapshot.lanes.find((l) => l.name === "impl");
  assert.deepEqual(impl.events.map((e) => e.type), ["spawn", "task", "message", "report"]);
  assert.equal(impl.events.find((e) => e.type === "task").taskId, "t1");
  assert.equal(impl.events[0].seq, 1);
  // seq 连续，便于渲染按序连线
  snapshot.lanes.forEach((lane) => {
    lane.events.forEach((event, index) => assert.equal(event.seq, index + 1));
  });

  const lead = snapshot.lanes.find((l) => l.name === "team-lead");
  assert.deepEqual(lead.events.map((e) => e.type), ["spawn", "message"]);
  assert.equal(lead.events[1].to, "impl");

  const qa = snapshot.lanes.find((l) => l.name === "qa");
  assert.deepEqual(qa.events.map((e) => e.type), ["spawn", "task"]);
});

test("tasks：lane-diagram.html 兼容形态（owner 名、blockedBy、status）", () => {
  const snapshot = projectTeamWorkbench(fixture());
  assert.deepEqual(snapshot.tasks, [
    { id: "t1", subject: "实现 X", owner: "impl", status: "completed", blockedBy: [] },
    { id: "t2", subject: "验证 X", owner: "qa", status: "pending", blockedBy: ["t1"] },
  ]);
});

test("layout：lane 按行堆叠、事件按列向右排、流向锚在正确泳道", () => {
  const snapshot = projectTeamWorkbench(fixture());
  const layout = layoutSwimlanes(snapshot);
  assert.equal(layout.lanes.length, 3);
  assert.equal(layout.lanes[0].y, 0);
  assert.equal(layout.lanes[1].y, LANE_HEIGHT + LANE_GAP);
  assert.equal(layout.lanes[2].y, 2 * (LANE_HEIGHT + LANE_GAP));
  assert.equal(layout.lanes[0].x, 0);
  assert.equal(layout.lanes[0].height, LANE_HEIGHT);

  const impl = layout.lanes.find((l) => l.name === "impl");
  impl.events.forEach((event, index) => {
    assert.equal(event.x, LANE_LABEL_WIDTH + 24 + index * EVENT_SPACING);
    assert.equal(event.width, EVENT_WIDTH);
    if (index > 0) assert.ok(event.x > impl.events[index - 1].x, "x 随时间递增");
  });

  const flow = layout.flows.find((f) => f.from === "team-lead" && f.to === "impl");
  const leadLane = layout.lanes.find((l) => l.name === "team-lead");
  const implLane = layout.lanes.find((l) => l.name === "impl");
  assert.equal(flow.fromY, leadLane.y + LANE_HEIGHT / 2);
  assert.equal(flow.toY, implLane.y + LANE_HEIGHT / 2);
  assert.ok(flow.fromX > 0 && flow.toX > flow.fromX);
  assert.ok(layout.width > LANE_LABEL_WIDTH && layout.height >= LANE_HEIGHT);
});

test("空团队：无任务时 phase=forming，lane 仍成行", () => {
  const base = fixture();
  const snapshot = projectTeamWorkbench({
    teamName: "empty",
    team: base.team,
    plan: { members: [], tasks: [] },
    lifecycle: {},
    generatedAt: "2026-11-05T03:00:00.000Z",
  });
  assert.equal(snapshot.team.status, "forming");
  assert.deepEqual(snapshot.tickets, []);
  assert.equal(snapshot.lanes.length, 3);
  // 每个成员至少一个 spawn 事件，lane 不会塌成空行
  snapshot.lanes.forEach((lane) => assert.equal(lane.events[0].type, "spawn"));
});

test("无票团队：成员仍在跑 → running（不再恒 forming，团队条才会停止轮询）", () => {
  const base = fixture();
  const snapshot = projectTeamWorkbench({
    teamName: "no-tickets",
    team: base.team,
    plan: null,
    lifecycle: {
      impl: { name: "impl", status: "running", sessionId: "s-impl", updatedAt: 1 },
      qa: { name: "qa", status: "parked", sessionId: "s-qa", updatedAt: 1 },
    },
    generatedAt: "2026-11-05T03:00:00.000Z",
  });
  assert.deepEqual(snapshot.tickets, []);
  assert.equal(snapshot.team.status, "running");
});

test("无票团队：全员停且已验收 → completed；未验收 → ended", () => {
  // 真实形态（2026-11-12 snake-game-team）：team_create 直接派活、从没用过 team_plan /
  // team_ticket，tickets 恒 0，成员全部 parked。原先恒判 forming，团队条永远「组建中」、
  // 每 3 秒轮询不止，已交付也停不下来。
  const settled = {
    impl: { name: "impl", status: "parked", sessionId: "s-impl", updatedAt: 1 },
    qa: { name: "parked", status: "parked", sessionId: "s-qa", updatedAt: 1 },
  };
  const base = fixture();
  const acceptedSnapshot = projectTeamWorkbench({
    teamName: "no-tickets-done",
    team: base.team,
    plan: null,
    lifecycle: settled,
    accepted: [{ member: "impl", summary: "通过", at: "2026-11-05T02:30:00.000Z" }],
    generatedAt: "2026-11-05T03:00:00.000Z",
  });
  assert.equal(acceptedSnapshot.team.status, "completed");

  const endedSnapshot = projectTeamWorkbench({
    teamName: "no-tickets-ended",
    team: base.team,
    plan: null,
    lifecycle: settled,
    generatedAt: "2026-11-05T03:00:00.000Z",
  });
  assert.equal(endedSnapshot.team.status, "ended");
});

test("无票团队：名册有成员但一个都没被派发 → 仍是 forming（不能把刚建的团队判成 ended）", () => {
  const base = fixture();
  const snapshot = projectTeamWorkbench({
    teamName: "not-yet-spawned",
    team: base.team,
    plan: null,
    lifecycle: {},
    generatedAt: "2026-11-05T03:00:00.000Z",
  });
  assert.equal(snapshot.team.status, "forming");
});

// ── 磁盘读取（服务端）────────────────────────────────────────────────────────

test("sanitizeTeamName 与 pi-team 一致", () => {
  assert.equal(sanitizeTeamName("Pi-Desktop/Upgrade"), "pi-desktop-upgrade");
});

test("readTeamWorkbench：读 config/plan/lifecycle/邮箱/验收，邮箱消息带 to 且去重", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    assert.equal(teamsRootDir(), root);
    const dir = join(root, sanitizeTeamName("demo"));
    await mkdir(join(dir, "inboxes"), { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(fixture().team));
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture().plan));
    await writeFile(join(dir, "lifecycle.json"), JSON.stringify({ version: 1, members: fixture().lifecycle }));
    // lead 的邮箱：live 里一条未读 + history 里一条已读（同一条不得重复计入）
    await writeFile(join(dir, "inboxes", "team-lead.json"), JSON.stringify([
      { id: "mailbox-1", from: "impl", text: "做完了", summary: "完成", timestamp: "2026-11-05T02:00:00.000Z", read: false },
    ]));
    await writeFile(join(dir, "inboxes", "team-lead.history.jsonl"),
      `${JSON.stringify({ id: "mailbox-2", from: "impl", text: "旧消息", timestamp: "2026-11-05T00:30:00.000Z" })}\n`);
    await writeFile(join(dir, "accepted.jsonl"), `${JSON.stringify({ member: "impl", summary: "通过", at: "2026-11-05T02:30:00.000Z" })}\n`);

    const snapshot = await readTeamWorkbench("demo");
    assert.ok(snapshot);
    assert.equal(snapshot.team.name, "demo");
    // 无 tickets 目录：tickets 只来自 plan.tasks（向后兼容硬约束）
    assert.deepEqual(snapshot.tickets.map((t) => t.id), ["t1", "t2"]);
    assert.deepEqual(snapshot.receipts, []);
    const implToLead = snapshot.flows.find((f) => f.from === "impl" && f.to === "team-lead");
    assert.ok(implToLead, "邮箱消息带上了收件人 to");
    const ids = snapshot.flows.map((f) => `${f.from}|${f.at}|${f.text}`);
    assert.equal(new Set(ids).size, ids.length, "live + history 的同一消息不重复计入");

    assert.equal(await findTeamBySession("lead-session"), "demo");
    // impl 的 sessionId 只存在于 lifecycle.json（config 名册里没有），也要反查得到
    assert.equal(await findTeamBySession("s-impl"), "demo", "成员会话（lifecycle）反查");
    assert.equal(await findTeamBySession("nope"), null);
    const teams = await listTeams();
    assert.deepEqual(teams.map((t) => t.name), ["demo"]);
    // memberSessionIds：config 名册里没有 sessionId，lifecycle 的两条都要出现；
    // lead 会话（config 有可靠 leadSessionId 时直接用）也在内——侧栏的团队运行点靠它。
    assert.deepEqual(teams[0].memberSessionIds, ["s-impl", "s-qa", "lead-session"]);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

/** 写一个成员会话文件：header + `pi-web:subagent` 快照（真实落盘形态）。 */
async function writeMemberSession(file, { id, parentSessionId }) {
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-11-05T01:00:00.000Z", cwd: "D:/proj",
      parentSession: `/sessions/${parentSessionId}.jsonl` },
    { type: "custom", customType: "pi-web:subagent", id: "a1", parentId: null, timestamp: "2026-11-05T01:00:01.000Z",
      data: { version: 1, parentSessionId, parentSessionPath: `/sessions/${parentSessionId}.jsonl`,
        parentToolCallId: "pi-team:impl", profile: "general-purpose", description: "demo/impl", task: "干活",
        runInBackground: true, createdAt: "2026-11-05T01:00:01.000Z",
        resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: ["read"], loadSkills: false, loadExtensions: true } } },
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

test("lead 会话反查：config 的 leadSessionId 是 'unknown-session' 时用成员会话的 parentSessionId 还原", async () => {
  // 真实的 pi-team 落盘：服务端从不设 PI_SESSION_ID，config 里只有占位值。lead 会话
  // 因此既没有团队条也没有工作台入口（2026-11-12 用户实报）。成员会话的
  // `pi-web:subagent` 快照仍记着真正的 lead —— 反查必须用它。
  const root = await mkdtemp(join(tmpdir(), "pi-teams-lead-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    const dir = join(root, sanitizeTeamName("demo"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({
      ...fixture().team,
      leadSessionId: "unknown-session",
    }));
    const implFile = join(dir, "impl-session.jsonl");
    const qaFile = join(dir, "qa-session.jsonl");
    await writeMemberSession(implFile, { id: "child-impl", parentSessionId: "real-lead-session" });
    await writeMemberSession(qaFile, { id: "child-qa", parentSessionId: "real-lead-session" });
    await writeFile(join(dir, "lifecycle.json"), JSON.stringify({
      version: 1,
      members: {
        impl: { name: "impl", status: "parked", sessionId: "child-impl", sessionFile: implFile, updatedAt: 1 },
        qa: { name: "qa", status: "parked", sessionId: "child-qa", sessionFile: qaFile, updatedAt: 1 },
      },
    }));

    assert.equal(await findTeamBySession("real-lead-session"), "demo", "lead 会话必须能反查到团队");
    assert.equal(await findTeamBySession("child-impl"), "demo", "成员会话照旧命中");
    assert.equal(await findTeamBySession("not-the-lead"), null);
    // 侧栏的团队运行点也靠 memberSessionIds：lead 会话必须在里面。
    const teams = await listTeams();
    assert.ok(teams[0].memberSessionIds.includes("real-lead-session"), "lead 会话进 memberSessionIds");
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("readTeamWorkbench：合入 tickets/<id>.json 与 acks/receipts.jsonl，assignee 名映射成员 id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    const dir = join(root, sanitizeTeamName("demo"));
    await mkdir(join(dir, "inboxes"), { recursive: true });
    await mkdir(join(dir, "tickets"), { recursive: true });
    await mkdir(join(dir, "acks"), { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(fixture().team));
    await writeFile(join(dir, "plan.json"), JSON.stringify(fixture().plan));
    await writeFile(join(dir, "lifecycle.json"), JSON.stringify({ version: 1, members: fixture().lifecycle }));
    // pi-team team_ticket 的真实落盘形态：assignee / subscribers / thread.from 都是成员名
    await writeFile(join(dir, "tickets", "ticket-x.json"), JSON.stringify({
      schemaVersion: 1,
      id: "ticket-x",
      teamName: "demo",
      subject: "补读运行时工单",
      description: "team_ticket 建的票",
      status: "open",
      createdBy: "team-lead",
      createdAt: Date.parse("2026-11-05T02:10:00.000Z"),
      updatedAt: Date.parse("2026-11-05T02:20:00.000Z"),
      mandates: [{ id: "md-1", issuedBy: "team-lead", statement: "按票执行", createdAt: Date.parse("2026-11-05T02:10:00.000Z") }],
      assignments: [{ id: "as-1", assignee: "impl", status: "running", createdAt: Date.parse("2026-11-05T02:11:00.000Z"), updatedAt: Date.parse("2026-11-05T02:20:00.000Z") }],
      subscribers: ["impl"],
      thread: [{ id: "th-1", from: "team-lead", text: "开工", at: Date.parse("2026-11-05T02:10:30.000Z") }],
    }));
    // 撕裂行与损坏票：静默忽略
    await writeFile(join(dir, "tickets", "broken.json"), "{not json");
    await writeFile(join(dir, "acks", "receipts.jsonl"),
      `${JSON.stringify({ messageId: "mailbox-1", reader: "impl", ackedAt: Date.parse("2026-11-05T02:30:00.000Z") })}\n{"messageId":"trunc`);

    const snapshot = await readTeamWorkbench("demo");
    assert.ok(snapshot);
    assert.deepEqual(snapshot.tickets.map((t) => t.id), ["t1", "t2", "ticket-x"], "runtime 票在 plan 票之后");
    const x = snapshot.tickets.find((t) => t.id === "ticket-x");
    assert.equal(x.source, "runtime");
    assert.equal(x.status, "open");
    assert.equal(x.subject, "补读运行时工单");
    assert.equal(x.assignments.length, 1);
    assert.equal(x.assignments[0].id, "as-1");
    assert.equal(x.assignments[0].assignee, "impl");
    assert.equal(x.assignments[0].memberId, "m-impl", "assignee 成员名映射到正确成员 id");
    assert.equal(x.assignments[0].sessionId, "s-impl");
    assert.equal(x.assignments[0].status, "running");
    assert.equal(snapshot.receipts.length, 1, "撕裂行忽略");
    assert.deepEqual(snapshot.receipts[0], {
      messageId: "mailbox-1",
      reader: "impl",
      readerId: "m-impl",
      ackedAt: "2026-11-05T02:30:00.000Z",
    });
    // 独有票进入兼容 tasks 与 lane 事件
    assert.equal(snapshot.tasks.at(-1).id, "ticket-x");
    const implLane = snapshot.lanes.find((l) => l.name === "impl");
    assert.ok(implLane.events.some((e) => e.type === "task" && e.taskId === "ticket-x"), "impl lane 出现运行时任务事件");
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("listTeams：config 名册与 lifecycle 的 sessionId 合并去重", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    const dir = join(root, sanitizeTeamName("demo"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({
      ...fixture().team,
      // lead 与 impl 的 sessionId 在名册里；qa 只在 lifecycle；s-impl 两处都有 → 去重
      members: fixture().team.members.map((m, i) => ({ ...m, sessionId: i === 0 ? "lead-session" : i === 1 ? "s-impl" : undefined })),
    }));
    await writeFile(join(dir, "lifecycle.json"), JSON.stringify({
      version: 1,
      members: { impl: { name: "impl", status: "idle", sessionId: "s-impl" }, qa: { name: "qa", status: "idle", sessionId: "s-qa" } },
    }));
    const teams = await listTeams();
    assert.deepEqual(teams[0].memberSessionIds, ["lead-session", "s-impl", "s-qa"], "合并去重：名册在前，lifecycle 补充");
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("readTeamWorkbench：团队不存在返回 null", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    assert.equal(await readTeamWorkbench("ghost"), null);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("listTeams：displayName 取 config.name（中文名不再显示成 -----），缺失回退目录名", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teams-display-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  try {
    // 中文团队名：目录名被 sanitizeTeamName 全替换成 '-'，显示名必须取 config.name。
    const chineseDir = sanitizeTeamName("前端重构队");
    await mkdir(chineseDir ? join(root, chineseDir) : root, { recursive: true });
    await writeFile(join(root, chineseDir, "config.json"), JSON.stringify({
      name: "前端重构队", description: "", createdAt: 1, leadAgentId: "team-lead",
      members: [{ agentId: "lead-1", name: "team-lead", joinedAt: 1, cwd: "" }],
    }));
    // config 没有 name 的团队：displayName 回退目录名。
    await mkdir(join(root, "plain-team"), { recursive: true });
    await writeFile(join(root, "plain-team", "config.json"), JSON.stringify({
      createdAt: 1, leadAgentId: "team-lead", members: [],
    }));

    const teams = await listTeams();
    const chinese = teams.find((team) => team.name === chineseDir);
    assert.ok(chinese, `目录名应为 sanitize 后的 ${JSON.stringify(chineseDir)}`);
    assert.match(chinese.name, /^-+$/, "目录名是一串短横线");
    assert.equal(chinese.displayName, "前端重构队", "显示名取 config.name，不再是一串 -");

    const plain = teams.find((team) => team.name === "plain-team");
    assert.equal(plain.displayName, "plain-team", "缺 config.name 时回退目录名");
  } finally {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
