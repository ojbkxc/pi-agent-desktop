import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TaskBoardCanvas } = await jiti.import("./TaskBoardCanvas.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function assignment(over = {}) {
  return {
    id: "a1",
    status: "pending",
    memberId: "m-impl",
    assignee: "impl",
    sessionId: null,
    startedAt: null,
    lastActivityAt: null,
    result: null,
    outcome: null,
    ...over,
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

function member(id, status = "running", name = id) {
  return {
    id,
    name,
    role: "worker",
    model: null,
    providerName: null,
    color: "blue",
    status,
    activity: "active",
    isLead: false,
    sessionId: null,
    cwd: "",
    worktreePath: null,
    lastError: null,
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

function snapshot(tickets, members = [member("m-impl")], messages = []) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    team: { memberId: null, assignee: "lead", sessionId: null, startedAt: null, result: null, outcome: null },
    members,
    tickets,
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
    messages,
    messagesTruncated: false,
  };
}

const render = (snap, props = {}) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: "en" },
  React.createElement(TaskBoardCanvas, { snapshot: snap, ...props }),
));

/** 取出某张任务卡的属性片段（到下一个 > 为止）。 */
function cardTag(html, id) {
  const start = html.indexOf(`data-ticket-id="${id}"`);
  assert.ok(start >= 0, `找到任务卡 ${id}`);
  const open = html.lastIndexOf("<", start);
  const close = html.indexOf(">", start);
  return html.slice(open, close + 1);
}

test("依赖链聚焦：链内 data-chain-active，链外 data-chain-dimmed", () => {
  const snap = snapshot([
    ticket("t1"),
    ticket("t2", { dependencies: ["t1"] }),
    ticket("t3", { dependencies: ["t2"] }),
    ticket("t9"),
  ]);
  const html = render(snap, { focusedTicketId: "t2" });
  assert.equal(cardTag(html, "t1").includes('data-chain-active="true"'), true);
  assert.equal(cardTag(html, "t2").includes('data-chain-active="true"'), true);
  assert.equal(cardTag(html, "t3").includes('data-chain-active="true"'), true);
  assert.equal(cardTag(html, "t9").includes('data-chain-dimmed="true"'), true);
});

test("无 focus 时任务卡不输出 data-chain-*", () => {
  const snap = snapshot([ticket("t1"), ticket("t2", { dependencies: ["t1"] })]);
  const html = render(snap);
  assert.doesNotMatch(html, /data-chain-active/);
  assert.doesNotMatch(html, /data-chain-dimmed/);
});

test("依赖边随链路高亮 / 变暗", () => {
  const snap = snapshot([
    ticket("t1"),
    ticket("t2", { dependencies: ["t1"] }),
    ticket("t3", { dependencies: ["t1"] }),
  ]);
  // focus t2：t1→t2 在链内，t1→t3 变暗
  const html = render(snap, { focusedTicketId: "t2" });
  const edges = html.match(/<path[^>]*agent-teams-board-edge[^>]*>/g) ?? [];
  const active = edges.filter((edge) => edge.includes('data-chain-active="true"'));
  const dimmed = edges.filter((edge) => edge.includes('data-chain-dimmed="true"'));
  assert.equal(active.length, 1, "只有 t1→t2 这条链内边高亮");
  assert.equal(dimmed.length, 1, "t1→t3 变暗");
});

test("进度条：只有 running 派活 → data-progress=indeterminate", () => {
  const snap = snapshot([ticket("t1", { assignments: [assignment({ status: "running" })] })]);
  const html = render(snap);
  assert.match(html, /data-progress="indeterminate"/);
});

test("进度条：有 ended + running → determinate 并输出百分比", () => {
  const snap = snapshot([ticket("t1", {
    assignments: [
      assignment({ id: "a1", status: "ended", outcome: "completed" }),
      assignment({ id: "a2", status: "running" }),
    ],
  })]);
  const html = render(snap);
  assert.match(html, /data-progress="determinate"/);
  assert.match(html, /data-percent="50"/);
});

test("停滞徽标：running 派活的成员 failed → data-stalled", () => {
  const snap = snapshot(
    [ticket("t1", { assignments: [assignment({ status: "running", memberId: "m-impl" })] })],
    [member("m-impl", "failed")],
  );
  const html = render(snap);
  assert.match(html, /data-stalled="true"/);
});

test("刚解锁：上一帧 blocked、本帧 available → data-just-unlocked + class", () => {
  const before = snapshot([
    ticket("dep", { status: "open" }),
    ticket("t2", { dependencies: ["dep"] }),
  ]);
  const now = snapshot([
    ticket("dep", { status: "ended", assignments: [assignment({ status: "ended", outcome: "completed" })] }),
    ticket("t2", { dependencies: ["dep"] }),
  ]);
  const html = render(now, { previousSnapshot: before });
  const tag = cardTag(html, "t2");
  assert.equal(tag.includes('data-just-unlocked="true"'), true);
  assert.equal(tag.includes("agent-teams-board-task--unlocked"), true);
});

test("未解锁的票不输出 data-just-unlocked（无上一帧）", () => {
  const snap = snapshot([ticket("t1")]);
  const html = render(snap);
  assert.doesNotMatch(html, /data-just-unlocked/);
});

test("底部图例：6 项，带 data-testid 与固定 key", () => {
  const html = render(snapshot([ticket("t1")]));
  assert.match(html, /data-testid="agent-teams-legend"/);
  const items = html.match(/class="agent-teams-legend-item"/g) ?? [];
  assert.equal(items.length, 6, "图例恰好 6 项");
  for (const key of ["unmet", "satisfied", "running", "failed", "cycle", "flight"]) {
    assert.match(html, new RegExp(`data-legend="${key}"`));
  }
});
