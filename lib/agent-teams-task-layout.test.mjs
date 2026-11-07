import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS_BOTTOM_PADDING,
  DEPTH_COLUMN_GAP,
  DEPTH_COLUMN_TOP,
  DEPTH_COLUMN_WIDTH,
  HORIZONTAL_PADDING,
  ROW_GAP,
  TASK_HEIGHT,
  TASK_TOP,
  TASK_WIDTH,
  URGENCY_ORDER,
  URGENCY_WEIGHT,
  getTeamTaskState,
  getTicketUrgency,
  layoutTeamWorkbenchTasks,
} from "./agent-teams-task-layout.ts";

/** 泳道基础高度（上下各留 TASK_TOP - DEPTH_COLUMN_TOP 的内边距）。 */
const BASE_LANE_HEIGHT = (TASK_TOP - DEPTH_COLUMN_TOP) * 2;
/** 单行任务的泳道高度。 */
const SINGLE_ROW_LANE_HEIGHT = BASE_LANE_HEIGHT + TASK_HEIGHT;

function assignment(status, outcome = null) {
  return {
    id: `as-${status}`,
    status,
    memberId: "m-impl",
    assignee: "impl",
    sessionId: null,
    startedAt: null,
    result: null,
    outcome,
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
    // 默认同一时刻：迫使同泳道回退到 id 自然序，保持与旧行为一致。
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(tickets) {
  return { tickets };
}

function byId(layout, id) {
  return layout.tasks.find((task) => task.ticket.id === id);
}

/** 通用不变量：有限尺寸、票数守恒、无 count=0 的幻影泳道。 */
function assertLayoutInvariants(layout, ticketCount) {
  assert.ok(Number.isFinite(layout.width) && layout.width >= 0, "宽必须是有限非负数");
  assert.ok(Number.isFinite(layout.height) && layout.height >= 0, "高必须是有限非负数");
  assert.equal(layout.tasks.length, ticketCount, "票数守恒：不吞票也不造票");
  assert.ok(layout.lanes.every((lane) => lane.count > 0), "不存在 count=0 的空泳道");
  assert.equal(
    layout.lanes.reduce((sum, lane) => sum + lane.count, 0),
    ticketCount,
    "泳道内票数之和等于总票数",
  );
  const depths = layout.lanes.map((lane) => lane.depth);
  assert.deepEqual(depths, [...depths].sort((a, b) => a - b), "泳道按深度升序");
  assert.equal(new Set(depths).size, depths.length, "同一深度只有一条泳道");
}

test("空任务：无泳道、无定位任务，画布只剩留白", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([]));
  assert.deepEqual(layout.lanes, []);
  assert.deepEqual(layout.tasks, []);
  assert.equal(layout.hasCycle, false);
  assert.equal(layout.width, HORIZONTAL_PADDING * 2);
  assert.equal(layout.height, DEPTH_COLUMN_TOP + BASE_LANE_HEIGHT + CANVAS_BOTTOM_PADDING);
  assertLayoutInvariants(layout, 0);
});

test("单根任务：depth 0 一条泳道，任务水平居中于泳道", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([ticket("t1")]));
  assert.equal(layout.lanes.length, 1);
  assert.deepEqual(layout.lanes[0], {
    depth: 0,
    x: HORIZONTAL_PADDING,
    y: DEPTH_COLUMN_TOP,
    width: DEPTH_COLUMN_WIDTH,
    height: SINGLE_ROW_LANE_HEIGHT,
    count: 1,
  });
  assert.equal(layout.tasks.length, 1);
  const positioned = layout.tasks[0];
  assert.equal(positioned.ticket.id, "t1");
  assert.equal(positioned.urgency, "available");
  assert.equal(positioned.depth, 0);
  assert.equal(positioned.row, 0);
  assert.equal(positioned.cycleId, null);
  assert.equal(positioned.x, HORIZONTAL_PADDING + (DEPTH_COLUMN_WIDTH - TASK_WIDTH) / 2);
  assert.equal(positioned.y, TASK_TOP);
  assert.equal(layout.width, HORIZONTAL_PADDING * 2 + DEPTH_COLUMN_WIDTH);
  assert.equal(layout.height, DEPTH_COLUMN_TOP + SINGLE_ROW_LANE_HEIGHT + CANVAS_BOTTOM_PADDING);
});

