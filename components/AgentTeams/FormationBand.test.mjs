import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { FormationBand } = await jiti.import("./FormationBand.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (snapshot, width = 1280) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: "en" },
  React.createElement(FormationBand, { snapshot, width }),
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
    sessionId: `${id}-session`,
    cwd: "",
    worktreePath: null,
    lastError: null,
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function assignment(outcome) {
  return { id: `a-${outcome}`, status: "ended", outcome, assignee: "w1", memberId: "w1", sessionId: null, startedAt: null, result: null };
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

function snapshot(members, tickets = []) {
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
  };
}

const LEAD = member("lead", { name: "team-lead", role: "orchestrator", color: "gray", status: "running", sessionId: "lead-session", model: "claude-sonnet" });

test("renders the formation band with a centered lead card and the member row", () => {
  const html = render(snapshot([LEAD, member("w1", { status: "running", model: "gpt-5" }), member("w2")]));
  assert.match(html, /data-testid="agent-teams-formation"/);
  assert.match(html, /agent-teams-formation-card--lead/);
  assert.match(html, /data-member-id="lead"/);
  assert.match(html, /data-member-id="w1"/);
  assert.match(html, /data-member-id="w2"/);
  // 两条总线都画出来
  assert.match(html, /data-channel="lead"/);
  assert.match(html, /data-channel="peer"/);
});

test("member cards expose work state, model chip and the segmented progress bar", () => {
  const html = render(snapshot(
    [LEAD, member("w1", { status: "running", model: "gpt-5" })],
    [
      ticket("t1", { status: "ended", assignments: [assignment("completed")] }),
      ticket("t2", { status: "ended", assignments: [assignment("failed")] }),
    ],
  ));
  assert.match(html, /data-member-state="working"/);
  assert.match(html, /agent-teams-formation-state--working/);
  assert.match(html, /data-segment="completed"/);
  assert.match(html, /data-segment="failed"/);
  assert.match(html, /agent-teams-formation-badge--failed/, "最紧急段决定徽标");
  assert.match(html, /gpt-5/);
});

test("省去进度条与徽标：名下无票的成员只显示工作态", () => {
  const html = render(snapshot([LEAD, member("w1")]));
  assert.match(html, /data-member-id="w1"/);
  assert.doesNotMatch(html, /data-segment=/);
  assert.doesNotMatch(html, /agent-teams-formation-badge/);
});

// #55（忙闲可见，规格变更说明：无票成员原来「只显示工作态」，忙闲需求要求最闲的
// 人也可见——无票成员正是最空闲的，故其 meta-row 渲染「无积压」pill；分段条与
// urgency 徽标仍不渲染。口径变更依据：团队吞吐需求 #55 第一段。）
// 注意：本文件已有的 assignment(outcome) fixture status 恒为 "ended"（outcome 才是
// 参数）；忙闲派生只认 status ∈ {running, pending}，这里用 status 正确的本地 helper。
const liveAssignment = (status) => ({
  id: `live-${status}`, status, memberId: "w1", assignee: "w1",
  sessionId: null, startedAt: null, lastActivityAt: null, result: null, outcome: null,
});
test("忙闲 pill：无票成员渲染 idle「无积压」，running/pending 计数入 pill，lead 不显示", () => {
  // 无票成员 → idle pill；无分段条与 urgency 徽标的口径保持。
  const idleHtml = render(snapshot([LEAD, member("w1")]));
  assert.match(idleHtml, /data-workload="idle"/);
  assert.match(idleHtml, /agent-teams-formation-workload--idle/);
  assert.doesNotMatch(idleHtml, /data-segment=/);
  assert.doesNotMatch(idleHtml, /agent-teams-formation-badge/);

  // running 优先于 pending：1 running + 2 pending → running pill。
  const busyHtml = render(snapshot(
    [LEAD, member("w1", { status: "running" })],
    [
      ticket("t1", { assignments: [liveAssignment("running")] }),
      ticket("t2", { assignments: [liveAssignment("pending")] }),
      ticket("t3", { assignments: [liveAssignment("pending")] }),
    ],
  ));
  assert.match(busyHtml, /data-workload="running"/);
  assert.doesNotMatch(busyHtml, /data-workload="pending"/);

  // 只有 pending → pending pill。
  const queuedHtml = render(snapshot(
    [LEAD, member("w1")],
    [ticket("t1", { assignments: [liveAssignment("pending")] })],
  ));
  assert.match(queuedHtml, /data-workload="pending"/);

  // lead 卡不显示忙闲 pill（lead 不接票，恒空闲的标是噪音）。
  const leadOnly = render(snapshot([LEAD]));
  assert.doesNotMatch(leadOnly, /data-workload=/);
});

test("成员超过 1 个时给出「按紧急度重排」按钮，单个成员时不出现", () => {
  const many = render(snapshot([LEAD, member("w1"), member("w2")]));
  assert.match(many, /agent-teams-formation-sort/);
  const one = render(snapshot([LEAD, member("w1")]));
  assert.doesNotMatch(one, /agent-teams-formation-sort/);
});

test("无成员时渲染空带不崩溃", () => {
  const html = render(snapshot([]));
  assert.match(html, /data-testid="agent-teams-formation"/);
  assert.doesNotMatch(html, /data-member-id=/);
});

test("parked 成员显示为独立态（不并入 idle/stopped）", () => {
  const html = render(snapshot([LEAD, member("w1", { status: "parked" })]));
  assert.match(html, /data-member-state="parked"/);
  assert.match(html, /agent-teams-formation-state--parked/);
});

// 需求2（信息展示全）：分段色条只有颜色，视觉用户读不出比例；completed/total
// 必须以文字直接可见（数据本就存在于 FormationMember）。
test("进度条旁直接可见完成计数 n/m", () => {
  const html = render(snapshot(
    [LEAD, member("w1", { status: "running" })],
    [
      ticket("t1", { status: "ended", assignments: [assignment("completed")] }),
      ticket("t2", { status: "ended", assignments: [assignment("failed")] }),
    ],
  ));
  assert.match(html, /agent-teams-formation-progress-row/);
  assert.match(html, /agent-teams-formation-progress-count/);
  assert.match(html, />1\/2</, "1 张 completed / 共 2 张票");
  // 读屏语义仍由进度条的 aria-label 承担，可见计数不重复朗读。
  assert.match(html, /aria-hidden="true">1\/2</);
});
