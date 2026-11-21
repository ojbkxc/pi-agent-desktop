import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 任务详情 T6 增强守卫：推断负责人徽标、停滞负责人、依赖/解锁票可点击。
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentTeamTaskDetailBody } = await jiti.import("./AgentTeamTaskDetail.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function member(id, name, overrides = {}) {
  return {
    id, name, role: "member", model: null, providerName: null, color: "blue",
    status: "running", activity: "active", isLead: false, sessionId: null,
    cwd: "", worktreePath: null, lastError: null, joinedAt: "2026-01-01T00:00:00.000Z",
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

function assignment(memberId, overrides = {}) {
  return {
    id: `as-${memberId}`,
    status: "running",
    memberId,
    assignee: memberId,
    sessionId: null,
    startedAt: null,
    lastActivityAt: null,
    result: null,
    outcome: null,
    ...overrides,
  };
}

function snapshot({ tickets = [], members = [], messages = [] } = {}) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    team: { id: "t", name: "Team", description: "", createdAt: "2026-01-01T00:00:00.000Z", leadSessionId: null, status: "running", incarnationId: "t" },
    members, tickets, lanes: [], flows: [], taskAnchors: [], tasks: [], receipts: [], messages,
  };
}

function render(props) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(AgentTeamTaskDetailBody, props),
  ));
}

test("推断负责人：ownerId 缺失但 assignments 回填 → 显示徽标与负责人名", () => {
  const html = render({
    snapshot: snapshot({
      members: [member("impl", "impl")],
      tickets: [ticket("t1", { ownerId: null, assignments: [assignment("impl")] })],
    }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(html, /data-testid="agent-teams-task-inferred-owner"[^>]*>Inferred owner</);
  assert.match(html, />impl</);
});

test("显式 owner 不显示推断徽标", () => {
  const html = render({
    snapshot: snapshot({
      members: [member("impl", "impl")],
      tickets: [ticket("t1", { ownerId: "impl" })],
    }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.doesNotMatch(html, /data-testid="agent-teams-task-inferred-owner"/);
});

test("显式空 owner 不回填：assignments 存在也显示「未指派」且无推断徽标", () => {
  const html = render({
    snapshot: snapshot({
      members: [member("impl", "impl")],
      tickets: [ticket("t1", { ownerId: "", assignments: [assignment("impl")] })],
    }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(html, /Unassigned/);
  assert.doesNotMatch(html, /data-testid="agent-teams-task-inferred-owner"/);
});

test("停滞负责人：负责人 status=failed/parked/aborted 时显示停滞提示", () => {
  const html = render({
    snapshot: snapshot({
      members: [member("impl", "impl", { status: "parked", activity: "idle" })],
      tickets: [ticket("t1", { ownerId: "impl" })],
    }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.match(html, /data-testid="agent-teams-task-stalled-owner"[^>]*>Owner is not working</);
});

test("负责人仍在工作时不显示停滞提示", () => {
  const html = render({
    snapshot: snapshot({
      members: [member("impl", "impl", { status: "running" })],
      tickets: [ticket("t1", { ownerId: "impl" })],
    }),
    ticketId: "t1",
    onClose: () => {},
    onSelectMember: () => {},
  });
  assert.doesNotMatch(html, /data-testid="agent-teams-task-stalled-owner"/);
});

test("依赖 / 解锁的票 id 渲染成可点击按钮，带 jumpTo aria-label", () => {
  const tickets = [
    ticket("t0", { subject: "root" }),
    ticket("t1", { ownerId: null, dependencies: ["t0"] }),
    ticket("t2", { dependencies: ["t1"] }),
  ];
  const html = render({
    snapshot: snapshot({ tickets }),
    ticketId: "t1",
    onClose: () => {},
    onSelectTicket: () => {},
  });
  assert.match(html, /<button[^>]*data-jump-ticket="t0"[^>]*aria-label="Open #t0"/);
  assert.match(html, /<button[^>]*data-jump-ticket="t2"[^>]*aria-label="Open #t2"/);
  assert.doesNotMatch(html, /<button[^>]*data-jump-ticket="t0"[^>]*disabled/, "有回调时按钮可点");
});

test("未传 onSelectTicket：依赖/解锁按钮禁用（仍渲染 id）", () => {
  const html = render({
    snapshot: snapshot({ tickets: [ticket("t0"), ticket("t1", { dependencies: ["t0"] })] }),
    ticketId: "t1",
    onClose: () => {},
  });
  assert.match(html, /<button[^>]*data-jump-ticket="t0"[^>]*disabled/);
  assert.match(html, /#t0/);
});