test("三层依赖：每层一条泳道自左向右，深度沿最长依赖路径递增", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("t3", { dependencies: ["t2"] }),
    ticket("t1"),
    ticket("t2", { dependencies: ["t1"] }),
  ]));
  assert.deepEqual(layout.lanes.map((lane) => lane.depth), [0, 1, 2]);
  assert.deepEqual(layout.lanes.map((lane) => lane.count), [1, 1, 1]);
  assert.deepEqual(layout.lanes.map((lane) => lane.x), [
    HORIZONTAL_PADDING,
    HORIZONTAL_PADDING + DEPTH_COLUMN_WIDTH + DEPTH_COLUMN_GAP,
    HORIZONTAL_PADDING + 2 * (DEPTH_COLUMN_WIDTH + DEPTH_COLUMN_GAP),
  ]);
  assert.deepEqual(layout.tasks.map((task) => [task.ticket.id, task.depth, task.row]), [
    ["t1", 0, 0],
    ["t2", 1, 0],
    ["t3", 2, 0],
  ]);
  assert.equal(byId(layout, "t1").urgency, "available");
  assert.equal(byId(layout, "t2").urgency, "blocked");
  assert.equal(byId(layout, "t3").urgency, "blocked");
  assert.equal(layout.width, HORIZONTAL_PADDING * 2 + 3 * DEPTH_COLUMN_WIDTH + 2 * DEPTH_COLUMN_GAP);
  assert.equal(layout.height, DEPTH_COLUMN_TOP + SINGLE_ROW_LANE_HEIGHT + CANVAS_BOTTOM_PADDING);
  assertLayoutInvariants(layout, 3);
});

test("多根并列：同层任务按 id 自然序纵向堆叠，泳道高度按最大行数撑开", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("t10"),
    ticket("t3", { dependencies: ["t10", "t2"] }),
    ticket("t2"),
  ]));
  assert.deepEqual(layout.lanes.map((lane) => lane.count), [2, 1]);
  assert.deepEqual(
    layout.tasks.filter((task) => task.depth === 0).map((task) => [task.ticket.id, task.row]),
    [["t2", 0], ["t10", 1]],
    "t2 排在 t10 前（自然序），行号从 0 起",
  );
  assert.equal(byId(layout, "t2").y, TASK_TOP);
  assert.equal(byId(layout, "t10").y, TASK_TOP + TASK_HEIGHT + ROW_GAP);
  assert.equal(byId(layout, "t3").depth, 1, "深度取依赖路径的最大值");
  assert.equal(layout.lanes[0].height, BASE_LANE_HEIGHT + 2 * TASK_HEIGHT + ROW_GAP);
  assert.equal(
    layout.height,
    DEPTH_COLUMN_TOP + BASE_LANE_HEIGHT + 2 * TASK_HEIGHT + ROW_GAP + CANVAS_BOTTOM_PADDING,
  );
  assertLayoutInvariants(layout, 3);
});

test("依赖环：缩点后环内共享一条泳道，不产生幻影空泳道（改断言不变量，不焊死 depth 数值）", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("b", { dependencies: ["a"] }),
    ticket("a", { dependencies: ["b"] }),
  ]));
  assert.deepEqual(layout.tasks.map((task) => task.ticket.id).sort(), ["a", "b"], "环不吞票");
  assert.equal(layout.hasCycle, true, "识别出依赖环");
  // 环内两票同一分量 → 同一 cycleId，且都在同一（唯一）泳道。
  const cycleIds = layout.tasks.map((task) => task.cycleId);
  assert.ok(cycleIds.every((id) => id !== null), "环内票都带 cycleId");
  assert.equal(new Set(cycleIds).size, 1, "同一环共享一个 cycleId");
  assert.equal(byId(layout, "a").depth, byId(layout, "b").depth, "环内共享深度");
  assert.equal(layout.lanes.length, 1, "环只占一条泳道");
  assert.equal(layout.lanes[0].count, 2);
  assert.equal(byId(layout, "a").urgency, "blocked");
  assert.equal(byId(layout, "b").urgency, "blocked");
  assertLayoutInvariants(layout, 2);
});

