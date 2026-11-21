import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 通信流「活动消息行 / 聚焦票 / 键盘高亮」守卫（T5）。
 *
 * - activeMessageId 指向的行带 data-active-message="true"，其余行没有；
 * - focusedTicketId 与某行所属票一致时该行带 data-focused-ticket="true"；
 * - 键盘焦点走与悬停同一条高亮通道（onFocus/onBlur → onFocusTask），鼠标行为保留。
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentTeamsCommunicationFeed } = await jiti.import("./AgentTeamsCommunicationFeed.tsx");
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
    joinedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(messages, members) {
  return {
    version: 1,
    generatedAt: "2026-11-05T03:00:00.000Z",
    team: {
      id: "demo", name: "demo", description: "", createdAt: "2026-11-05T00:00:00.000Z",
      leadSessionId: "lead-session", status: "running", incarnationId: "inc",
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
  };
}

const LEAD = member("lead-1", { name: "team-lead", role: "orchestrator", isLead: true, status: "running" });
const W1 = member("w1");
const W2 = member("w2");

const MESSAGES = [
  { id: "m1", from: "team-lead", to: "w1", recipients: ["w1"], kind: "direct", text: "one", taskId: "T1", timestamp: "2026-11-05T01:00:00.000Z" },
  { id: "m2", from: "w1", to: "team-lead", recipients: ["team-lead"], kind: "direct", text: "two", taskId: "T2", timestamp: "2026-11-05T02:00:00.000Z" },
  { id: "m3", from: "w1", to: "w2", recipients: ["w2"], kind: "direct", text: "three", taskId: "T1", timestamp: "2026-11-05T03:00:00.000Z" },
];

const render = (extraProps = {}) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: "en" },
  React.createElement(AgentTeamsCommunicationFeed, { snapshot: snapshot(MESSAGES, [LEAD, W1, W2]), ...extraProps }),
));

test("activeMessageId：仅命中的那一行带 data-active-message", () => {
  const html = render({ activeMessageId: "m2" });
  assert.match(html, /data-testid="agent-teams-message-m2"[^>]*data-active-message="true"/);
  assert.doesNotMatch(html, /data-testid="agent-teams-message-m1"[^>]*data-active-message/);
  assert.doesNotMatch(html, /data-testid="agent-teams-message-m3"[^>]*data-active-message/);
});

test("activeMessageId 缺省：任何行都不带 data-active-message", () => {
  const html = render();
  assert.doesNotMatch(html, /data-active-message/);
});

test("focusedTicketId：属于该票的消息行带 data-focused-ticket", () => {
  const html = render({ focusedTicketId: "T1" });
  assert.match(html, /data-testid="agent-teams-message-m1"[^>]*data-focused-ticket="true"/);
  assert.match(html, /data-testid="agent-teams-message-m3"[^>]*data-focused-ticket="true"/);
  assert.doesNotMatch(html, /data-testid="agent-teams-message-m2"[^>]*data-focused-ticket/);
});

test("键盘可聚焦：所属票可高亮的行进 Tab 序列（tabindex=0）", () => {
  const html = render();
  assert.match(html, /data-testid="agent-teams-message-m1"[^>]*tabindex="0"/);
  assert.match(html, /data-testid="agent-teams-message-m3"[^>]*tabindex="0"/);
});

test("键盘焦点走同一高亮通道：源码里 onFocus/onBlur 调用 onFocusTask，鼠标行为保留", async () => {
  const source = (await readFile(new URL("./AgentTeamsCommunicationFeed.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(source, /onFocus:\s*handleFocus/, "行必须有 onFocus");
  assert.match(source, /onBlur:\s*handleBlur/, "行必须有 onBlur");
  assert.match(source, /onFocusTask\(focusedTaskId\)/, "获得焦点 → 高亮该票");
  assert.match(source, /onFocusTask\(null\)/, "真正离开行 → 清空高亮");
  // 鼠标行为保留。
  assert.match(source, /onMouseEnter:[^,]*onFocusTask\?\.\(focusedTaskId\)/s);
  assert.match(source, /onMouseLeave:[^,]*onFocusTask\?\.\(null\)/s);
});
