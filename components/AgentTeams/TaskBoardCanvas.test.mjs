import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  TaskBoardCanvas,
  countTaskStates,
  dependencyPath,
  laneTitleKey,
  taskToneClass,
  ticketConcurrency,
} = await jiti.import("./TaskBoardCanvas.tsx");
const { formationRequiredWidth } = await jiti.import("./FormationBand.tsx");
const {
  TASK_HEIGHT,
  TASK_WIDTH,
  getTicketUrgency,
} = await jiti.import("@/lib/agent-teams-task-layout.ts");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (snapshot) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: "en" },
  React.createElement(TaskBoardCanvas, { snapshot }),
));

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
    ownerId: "m-impl",
    status: "open",
    dependencies: [],
    assignments: [],
    source: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(tickets, members = [{ id: "m-impl", name: "impl" }]) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    team: { memberId: null, assignee: "lead", sessionId: null, startedAt: null, result: null, outcome: null },
    members: members.map((member) => ({
      id: member.id,
      name: member.name,
      role: "worker",
      model: null,
      providerName: null,
      color: "blue",
      status: "running",
      activity: "active",
      sessionId: null,
      cwd: "",
      worktreePath: null,
      lastError: null,
      joinedAt: "2026-01-01T00:00:00.000Z",
    })),
    tickets,
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
  };
}

test("taskToneClass derives the colour class straight from the urgency", () => {
  assert.equal(taskToneClass("running"), "agent-teams-board-task--running");
  assert.equal(taskToneClass("completed"), "agent-teams-board-task--completed");
  assert.equal(taskToneClass("blocked"), "agent-teams-board-task--blocked");
  assert.equal(taskToneClass("available"), "agent-teams-board-task--available");
  assert.equal(taskToneClass("failed"), "agent-teams-board-task--failed");
});

test("urgency is the single source: ended+failed renders as failed, counts stay consistent", () => {
  const failed = ticket("f", { status: "ended", assignments: [assignment("ended", "failed")] });
  const completed = ticket("c", { status: "ended", assignments: [assignment("ended", "completed")] });
  const byId = new Map([[failed.id, failed], [completed.id, completed]]);
  assert.equal(getTicketUrgency(failed, byId), "failed");
  assert.equal(getTicketUrgency(completed, byId), "completed");

  const counts = countTaskStates([failed, completed]);
  assert.equal(counts.failed, 1, "失败票计入 failed");
  assert.equal(counts.completed, 1, "失败票不再混进 completed");
  assert.equal(taskToneClass(getTicketUrgency(failed, byId)), "agent-teams-board-task--failed", "计数与着色同源");

  const html = render(snapshot([failed, completed]));
  assert.match(html, /agent-teams-board-task--failed/);
  assert.match(html, /agent-teams-board-task--completed/);
});

test("laneTitleKey labels root, intermediate and wrap-up layers", () => {
  assert.equal(laneTitleKey(0, 2), "teams.boardRoot");
  assert.equal(laneTitleKey(1, 2), "teams.boardLayer");
  assert.equal(laneTitleKey(2, 2), "teams.boardWrapUp");
  // Single layer: the root label wins over wrap-up, matching cc-haha.
  assert.equal(laneTitleKey(0, 0), "teams.boardRoot");
});

test("countTaskStates is mutually exclusive, five-state and treats missing dependencies as resolved", () => {
  const tickets = [
    ticket("t1", { status: "ended", assignments: [assignment("ended", "completed")] }),
    ticket("t2", { assignments: [assignment("running")] }),
    ticket("t3", { dependencies: ["t1"] }),
    ticket("t4", { dependencies: ["t2"] }),
    ticket("t5", { dependencies: ["missing"] }),
    ticket("t6", { status: "ended", assignments: [assignment("ended", "failed")] }),
  ];
  assert.deepEqual(countTaskStates(tickets), {
    failed: 1,
    blocked: 1,
    available: 2,
    running: 1,
    completed: 1,
  });
});

test("dependencyPath runs from the dependency's right edge to the dependent's left edge", () => {
  const from = { x: 32, y: 442 };
  const to = { x: 268, y: 442 };
  const path = dependencyPath(from, to);
  assert.match(path, new RegExp(`^M ${from.x + TASK_WIDTH} ${from.y + TASK_HEIGHT / 2} C `));
  assert.match(path, new RegExp(`${to.x} ${to.y + TASK_HEIGHT / 2}$`));
});