test("自依赖：递归终止，自环识别为环且不坍塌成空泳道", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("a", { dependencies: ["a"] }),
  ]));
  assert.equal(layout.tasks.length, 1);
  assert.equal(layout.hasCycle, true);
  assert.equal(byId(layout, "a").depth, 0);
  assert.equal(byId(layout, "a").cycleId, 0);
  assertLayoutInvariants(layout, 1);
});

test("重复 id：布局不崩、票数守恒", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("dup"),
    ticket("dup", { dependencies: ["x"] }),
    ticket("x"),
  ]));
  assert.equal(layout.tasks.length, 3, "两张同 id 票都在");
  assertLayoutInvariants(layout, 3);
});

test("依赖指向不存在的票：视为已解除，落在 depth 0", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("a", { dependencies: ["ghost"] }),
  ]));
  assert.equal(byId(layout, "a").depth, 0);
  assert.equal(byId(layout, "a").urgency, "available");
  assert.equal(layout.hasCycle, false);
  assertLayoutInvariants(layout, 1);
});

test("深链超 100：迭代式环检测不爆栈，深度线性增长", () => {
  const depth = 130;
  const tickets = [];
  for (let i = 0; i < depth; i += 1) {
    tickets.push(ticket(`t${i}`, i === 0 ? {} : { dependencies: [`t${i - 1}`] }));
  }
  const layout = layoutTeamWorkbenchTasks(snapshot(tickets));
  assert.equal(layout.tasks.length, depth);
  assert.equal(layout.lanes.length, depth);
  assert.equal(byId(layout, `t${depth - 1}`).depth, depth - 1);
  assertLayoutInvariants(layout, depth);
});

test("全部 blocked：三票互依（大环），共享一条泳道且没有空泳道", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("a", { dependencies: ["c"] }),
    ticket("b", { dependencies: ["a"] }),
    ticket("c", { dependencies: ["b"] }),
  ]));
  assert.ok(layout.tasks.every((task) => task.urgency === "blocked"), "环内票全 blocked");
  assert.equal(new Set(layout.tasks.map((task) => task.cycleId)).size, 1);
  assertLayoutInvariants(layout, 3);
});

test("追加式布局：插入一张 createdAt 最新的票，已有票的坐标不变", () => {
  const base = [
    ticket("r1", { createdAt: "2026-01-01T00:00:00.000Z" }),
    ticket("r2", { createdAt: "2026-01-02T00:00:00.000Z" }),
    ticket("r3", { createdAt: "2026-01-03T00:00:00.000Z" }),
  ];
  const before = layoutTeamWorkbenchTasks(snapshot(base));
  const beforePosition = new Map(
    before.tasks.map((task) => [task.ticket.id, { x: task.x, y: task.y, row: task.row }]),
  );

  const after = layoutTeamWorkbenchTasks(snapshot([
    ...base,
    ticket("r4", { createdAt: "2026-01-04T00:00:00.000Z" }),
  ]));

  for (const id of ["r1", "r2", "r3"]) {
    const previous = beforePosition.get(id);
    const current = byId(after, id);
    assert.equal(current.y, previous.y, `${id} 的 y 不变（新票追加在末尾）`);
    assert.equal(current.x, previous.x, `${id} 的 x 不变`);
    assert.equal(current.row, previous.row, `${id} 的 row 不变`);
  }
  assert.equal(byId(after, "r4").row, 3, "新票落在该泳道末尾");
  assert.equal(after.lanes[0].count, 4);
});

test("追加式布局：同泳道内按 createdAt 升序而非 id 序", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("z", { createdAt: "2026-01-05T00:00:00.000Z" }),
    ticket("a", { createdAt: "2026-01-01T00:00:00.000Z" }),
    ticket("m", { createdAt: "2026-01-03T00:00:00.000Z" }),
  ]));
  assert.deepEqual(
    layout.tasks.filter((task) => task.depth === 0).map((task) => task.ticket.id),
    ["a", "m", "z"],
    "createdAt 早的在上，与 id 字母序无关",
  );
});

