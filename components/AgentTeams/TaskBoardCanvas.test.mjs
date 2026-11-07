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
} = await jiti.import("@/lib/agent-teams-task-layout.ts");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (snapshot) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  null,
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

test("taskToneClass maps engine states to the board's colour classes", () => {
  const open = ticket("t1");
  assert.equal(taskToneClass(open, "in_progress"), "agent-teams-board-task--running");
  assert.equal(taskToneClass(open, "completed"), "agent-teams-board-task--completed");
  assert.equal(taskToneClass(open, "blocked"), "agent-teams-board-task--blocked");
  assert.equal(taskToneClass(open, "available"), "agent-teams-board-task--available");
});

test("taskToneClass shows a failed assignment as the error tone, not completed", () => {
  const failed = ticket("t1", { status: "ended", assignments: [assignment("ended", "failed")] });
  assert.equal(taskToneClass(failed, "completed"), "agent-teams-board-task--failed");
  const completed = ticket("t2", { status: "ended", assignments: [assignment("ended", "completed")] });
  assert.equal(taskToneClass(completed, "completed"), "agent-teams-board-task--completed");
});

test("laneTitleKey labels root, intermediate and wrap-up layers", () => {
  assert.equal(laneTitleKey(0, 2), "teams.boardRoot");
  assert.equal(laneTitleKey(1, 2), "teams.boardLayer");
  assert.equal(laneTitleKey(2, 2), "teams.boardWrapUp");
  // Single layer: the root label wins over wrap-up, matching cc-haha.
  assert.equal(laneTitleKey(0, 0), "teams.boardRoot");
});

test("countTaskStates is mutually exclusive and treats missing dependencies as resolved", () => {
  const tickets = [
    ticket("t1", { status: "ended", assignments: [assignment("ended", "completed")] }),
    ticket("t2", { assignments: [assignment("running")] }),
    ticket("t3", { dependencies: ["t1"] }),
    ticket("t4", { dependencies: ["t2"] }),
    ticket("t5", { dependencies: ["missing"] }),
  ];
  assert.deepEqual(countTaskStates(tickets), {
    completed: 1,
    in_progress: 1,
    available: 2,
    blocked: 1,
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
