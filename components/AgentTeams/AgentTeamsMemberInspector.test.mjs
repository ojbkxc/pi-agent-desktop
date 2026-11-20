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
 *
 * 对齐 cc-haha 之后新增/加强的守卫：
 * - 身份别名匹配：name@team / agentId 形态也能收发命中（旧实现只按裸名精确匹配会漏）；
 * - 协议 JSON 叙述：生命周期消息渲染成句子，不再原样倾倒花括号；
 * - 方向色：sent=var(--info) / received=var(--accent) 左边框；
 * - 状态推导 + 恢复提示；
 * - 任务历史三分组（运行中 / 未开始 / 已完成）。
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

/** 取 HTML 中从 `from` 标记到 `to` 标记之间的片段，用于断言票落在哪个分组里。 */
function sliceBetween(html, from, to) {
  const start = html.indexOf(from);
  if (start < 0) return "";
  const end = to ? html.indexOf(to, start + from.length) : html.length;
  return html.slice(start, end < 0 ? html.length : end);
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
  // 状态改为推导口径：空闲且无票 → 「等待派活」。
  assert.match(html, /data-testid="agent-teams-member-status"[^>]*>Waiting for a task</);
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

test("任务历史三分组：运行中 / 未开始（blocked+available）/ 已完成（completed+failed）", () => {
  const html = render({
    snapshot: snapshot({
      tickets: [
        ticket("t-run", { assignments: [assignment("running")] }),
        ticket("t-avail"),
        ticket("t-done", { status: "ended", assignments: [assignment("ended", { outcome: "completed" })] }),
      ],
    }),
    member: member({ status: "running" }),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-task-group-running"/);
  assert.match(html, /data-testid="agent-teams-member-task-group-upcoming"/);
  assert.match(html, /data-testid="agent-teams-member-task-group-completed"/);

  // TASK_GROUPS 顺序：running → upcoming → completed。逐段核对票归属。
  const running = sliceBetween(html, "agent-teams-member-task-group-running", "agent-teams-member-task-group-upcoming");
  assert.match(running, /agent-teams-member-task-t-run/);
  assert.doesNotMatch(running, /agent-teams-member-task-t-avail|agent-teams-member-task-t-done/);
  const upcoming = sliceBetween(html, "agent-teams-member-task-group-upcoming", "agent-teams-member-task-group-completed");
  assert.match(upcoming, /agent-teams-member-task-t-avail/);
  assert.doesNotMatch(upcoming, /agent-teams-member-task-t-run|agent-teams-member-task-t-done/);
  const completed = sliceBetween(html, "agent-teams-member-task-group-completed");
  assert.match(completed, /agent-teams-member-task-t-done/);
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

test("身份别名匹配：name@team / agentId 形态也能收发命中（旧实现按裸名精确匹配会漏）", () => {
  // 成员 name=worker，id=worker@demo：消息用 agentId 形态与短名形态出现都应命中。
  const html = render({
    snapshot: snapshot({
      members: [member({ id: "worker@demo", name: "worker" })],
      messages: [
        message("by-agentid", "worker@demo", "team-lead", "sent via agentId", "2026-01-01T00:00:01.000Z"),
        message("to-agentid", "team-lead", "worker@demo", "received via agentId", "2026-01-01T00:00:02.000Z"),
      ],
    }),
    member: member({ id: "worker@demo", name: "worker" }),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /sent via agentId/);
  assert.match(html, /received via agentId/);
  assert.match(html, /data-testid="agent-teams-member-message-by-agentid"[^>]*data-message-direction="sent"/);
  assert.match(html, /data-testid="agent-teams-member-message-to-agentid"[^>]*data-message-direction="received"/);
});

test("协议 JSON 叙述：生命周期消息渲染成句子，不透出原始花括号", () => {
  const idleJson = JSON.stringify({ type: "idle_notification", message: "等待派活" });
  const html = render({
    snapshot: snapshot({
      messages: [
        message("proto", "impl", "team-lead", idleJson, "2026-01-01T00:00:01.000Z", { protocolType: "idle_notification" }),
      ],
    }),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-message-proto"[^>]*data-message-body="lifecycle"/);
  // 叙述 = 词条 + 「· detail」，绝不出现 JSON 花括号。
  assert.match(html, /Idle · 等待派活/);
  assert.doesNotMatch(html, /\{"type"/, "不得原样倾倒协议 JSON");
});

test("方向色：sent 左边框 var(--info)，received 左边框 var(--accent)", () => {
  const html = render({
    snapshot: snapshot({
      messages: [
        message("out", "impl", "team-lead", "outgoing", "2026-01-01T00:00:01.000Z"),
        message("in", "team-lead", "impl", "incoming", "2026-01-01T00:00:02.000Z"),
      ],
    }),
    member: member(),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  const outgoing = sliceBetween(html, 'data-testid="agent-teams-member-message-out"', 'data-testid="agent-teams-member-message-in"');
  assert.match(outgoing, /border-left:2px solid var\(--info\)/);
  const incoming = sliceBetween(html, 'data-testid="agent-teams-member-message-in"');
  assert.match(incoming, /border-left:2px solid var\(--accent\)/);
});

test("状态推导：运行中且有运行票 → 正在执行该票", () => {
  const html = render({
    snapshot: snapshot({ tickets: [ticket("t9", { assignments: [assignment("running")] })] }),
    member: member({ status: "running" }),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-status"[^>]*>Executing task #t9</);
});

test("状态推导：空闲且名下票全完成 → 等待收尾", () => {
  const html = render({
    snapshot: snapshot({ tickets: [ticket("t1", { status: "ended", assignments: [assignment("ended", { outcome: "completed" })] })] }),
    member: member({ status: "idle" }),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-status"[^>]*>All tasks done — waiting to close</);
});

test("状态推导：挂起且停在运行票上 → stalledOnTask + 停止恢复提示", () => {
  const html = render({
    snapshot: snapshot({ tickets: [ticket("t5", { assignments: [assignment("running")] })] }),
    member: member({ status: "parked" }),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  // {state} 用成员状态词条（teams.status.parked → "Parked"），并点明卡在哪张票。
  assert.match(html, /data-testid="agent-teams-member-status"[^>]*>Parked — stuck on task #t5</);
  assert.match(html, /data-testid="agent-teams-member-recovery-hint"/);
  assert.match(html, /send a message to wake it up/);
});

test("状态推导：失败 → errorHint + lastError 同时如实带出", () => {
  const html = render({
    snapshot: snapshot(),
    member: member({ status: "failed", lastError: "boom" }),
    isLead: false,
    onBack: () => {},
    onOpenSession: () => {},
  });
  assert.match(html, /data-testid="agent-teams-member-recovery-hint"/);
  assert.match(html, /Send a message or restart/);
  assert.match(html, /data-testid="agent-teams-member-last-error"[^>]*>Last error: boom</);
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