test("状态推导：ended 优先、running → in_progress、未 ended 依赖 → blocked、缺失依赖 → available", () => {
  const tickets = [
    ticket("done", { status: "ended", assignments: [assignment("running")] }),
    ticket("run", { dependencies: ["done"], assignments: [assignment("running")] }),
    ticket("ready", { dependencies: ["done"] }),
    ticket("blocked", { dependencies: ["run"] }),
    ticket("orphan", { dependencies: ["ghost"] }),
  ];
  const ticketsById = new Map(tickets.map((item) => [item.id, item]));

  assert.equal(getTeamTaskState(ticketsById.get("done"), ticketsById), "completed", "ended 压过 running 派活");
  assert.equal(getTeamTaskState(ticketsById.get("run"), ticketsById), "in_progress");
  assert.equal(getTeamTaskState(ticketsById.get("ready"), ticketsById), "available", "依赖已 ended 即解除");
  assert.equal(getTeamTaskState(ticketsById.get("blocked"), ticketsById), "blocked");
  assert.equal(getTeamTaskState(ticketsById.get("orphan"), ticketsById), "available", "列表外的依赖视为已解除");

  const layout = layoutTeamWorkbenchTasks(snapshot(tickets));
  assert.equal(byId(layout, "done").urgency, "completed");
  assert.equal(byId(layout, "run").urgency, "running", "in_progress 在展示口径下归一为 running");
  assert.equal(byId(layout, "ready").urgency, "available");
  assert.equal(byId(layout, "blocked").urgency, "blocked");
  assert.equal(byId(layout, "orphan").depth, 0, "缺失依赖不参与分层");
});

test("紧急度口径：ended 且派活失败抬到 failed，只此一处判定", () => {
  const tickets = [
    ticket("ok", { status: "ended", assignments: [assignment("ended", "completed")] }),
    ticket("bad", { status: "ended", assignments: [assignment("ended", "failed")] }),
    ticket("running", { assignments: [assignment("running")] }),
  ];
  const ticketsById = new Map(tickets.map((item) => [item.id, item]));
  assert.equal(getTicketUrgency(ticketsById.get("ok"), ticketsById), "completed");
  assert.equal(getTicketUrgency(ticketsById.get("bad"), ticketsById), "failed", "失败压过 completed");
  assert.equal(getTicketUrgency(ticketsById.get("running"), ticketsById), "running");

  const layout = layoutTeamWorkbenchTasks(snapshot(tickets));
  assert.equal(byId(layout, "bad").urgency, "failed");
  assert.equal(byId(layout, "ok").urgency, "completed");
});

test("紧急度优先级常量：顺序即优先级，权重单调递减", () => {
  assert.deepEqual(URGENCY_ORDER, ["failed", "blocked", "available", "running", "completed"]);
  for (let i = 1; i < URGENCY_ORDER.length; i += 1) {
    assert.ok(
      URGENCY_WEIGHT[URGENCY_ORDER[i - 1]] > URGENCY_WEIGHT[URGENCY_ORDER[i]],
      `${URGENCY_ORDER[i - 1]} 应比 ${URGENCY_ORDER[i]} 更紧急`,
    );
  }
});

test("requestedWidth：画布不小于容器宽，泳道水平居中", () => {
  const naturalWidth = HORIZONTAL_PADDING * 2 + DEPTH_COLUMN_WIDTH;
  const layout = layoutTeamWorkbenchTasks(snapshot([ticket("t1")]), 1000);
  assert.equal(layout.width, 1000);
  assert.equal(layout.lanes[0].x, (1000 - naturalWidth) / 2 + HORIZONTAL_PADDING);
  assert.equal(layout.tasks[0].x, layout.lanes[0].x + (DEPTH_COLUMN_WIDTH - TASK_WIDTH) / 2);
  assert.equal(layoutTeamWorkbenchTasks(snapshot([ticket("t1")]), Number.NaN).width, naturalWidth);
  assert.equal(
    layoutTeamWorkbenchTasks(snapshot([ticket("t1")]), 100).width,
    naturalWidth,
    "小于自然宽度时以自然宽度为准",
  );
});
