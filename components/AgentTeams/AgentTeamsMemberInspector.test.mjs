import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * C7 成员检查器的回归守卫（对抗验证 M3 点名：此前零测试）。
 *
 * 用 SSR（renderToStaticMarkup）断言面板真的把「角色 / 状态 / 模型 / provider / 票史 /
 * 消息」渲染了出来；交互回调（打开其会话）无法在 SSR 里点击，按本仓既有做法用源码断言
 * 钉住「以 member.sessionId 调用 onOpenSession」这条接线。
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

const message = (id, from, to, text, timestamp) => ({
  id, from, to, recipients: to ? [to] : [], kind: "direct", text, timestamp,
});

function render(props) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(AgentTeamsMemberInspector, props),
  ));
}

test("渲染成员详情：名字 / 角色 / 状态 / 模型 / provider / 会话 id", () => {
  const html = render({
    snapshot: snapshot(),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-inspector"/);
  assert.match(html, /data-member-id="impl"/);
  assert.match(html, /impl/);
  // 角色走 i18n（teams.role.member → "Member"），不是原样 role 字符串。
  assert.match(html, /Member/);
  // 状态（teams.status.idle → "Idle"）。
  assert.match(html, /Idle/);
  assert.match(html, /m1/);
  assert.match(html, /p1/);
  assert.match(html, /s-impl/);
});

test("无会话时显示空态文案，而不是留空", () => {
  const html = render({
    snapshot: snapshot(),
    member: member({ sessionId: null }),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /No session yet/);
});

test("执行历史：只列名下票，渲染标题行与票主题", () => {
  const html = render({
    snapshot: snapshot({
      tickets: [
        ticket("t1", { subject: "Do thing" }),
        ticket("t2", { subject: "Not mine", ownerId: "other" }),
      ],
      members: [member(), member({ id: "other", name: "other" })],
    }),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-task-history"/);
  assert.match(html, /data-testid="agent-teams-member-task-t1"/);
  assert.match(html, /Do thing/);
  assert.doesNotMatch(html, /Not mine/, "别人名下的票不该出现在本成员的执行历史里");
});

test("无票时显示稳定的空态文案", () => {
  const html = render({
    snapshot: snapshot({ tickets: [] }),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /No tasks assigned yet/);
  assert.doesNotMatch(html, /data-testid="agent-teams-member-task-history"/);
});

test("消息：渲染收发方向与正文（含广播），无消息时空态", () => {
  const html = render({
    snapshot: snapshot({
      messages: [
        message("m1", "lead", "impl", "hello there", "2026-01-01T00:00:02.000Z"),
        message("m2", "impl", "*", "done", "2026-01-01T00:00:03.000Z"),
      ],
    }),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-messages"/);
  assert.match(html, /data-message-direction="received"/);
  assert.match(html, /data-message-direction="sent"/);
  assert.match(html, /hello there/);
  assert.match(html, /done/);

  const empty = render({
    snapshot: snapshot({ messages: [] }),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(empty, /No messages yet/);
  assert.doesNotMatch(empty, /data-testid="agent-teams-member-messages"/);
});

test("lastError 存在时单独渲染错误块", () => {
  const html = render({
    snapshot: snapshot(),
    member: member({ lastError: "boom" }),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-last-error"/);
  assert.match(html, /boom/);
});

test("队长标记只在 isLead 时出现", () => {
  const asLead = render({
    snapshot: snapshot(),
    member: member(),
    isLead: true,
    onBack: () => {},
    onOpenSession: () => {},
  });
  const asMember = render({
    snapshot: snapshot(),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(asLead, /Lead/);
  assert.doesNotMatch(asMember, /Lead/);
});

test("「打开其会话」按钮：文本含成员名，接线以 sessionId 调用 onOpenSession", async () => {
  const html = render({
    snapshot: snapshot(),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-open-session"/);
  assert.match(html, /Open impl/);
  assert.doesNotMatch(html, /disabled/, "有会话且有回调时按钮可用");

  // 交互回调在 SSR 里点不到：用源码断言钉住接线（本仓既有做法）。
  const source = await readFile(new URL("./AgentTeamsMemberInspector.tsx", import.meta.url), "utf8");
  assert.match(source, /onOpenSession\?\.\(member\.sessionId\)/, "必须把成员的 sessionId 交给 onOpenSession");
  assert.match(source, /disabled=\{!member\.sessionId \|\| !onOpenSession\}/, "无会话/无回调时禁用");
});