test("renders one lane per dependency depth with root/layer/wrap-up titles", () => {
  const html = render(snapshot([
    ticket("t1"),
    ticket("t2", { dependencies: ["t1"] }),
    ticket("t3", { dependencies: ["t2"] }),
  ]));
  assert.match(html, /Root tasks/);
  assert.match(html, /Layer 2/);
  assert.match(html, /Wrap-up/);
  assert.match(html, /agent-teams-board-lane/);
});

test("draws the lane plates inside the SVG before the dependency edges (no occlusion)", () => {
  const html = render(snapshot([
    ticket("t1", { status: "ended", assignments: [assignment("ended", "completed")] }),
    ticket("t2", { dependencies: ["t1"] }),
  ]));
  const plateIndex = html.indexOf("agent-teams-board-plate");
  // 用「--done」锁定依赖连线本身，避免撞上 SVG 容器类 `agent-teams-board-edges`。
  const edgeIndex = html.indexOf("agent-teams-board-edge--done");
  assert.ok(plateIndex >= 0, "底板画在 SVG 里");
  assert.ok(edgeIndex >= 0, "依赖连线仍在");
  assert.ok(plateIndex < edgeIndex, "底板必须先于连线绘制，连线才不被遮挡");
});

test("renders the formation slot with the board's own width", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(TaskBoardCanvas, {
      snapshot: snapshot([ticket("t1")]),
      requestedWidth: 900,
      formation: (width) => React.createElement("div", { className: "test-formation" }, `w=${width}`),
    }),
  ));
  assert.match(html, /test-formation/);
  assert.match(html, /w=900/, "编队带拿到的是画布最终宽度");
});

test("renders owner name and a blockedBy count badge on task cards", () => {
  const html = render(snapshot([
    ticket("t1", { status: "ended", assignments: [assignment("ended", "completed")] }),
    ticket("t2"),
    ticket("t3", { dependencies: ["t2"] }),
    ticket("t4", { dependencies: ["t1"] }),
  ]));
  assert.match(html, /impl/);
  assert.match(html, /1 blocked/);
  assert.match(html, /agent-teams-board-task--blocked/);
  assert.match(html, /agent-teams-board-task--completed/);
  assert.match(html, /agent-teams-board-edge agent-teams-board-edge--done/);
});

test("renders the empty state when the team has no tasks", () => {
  const html = render(snapshot([]));
  assert.match(html, /No tasks yet/);
  assert.doesNotMatch(html, /agent-teams-board-lane/);
});

test("still renders the formation band when there are no tickets yet", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(TaskBoardCanvas, {
      snapshot: snapshot([]),
      requestedWidth: 900,
      formation: (width) => React.createElement("div", { className: "test-formation" }, `w=${width}`),
    }),
  ));
  assert.match(html, /test-formation/, "成员已 spawn、票还没建时也要看到编队带");
  assert.match(html, /w=900/);
  assert.match(html, /No tasks yet/);
  assert.doesNotMatch(html, /agent-teams-board-lane/);
});

