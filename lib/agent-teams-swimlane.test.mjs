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
  findTeamByLeadSession,
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
    const implToLead = snapshot.flows.find((f) => f.from === "impl" && f.to === "team-lead");
    assert.ok(implToLead, "邮箱消息带上了收件人 to");
    const ids = snapshot.flows.map((f) => `${f.from}|${f.at}|${f.text}`);
    assert.equal(new Set(ids).size, ids.length, "live + history 的同一消息不重复计入");

    assert.equal(await findTeamByLeadSession("lead-session"), "demo");
    assert.equal(await findTeamByLeadSession("nope"), null);
    const teams = await listTeams();
    assert.deepEqual(teams.map((t) => t.name), ["demo"]);
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
