import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { FormationBand, activeMessageParticipants } = await jiti.import("./FormationBand.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

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
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function assignment(over = {}) {
  return {
    id: "a1",
    status: "running",
    memberId: "w1",
    assignee: "w1",
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
    ownerId: "w1",
    status: "open",
    dependencies: [],
    assignments: [],
    source: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function message(over = {}) {
  return {
    id: "m1",
    from: "team-lead",
    to: "w1",
    recipients: ["w1"],
    kind: "direct",
    text: "go",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function snapshot(members, tickets = [], messages = []) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    team: { id: "t", name: "demo", description: "", createdAt: "2026-01-01T00:00:00.000Z", leadSessionId: "lead-session", status: "running", incarnationId: "i" },
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

const LEAD = member("lead", { name: "team-lead", role: "orchestrator", color: "gray", status: "running", sessionId: "lead-session" });

const render = (snap, extra = {}) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: "en" },
  React.createElement(FormationBand, { snapshot: snap, width: 1280, ...extra }),
));

function memberTag(html, id) {
  const start = html.indexOf(`data-member-id="${id}"`);
  assert.ok(start >= 0, `找到成员卡 ${id}`);
  const open = html.lastIndexOf("<", start);
  const close = html.indexOf(">", start);
  return html.slice(open, close + 1);
}

test("活动消息：发送方 data-active-message=sender，接收方 recipient", () => {
  const snap = snapshot(
    [LEAD, member("w1", { status: "running" }), member("w2")],
    [],
    [message()],
  );
  const html = render(snap, { activeMessageId: "m1" });
  assert.equal(memberTag(html, "lead").includes('data-active-message="sender"'), true);
  assert.equal(memberTag(html, "w1").includes('data-active-message="recipient"'), true);
  assert.equal(memberTag(html, "w2").includes("data-active-message"), false, "无关成员不高亮");
});

test("广播且无显式收件人：除发送者外全员接收", () => {
  const snap = snapshot(
    [LEAD, member("w1"), member("w2")],
    [],
    [message({ to: "*", recipients: [], kind: "broadcast" })],
  );
  const html = render(snap, { activeMessageId: "m1" });
  assert.equal(memberTag(html, "lead").includes('data-active-message="sender"'), true);
  assert.equal(memberTag(html, "w1").includes('data-active-message="recipient"'), true);
  assert.equal(memberTag(html, "w2").includes('data-active-message="recipient"'), true);
});

test("activeMessageParticipants 别名匹配（name@team 短名）", () => {
  const participants = activeMessageParticipants(
    message({ from: "team-lead@demo", to: "w1@demo", recipients: ["w1@demo"] }),
    [LEAD, member("w1"), member("w2")],
  );
  assert.deepEqual([...participants.senders], ["lead"]);
  assert.deepEqual([...participants.recipients].sort(), ["w1"]);
});

test("成员卡状态行：当前票 + 未满足依赖（等待）+ 收件数", () => {
  const snap = snapshot(
    [LEAD, member("w1", { status: "running" })],
    [
      ticket("dep", { status: "open" }),
      ticket("t-run", {
        dependencies: ["dep"],
        assignments: [assignment({ status: "running", memberId: "w1", lastActivityAt: "2026-01-01T00:10:00.000Z" })],
      }),
    ],
    [
      message({ id: "m1", to: "w1", recipients: ["w1"] }),
      message({ id: "m2", to: "w1", recipients: ["w1"] }),
      message({ id: "m3", from: "w1", to: "team-lead", recipients: ["team-lead"] }),
    ],
  );
  const html = render(snap);
  const tag = memberTag(html, "w1");
  assert.equal(tag.includes('data-current-ticket="t-run"'), true);
  assert.equal(tag.includes('data-blocked-dependency="dep"'), true);
  assert.equal(tag.includes('data-inbox-count="2"'), true, "自己发出的不算收件");
  assert.match(html, /Waiting for #dep/);
  assert.match(html, /2 messages/);
});

test("成员卡状态行：只有当前票、依赖都满足 → 执行中，无等待行", () => {
  const snap = snapshot(
    [LEAD, member("w1", { status: "running" })],
    [
      ticket("t-exec", {
        assignments: [assignment({ status: "running", memberId: "w1", lastActivityAt: "2026-01-01T00:10:00.000Z" })],
      }),
    ],
  );
  const html = render(snap);
  const tag = memberTag(html, "w1");
  assert.equal(tag.includes('data-current-ticket="t-exec"'), true);
  assert.equal(tag.includes("data-blocked-dependency"), false);
  assert.match(html, /Working on #t-exec/);
});

test("无 running 派活时当前票为空", () => {
  const snap = snapshot([LEAD, member("w1")]);
  const html = render(snap);
  const tag = memberTag(html, "w1");
  assert.equal(tag.includes("data-current-ticket"), false);
  assert.equal(tag.includes("data-blocked-dependency"), false);
  assert.equal(tag.includes('data-inbox-count="0"'), true);
});