test("marks cycle tickets and shows a warning banner when the graph has a cycle", () => {
  const html = render(snapshot([
    ticket("a", { dependencies: ["b"] }),
    ticket("b", { dependencies: ["a"] }),
  ]));
  assert.match(html, /agent-teams-board-task--cycle/);
  assert.match(html, /agent-teams-board-cycle-warning/);
  // 无环时不渲染告警
  const clean = render(snapshot([ticket("a")]));
  assert.doesNotMatch(clean, /agent-teams-board-cycle-warning/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 本轮修复：并发可见（同票多成员并行）+ 重复依赖去重 + 成员多时画布宽度。
// ─────────────────────────────────────────────────────────────────────────────

/** 一条 running 派活（并发口径只认 status=running）。 */
function runningAssignment(memberId, assignee = memberId) {
  return {
    id: `as-run-${memberId}`,
    status: "running",
    memberId,
    assignee,
    sessionId: null,
    startedAt: null,
    lastActivityAt: null,
    result: null,
    outcome: null,
  };
}

test("ticketConcurrency：同一张票多个成员并行时给出计数与接手人（成员去重）", () => {
  const byId = ticketConcurrency([
    ticket("t1", { assignments: [runningAssignment("m-impl", "impl"), runningAssignment("m-qa", "qa")] }),
    ticket("t2", { assignments: [runningAssignment("m-impl", "impl")] }),
    ticket("t3", { assignments: [] }),
    // 同一成员在同一张票上两条 running：人手只算一次，但并发条数如实计 2。
    ticket("t4", { assignments: [runningAssignment("m-impl", "impl"), runningAssignment("m-impl", "impl")] }),
  ]);
  assert.deepEqual(byId.get("t1"), { running: 2, assignees: ["impl", "qa"] });
  assert.deepEqual(byId.get("t2"), { running: 1, assignees: ["impl"] });
  assert.equal(byId.get("t3"), undefined);
  assert.deepEqual(byId.get("t4"), { running: 2, assignees: ["impl"] });
});

test("并发徽标：running>1 才画，不串行化（并把接手人放进 title）", () => {
  const html = render(snapshot([
    ticket("t1", { assignments: [runningAssignment("m-impl", "impl"), runningAssignment("m-qa", "qa")] }),
    ticket("t2", { assignments: [runningAssignment("m-impl", "impl")] }),
  ], [{ id: "m-impl", name: "impl" }, { id: "m-qa", name: "qa" }]));
  assert.match(html, /data-concurrent-running="2"/);
  assert.match(html, /2 running/, "N 项进行中直接可见");
  assert.match(html, /title="impl, qa"/, "接手人清单进 title");
  // 单条 running 的票不挂并发徽标（避免噪声，也保持既有单派活口径）。
  const single = render(snapshot([ticket("t2", { assignments: [runningAssignment("m-impl", "impl")] })]));
  assert.doesNotMatch(single, /data-concurrent-running/);
});

test("重复依赖只画一条连线（重复 key 会重复渲染 path 并触发 React 警告）", () => {
  const html = render(snapshot([
    ticket("t1", { status: "ended", assignments: [assignment("ended", "completed")] }),
    ticket("t2", { dependencies: ["t1", "t1"] }),
  ]));
  const edges = html.match(/agent-teams-board-edge(?![-\w])/g) ?? [];
  assert.equal(edges.length, 1);
});

test("成员很多时画布放宽：编队带不再被任务画布裁掉", () => {
  const members = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, name: `m${index}` }));
  const needed = formationRequiredWidth(60);
  assert.ok(needed > 900, "60 个成员需要的宽度仍是容器宽的 1.7 倍以上");
  assert.ok(needed < 2000, "分行后不再要求 11.8k px 的画布宽度");
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(TaskBoardCanvas, {
      snapshot: snapshot([ticket("t1")], members),
      requestedWidth: 900,
      formation: (width) => React.createElement("div", { className: "test-formation" }, `w=${width}`),
    }),
  ));
  assert.match(html, new RegExp(`w=${needed}`), "编队带拿到的是放宽后的画布宽度");
  assert.match(html, new RegExp(`min-width:${needed}px`), "画布本身也放宽到该宽度");
});

test("成员多到要分行时任务泳道整体下移（否则第二行成员压在任务卡上）", async () => {
  const { formationBandBottom, formationRowCount, membersPerRow } =
    await jiti.import("@/lib/agent-teams-formation-layout.ts");
  const members = Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, name: `m${index}` }));
  // 30 人 = lead + 29 个成员；画布宽 = max(任务宽, 编队带要求宽)。
  const canvasWidth = Math.max(900, formationRequiredWidth(30));
  const rows = formationRowCount(29, canvasWidth);
  assert.ok(rows > 1, "30 个成员确实会分行");
  assert.equal(membersPerRow(canvasWidth), 8, "画布够宽时一行放满单行上限");
  const expectedOffset = formationBandBottom(rows) - 410;
  assert.ok(expectedOffset > 0);

  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(TaskBoardCanvas, {
      snapshot: snapshot([ticket("t1")], members),
      requestedWidth: 900,
      formation: (width) => React.createElement("div", { className: "test-formation" }, `w=${width}`),
    }),
  ));
  assert.match(html, new RegExp(`transform="translate\\(0 ${expectedOffset}\\)"`), "泳道底板与依赖连线整体下移");
  assert.match(html, new RegExp(`top:${442 + expectedOffset}px`), "任务卡位置同样下移（不落在成员卡下面）");
});

test("成员很少时画布宽度不变（既有宽度断言口径保持）", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(TaskBoardCanvas, {
      snapshot: snapshot([ticket("t1")], [{ id: "m-impl", name: "impl" }]),
      requestedWidth: 900,
      formation: (width) => React.createElement("div", { className: "test-formation" }, `w=${width}`),
    }),
  ));
  assert.match(html, /w=900/);
  assert.match(html, /min-width:900px/);
  // 单行成员不需要下移（既有几何零变化）。
  assert.doesNotMatch(html, /transform="translate\(0 /);
});
