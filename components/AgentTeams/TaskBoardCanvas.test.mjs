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
} = await jiti.import("./TaskBoardCanvas.tsx");
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
