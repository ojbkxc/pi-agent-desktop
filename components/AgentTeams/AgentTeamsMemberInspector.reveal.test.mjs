import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 成员检查器 T5 增强守卫：模型继承/未知、上下文超限提示、failed 独立分组、
 * find 标记、消息渐进披露「显示更早」、跨帧耗时。
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentTeamsMemberInspector } = await jiti.import("./AgentTeamsMemberInspector.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function member(overrides = {}) {
  return {
    id: "impl",
    name: "impl",
    role: "member",
    model: "m1",
    providerName: "p1",
    color: "blue",
    status: "idle",
    activity: "idle",
    isLead: false,
    sessionId: "s-impl",
    cwd: "/work",
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
    ownerId: "impl",
    status: "open",
    dependencies: [],
    assignments: [],
    source: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function assignment(status, overrides = {}) {
  return {
    id: "a1",
    status,
    memberId: "impl",
    assignee: "impl",
    sessionId: "s-impl",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    result: null,
    outcome: null,
    ...overrides,
  };
}

function snapshot({ tickets = [], messages = [], members = [member()] } = {}) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    team: { id: "t", name: "Team", description: "", createdAt: "2026-01-01T00:00:00.000Z", leadSessionId: null, status: "running", incarnationId: "t" },
    members,
    tickets,
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
    messages,
  };
}

const message = (id, from, to, text, timestamp, overrides = {}) => ({
  id, from, to, recipients: to ? [to] : [], kind: "direct", text, timestamp, ...overrides,
});

function render(props) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(AgentTeamsMemberInspector, props),
  ));
}

const base = (snap, extra = {}) => ({
  snapshot: snap,
  member: member(),
  isLead: false,
  onBack: () => {},
  onOpenSession: () => {},
  ...extra,
});

test("模型继承：member.model 空 → 显示「继承自队长」+ 名册队长模型", () => {
  const lead = member({ id: "lead", name: "team-lead", isLead: true, status: "running", model: "lead-model" });
  const html = render(base(snapshot({ members: [lead, member({ model: null })] }), { member: member({ model: null }) }));
  assert.match(html, /data-testid="agent-teams-member-model"[^>]*>Inherited from lead · lead-model</);
});

test("模型继承：member.model === 'inherit' 同样按继承处理", () => {
  const lead = member({ id: "lead", name: "team-lead", isLead: true, status: "running", model: "lead-model" });
  const html = render(base(snapshot({ members: [lead, member({ model: "inherit" })] }), { member: member({ model: "inherit" }) }));
  assert.match(html, /data-testid="agent-teams-member-model"[^>]*>Inherited from lead · lead-model</);
});

test("模型未知：继承但队长模型也未知 → 显示「模型未知」", () => {
  const lead = member({ id: "lead", name: "team-lead", isLead: true, status: "running", model: null });
  const html = render(base(snapshot({ members: [lead, member({ model: null })] }), { member: member({ model: null }) }));
  assert.match(html, /data-testid="agent-teams-member-model"[^>]*>Model unknown</);
});

test("上下文超限：lastError 命中 prompt is too long → 提示 /compact，且压过通用恢复提示", () => {
  const html = render(base(snapshot(), {
    member: member({ status: "failed", lastError: "API error: prompt is too long: 200000 tokens > 128000" }),
  }));
  assert.match(html, /data-testid="agent-teams-member-recovery-hint"[^>]*>[^<]*\/compact/);
  assert.doesNotMatch(html, /Send a message or restart/, "上下文超限时不得显示通用 errorHint");
});

test("failed 票独立分组：不计入 completed，单独「失败」组", () => {
  const html = render(base(snapshot({
    tickets: [ticket("t-fail", { status: "ended", assignments: [assignment("ended", { outcome: "failed" })] })],
  })));
  assert.match(html, /data-testid="agent-teams-member-task-group-failed"/);
  assert.match(html, /data-testid="agent-teams-member-task-t-fail"/);
  assert.doesNotMatch(html, /data-testid="agent-teams-member-task-group-completed"/, "失败票不进已完成分组");
  // 标题完成数 0/1（失败不算完成）。
  assert.match(html, /0\/1/);
});

test("消息列表带 find 标记：ol=data-find-transcript，li=data-find-row", () => {
  const html = render(base(snapshot({
    messages: [message("m1", "lead", "impl", "hello", "2026-01-01T00:00:02.000Z")],
  })));
  assert.match(html, /data-testid="agent-teams-member-messages"[^>]*data-find-transcript=""/);
  assert.match(html, /data-testid="agent-teams-member-message-m1"[^>]*data-find-row="m1"/);
});

test("消息渐进披露：超过一页时底部出现「显示更早」按钮，最旧的行暂不挂载", () => {
  const messages = Array.from({ length: 45 }, (_, index) => message(
    `m${String(index).padStart(2, "0")}`,
    "lead",
    "impl",
    `msg ${index}`,
    new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  ));
  const html = render(base(snapshot({ messages })));
  assert.match(html, /data-testid="agent-teams-member-show-earlier"/);
  // 45 条、每页 40 → 底部显示「还有 5 条更早」。
  assert.match(html, /Show 5 earlier/);
  // 最新的一条挂载、最旧的一条（第 0 条）暂不挂载。
  assert.match(html, /data-testid="agent-teams-member-message-m44"/);
  assert.doesNotMatch(html, /data-testid="agent-teams-member-message-m00"/, "最旧行应留到「显示更早」之后");
});

test("跨帧耗时：提供历史快照时任务行右侧显示耗时", () => {
  const snaps = [
    {
      ...snapshot(),
      generatedAt: "2026-01-01T00:00:10.000Z",
      tickets: [ticket("t1", { status: "open", createdAt: "2026-01-01T00:00:00.000Z" })],
    },
    {
      ...snapshot(),
      generatedAt: "2026-01-01T00:01:00.000Z",
      tickets: [ticket("t1", { status: "ended", createdAt: "2026-01-01T00:00:00.000Z" })],
    },
  ];
  const html = render(base(snapshot({ tickets: [ticket("t1", { status: "ended" })] }), {
    snapshots: snaps,
    selectedIndex: 1,
  }));
  assert.match(html, /data-testid="agent-teams-member-task-t1-duration"[^>]*>Took 1m 0s</);
});

test("无历史快照：不渲染耗时", () => {
  const html = render(base(snapshot({ tickets: [ticket("t1", { status: "ended" })] })));
  assert.doesNotMatch(html, /agent-teams-member-task-t1-duration/);
});
