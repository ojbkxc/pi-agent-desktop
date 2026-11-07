import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS_BOTTOM_PADDING,
  HORIZONTAL_PADDING,
  LANE_GAP,
  LANE_TOP,
  LANE_WIDTH,
  ROW_GAP,
  TASK_HEIGHT,
  TASK_TOP,
  TASK_WIDTH,
  getTeamTaskState,
  layoutTeamWorkbenchTasks,
} from "./agent-teams-task-layout.ts";

/** 泳道基础高度（上下各留 TASK_TOP - LANE_TOP 的内边距）。 */
const BASE_LANE_HEIGHT = (TASK_TOP - LANE_TOP) * 2;
/** 单行任务的泳道高度。 */
const SINGLE_ROW_LANE_HEIGHT = BASE_LANE_HEIGHT + TASK_HEIGHT;

function assignment(status) {
  return {
    id: `as-${status}`,
    status,
    memberId: "m-impl",
    assignee: "impl",
    sessionId: null,
    startedAt: null,
    result: null,
    outcome: null,
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
    ...overrides,
  };
}

function snapshot(tickets) {
  return { tickets };
}

function byId(layout, id) {
  return layout.tasks.find((task) => task.ticket.id === id);
}

test("空任务：无泳道、无定位任务，画布只剩留白", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([]));
  assert.deepEqual(layout.lanes, []);
  assert.deepEqual(layout.tasks, []);
  assert.equal(layout.width, HORIZONTAL_PADDING * 2);
  assert.equal(layout.height, LANE_TOP + BASE_LANE_HEIGHT + CANVAS_BOTTOM_PADDING);
});

test("单根任务：depth 0 一条泳道，任务水平居中于泳道", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([ticket("t1")]));
  assert.equal(layout.lanes.length, 1);
  assert.deepEqual(layout.lanes[0], {
    depth: 0,
    x: HORIZONTAL_PADDING,
    y: LANE_TOP,
    width: LANE_WIDTH,
    height: SINGLE_ROW_LANE_HEIGHT,
    count: 1,
  });
  assert.equal(layout.tasks.length, 1);
  const positioned = layout.tasks[0];
  assert.equal(positioned.ticket.id, "t1");
  assert.equal(positioned.state, "available");
  assert.equal(positioned.depth, 0);
  assert.equal(positioned.row, 0);
  assert.equal(positioned.x, HORIZONTAL_PADDING + (LANE_WIDTH - TASK_WIDTH) / 2);
  assert.equal(positioned.y, TASK_TOP);
  assert.equal(layout.width, HORIZONTAL_PADDING * 2 + LANE_WIDTH);
  assert.equal(layout.height, LANE_TOP + SINGLE_ROW_LANE_HEIGHT + CANVAS_BOTTOM_PADDING);
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
    HORIZONTAL_PADDING + LANE_WIDTH + LANE_GAP,
    HORIZONTAL_PADDING + 2 * (LANE_WIDTH + LANE_GAP),
  ]);
  assert.deepEqual(layout.tasks.map((task) => [task.ticket.id, task.depth, task.row]), [
    ["t1", 0, 0],
    ["t2", 1, 0],
    ["t3", 2, 0],
  ]);
  assert.equal(byId(layout, "t1").state, "available");
  assert.equal(byId(layout, "t2").state, "blocked");
  assert.equal(byId(layout, "t3").state, "blocked");
  assert.equal(layout.width, HORIZONTAL_PADDING * 2 + 3 * LANE_WIDTH + 2 * LANE_GAP);
  assert.equal(layout.height, LANE_TOP + SINGLE_ROW_LANE_HEIGHT + CANVAS_BOTTOM_PADDING);
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
    LANE_TOP + BASE_LANE_HEIGHT + 2 * TASK_HEIGHT + ROW_GAP + CANVAS_BOTTOM_PADDING,
  );
});

test("依赖环：递归终止，环边截断为 0，两票仍各占一条泳道", () => {
  const layout = layoutTeamWorkbenchTasks(snapshot([
    ticket("b", { dependencies: ["a"] }),
    ticket("a", { dependencies: ["b"] }),
  ]));
  assert.deepEqual(layout.tasks.map((task) => task.ticket.id).sort(), ["a", "b"], "环不吞票");
  assert.deepEqual(
    layout.tasks.map((task) => [task.ticket.id, task.depth]),
    [["b", 1], ["a", 2]],
    "与 cc-haha taskDepths 一致：先访问的环内节点被回边截断",
  );
  assert.deepEqual(layout.lanes.map((lane) => lane.count), [0, 1, 1]);
  assert.equal(byId(layout, "a").state, "blocked");
  assert.equal(byId(layout, "b").state, "blocked");
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
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
  assert.equal(byId(layout, "done").state, "completed");
  assert.equal(byId(layout, "run").state, "in_progress");
  assert.equal(byId(layout, "ready").state, "available");
  assert.equal(byId(layout, "blocked").state, "blocked");
  assert.equal(byId(layout, "orphan").depth, 0, "缺失依赖不参与分层");
});

test("requestedWidth：画布不小于容器宽，泳道水平居中", () => {
  const naturalWidth = HORIZONTAL_PADDING * 2 + LANE_WIDTH;
  const layout = layoutTeamWorkbenchTasks(snapshot([ticket("t1")]), 1000);
  assert.equal(layout.width, 1000);
  assert.equal(layout.lanes[0].x, (1000 - naturalWidth) / 2 + HORIZONTAL_PADDING);
  assert.equal(layout.tasks[0].x, layout.lanes[0].x + (LANE_WIDTH - TASK_WIDTH) / 2);
  assert.equal(layoutTeamWorkbenchTasks(snapshot([ticket("t1")]), Number.NaN).width, naturalWidth);
  assert.equal(
    layoutTeamWorkbenchTasks(snapshot([ticket("t1")]), 100).width,
    naturalWidth,
    "小于自然宽度时以自然宽度为准",
  );
});
