import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * C6 团队通信流组件（AgentTeamsCommunicationFeed）静态渲染断言。
 *
 * 纯客户端交互（点击过滤器、悬停联动）无法在 renderToStaticMarkup 里驱动，这里断言
 * 结构性产物：4 分类落到 data-message-category、相邻同类生命周期折叠 ×N、两种行形态
 * （紧凑/完整）、最新一条的左侧竖条、空态、Markdown 长文折叠开关。
 *
 * ⚠️ 不断言任何翻译后的文案：teams.communication.* 的词条由 lead 统一添加，本测试只认
 * data-* 属性与 testid，这样词条未落地时也不会误红。
 */
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AgentTeamsCommunicationFeed } = await jiti.import("./AgentTeamsCommunicationFeed.tsx");
const { memberOpenHandler } = await jiti.import("./agent-teams-feed-model.ts");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (snapshot, extraProps = {}) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: "en" },
  React.createElement(AgentTeamsCommunicationFeed, { snapshot, ...extraProps }),
));

function member(id, overrides = {}) {
  return {
    id,
    name: id,
    role: "member",
    model: null,
    providerName: null,
    color: "blue",
    status: "idle",
    activity: "idle",
    isLead: false,
    sessionId: `${id}-session`,
    cwd: "",
    worktreePath: null,
    lastError: null,
    joinedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

/** 通信流只读 messages 与 members，其余字段给最小合法值。 */
function snapshot(messages, members, overrides = {}) {
  return {
    version: 1,
    generatedAt: "2026-11-05T03:00:00.000Z",
    team: {
      id: "demo",
      name: "demo",
      description: "",
      createdAt: "2026-11-05T00:00:00.000Z",
      leadSessionId: "lead-session",
      status: "running",
      incarnationId: "inc",
    },
    members,
    tickets: [],
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
    messages,
    messagesTruncated: false,
    ...overrides,
  };
}

const LEAD = member("lead-1", { name: "team-lead", role: "orchestrator", color: "gray", status: "running", isLead: true, sessionId: "lead-session" });
const W1 = member("w1");
const W2 = member("w2");

const idleJson = JSON.stringify({ type: "idle_notification", message: "等待派活" });

function baseMessages() {
  return [
    { id: "m1", from: "team-lead", to: "w1", recipients: ["w1"], kind: "direct", text: "开始实现", timestamp: "2026-11-05T01:00:00.000Z" },
    { id: "m2", from: "w1", to: "team-lead", recipients: ["team-lead"], kind: "direct", text: "做完了", timestamp: "2026-11-05T02:00:00.000Z" },
    { id: "m3", from: "w1", to: "w2", recipients: ["w2"], kind: "direct", text: "看下这个", timestamp: "2026-11-05T03:00:00.000Z" },
    { id: "m4", from: "w1", to: "team-lead", recipients: ["team-lead"], kind: "direct", text: idleJson, protocolType: "idle_notification", timestamp: "2026-11-05T04:00:00.000Z" },
    { id: "m5", from: "w1", to: "team-lead", recipients: ["team-lead"], kind: "direct", text: idleJson, protocolType: "idle_notification", timestamp: "2026-11-05T05:00:00.000Z" },
    { id: "m6", from: "team-lead", to: "w1", recipients: ["w1"], kind: "direct", text: "请实现 X", taskId: "T1", timestamp: "2026-11-05T06:00:00.000Z" },
  ];
}

test("头部：容器、计数与 5 个过滤器（带分类计数）", () => {
  const html = render(snapshot(baseMessages(), [LEAD, W1, W2]));
  assert.match(html, /data-testid="agent-teams-communication"/);
  assert.match(html, /data-testid="agent-teams-message-count"/);
  assert.match(html, /data-testid="agent-teams-filter-all"[^>]*data-count="6"/);
  assert.match(html, /data-testid="agent-teams-filter-assignment"[^>]*data-count="2"/);
  assert.match(html, /data-testid="agent-teams-filter-report"[^>]*data-count="1"/);
  assert.match(html, /data-testid="agent-teams-filter-peer"[^>]*data-count="1"/);
  assert.match(html, /data-testid="agent-teams-filter-system"[^>]*data-count="2"/);
});

test("4 分类判据：lead→成员=assignment、成员→lead=report、成员→成员=peer、生命周期=system", () => {
  const html = render(snapshot(baseMessages(), [LEAD, W1, W2]));
  assert.match(html, /data-testid="agent-teams-message-m6"[^>]*data-message-category="assignment"/);
  assert.match(html, /data-testid="agent-teams-message-m2"[^>]*data-message-category="report"/);
  assert.match(html, /data-testid="agent-teams-message-m3"[^>]*data-message-category="peer"/);
  assert.match(html, /data-testid="agent-teams-message-m5"[^>]*data-message-category="system"/);
});

test("相邻同类生命周期消息折叠：保留较新的一条并计 ×2，旧的一条不再渲染", () => {
  const html = render(snapshot(baseMessages(), [LEAD, W1, W2]));
  assert.match(html, /data-testid="agent-teams-message-m5-repeats"[^>]*>×2</);
  assert.doesNotMatch(html, /data-testid="agent-teams-message-m4"/, "被折叠的 m4 不应渲染");
});

test("两种行形态：文本消息=完整行（有路由与箭头），协议消息=紧凑行（无路由）", () => {
  const html = render(snapshot(baseMessages(), [LEAD, W1, W2]));
  // m6 是文本派工：完整行，带 from→to 路由与 #T1 任务 chip，且是最新一条（左侧蓝条）。
  assert.match(html, /data-testid="agent-teams-message-m6"[^>]*data-message-body="text"/);
  assert.match(html, /data-testid="agent-teams-message-m6-route"/);
  assert.match(html, /data-testid="agent-teams-message-m6-from"/);
  assert.match(html, /data-testid="agent-teams-message-m6-to"/);
  assert.match(html, /#T1/);
  assert.match(html, /bg-\[var\(--info\)\]/, "最新一条左侧蓝色竖条");
  // m5 是生命周期：紧凑行，无路由。
  assert.match(html, /data-testid="agent-teams-message-m5"[^>]*data-message-body="lifecycle"/);
  assert.doesNotMatch(html, /data-testid="agent-teams-message-m5-route"/);
});

test("Markdown 长文折叠：>260 字有折叠开关，短文无", () => {
  const long = "x".repeat(300);
  const html = render(snapshot([
    { id: "m-short", from: "team-lead", to: "w1", recipients: ["w1"], kind: "direct", text: "短消息", timestamp: "2026-11-05T01:00:00.000Z" },
    { id: "m-long", from: "team-lead", to: "w1", recipients: ["w1"], kind: "direct", text: long, timestamp: "2026-11-05T02:00:00.000Z" },
  ], [LEAD, W1]));
  assert.match(html, /data-testid="agent-teams-message-m-long-body"[^>]*data-collapsed="true"/);
  assert.match(html, /data-testid="agent-teams-message-m-long-toggle"/);
  assert.match(html, /data-testid="agent-teams-message-m-short-body"[^>]*data-collapsed="false"/);
  assert.doesNotMatch(html, /data-testid="agent-teams-message-m-short-toggle"/);
});

test("空态：无消息时渲染空态且无消息行", () => {
  const html = render(snapshot([], [LEAD, W1]));
  assert.match(html, /data-testid="agent-teams-empty"/);
  assert.doesNotMatch(html, /data-find-row=/, "空态不应有任何消息行");
  assert.match(html, /data-testid="agent-teams-filter-all"[^>]*data-count="0"/);
});

// ── A-9：时间戳必须跟随应用语言（不是 OS locale）──────────────────────────────
// 原实现 `toLocaleTimeString([], ...)` 传空数组 = 跟随系统语言，与仓库
// 「Dates follow the app language, not the OS locale」规则相反。
test("消息时间跟随应用语言：en 与 zh-CN 渲染出的时间戳来自各自 locale", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(new URL("./AgentTeamsCommunicationFeed.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(source, /formatUpdatedTime\(time\.getTime\(\), locale\)/, "时间必须按应用 locale 格式化");
  assert.doesNotMatch(source, /toLocaleTimeString\(\[\]/, "不得再跟随 OS locale");
  // locale 从 useI18n 取，并一路传到 rows 与 FeedRow。
  assert.match(source, /const \{ t, locale \} = useI18n\(\)/);
  assert.match(source, /feedRowFindText\(row, t, locale\)/);
  assert.match(source, /locale=\{locale\}/);
});

// ── 截断提示：messagesTruncated 时在过滤器行下方显示一条低调提示 ─────────────────
test("截断提示：messagesTruncated=true 时渲染提示行，false 时不渲染", () => {
  const truncated = render(snapshot(baseMessages(), [LEAD, W1, W2], { messagesTruncated: true }));
  assert.match(truncated, /data-testid="agent-teams-truncated"/, "截断时应有提示行");
  // 提示行位于过滤器组之后（过滤器行下方），而不是挤在标题行里。
  const filterIdx = truncated.indexOf('agent-teams-filter-system');
  const truncIdx = truncated.indexOf('agent-teams-truncated');
  assert.ok(truncIdx > filterIdx, "截断提示应在过滤器行之后");

  const full = render(snapshot(baseMessages(), [LEAD, W1, W2], { messagesTruncated: false }));
  assert.doesNotMatch(full, /data-testid="agent-teams-truncated"/, "未截断时不应有提示行");
});

// ── 参与者可点：解析到 roster 成员且有 sessionId 时渲染为按钮 ───────────────────
function routeMessage(from, to) {
  return [{ id: "mm", from, to, recipients: [to], kind: "direct", text: "正文", timestamp: "2026-11-05T01:00:00.000Z" }];
}

test("参与者可点：可解析且有 sessionId 的发送者名字渲染成带 aria-label 的按钮", () => {
  const html = render(
    snapshot(routeMessage("team-lead", "w1"), [LEAD, W1]),
    { onOpenMember: () => {} },
  );
  // 发送者 team-lead 能解析到 LEAD（sessionId=lead-session）→ button。
  assert.match(html, /<button[^>]*data-testid="agent-teams-message-mm-from"/, "可解析的发送者应渲染成按钮");
  assert.match(html, /data-testid="agent-teams-message-mm-from"[^>]*aria-label="Open team-lead"/, "按钮带 openMember aria-label");
  // 接收者 w1 能解析到 W1 → 也是按钮。
  assert.match(html, /<button[^>]*data-testid="agent-teams-message-mm-to"/, "可解析的接收者应渲染成按钮");
  assert.match(html, /data-testid="agent-teams-message-mm-to"[^>]*aria-label="Open w1"/);
});

test("参与者不可点：onOpenMember 缺省时名字保持纯文本（无按钮）", () => {
  const html = render(snapshot(routeMessage("team-lead", "w1"), [LEAD, W1]));
  assert.doesNotMatch(html, /<button[^>]*data-testid="agent-teams-message-mm-from"/, "未传 onOpenMember 时不渲染按钮");
  assert.doesNotMatch(html, /<button[^>]*data-testid="agent-teams-message-mm-to"/);
  // 名字仍在（span），结构不丢。
  assert.match(html, /data-testid="agent-teams-message-mm-from"/);
});

test("参与者不可点：无法解析到 roster 的发送者即使传了 onOpenMember 也不渲染按钮", () => {
  const html = render(
    snapshot(routeMessage("ghost-sender", "w1"), [LEAD, W1]),
    { onOpenMember: () => {} },
  );
  assert.doesNotMatch(html, /<button[^>]*data-testid="agent-teams-message-mm-from"/, "未知发送者不渲染按钮");
  assert.match(html, /data-testid="agent-teams-message-mm-from"/, "未知发送者名字仍以纯文本渲染");
  // 接收者 w1 仍可点。
  assert.match(html, /<button[^>]*data-testid="agent-teams-message-mm-to"/);
});

// ── memberOpenHandler：点击时以正确成员回调；无回调/无成员/无 sessionId 时 undefined ──
test("memberOpenHandler：点击以正确成员回调", () => {
  const calls = [];
  const handler = memberOpenHandler(W1, (member) => calls.push(member));
  assert.equal(typeof handler, "function");
  handler();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "w1", "回调参数应为解析到的成员实例");
});

test("memberOpenHandler：无回调、无成员、成员无 sessionId 时返回 undefined", () => {
  assert.equal(memberOpenHandler(W1, undefined), undefined, "无 onOpenMember → undefined");
  assert.equal(memberOpenHandler(null, () => {}), undefined, "成员为 null → undefined");
  assert.equal(memberOpenHandler({ ...W1, sessionId: null }, () => {}), undefined, "无 sessionId → undefined");
});

