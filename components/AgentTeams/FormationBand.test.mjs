import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  FormationBand,
  formationRequiredWidth,
  runningAssignmentCount,
  runningTicketsByMember,
} = await jiti.import("./FormationBand.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (snapshot, width = 1280, extra = {}) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: "en" },
  React.createElement(FormationBand, { snapshot, width, ...extra }),
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

test("activeMessageId：消息沿编队总线飞过，带本地化标签", () => {
  const snap = snapshot([LEAD, member("w1", { status: "running" })]);
  snap.messages = [{
    id: "m1",
    from: "team-lead",
    to: "w1",
    recipients: ["w1"],
    kind: "direct",
    text: "go",
    timestamp: "2026-01-01T00:00:00.000Z",
  }];
  const html = render(snap, 1280, { activeMessageId: "m1" });
  assert.match(html, /data-testid="agent-teams-formation-flight"/);
  assert.match(html, /data-flight-channel="lead"/);
  assert.match(html, /data-flight-tone="assignment"/);
  assert.match(html, /agent-teams-formation-flight-chip/);
  assert.match(html, />Assignment</, "标签来自 teams.communication.assignment");
});

test("没有活动消息时不画飞线", () => {
  const html = render(snapshot([LEAD, member("w1")]));
  assert.doesNotMatch(html, /agent-teams-formation-flight/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 本轮修复：并发可视化（成员同时跑多张票不得被折叠成一张）+ 多人布局宽度。
// ─────────────────────────────────────────────────────────────────────────────

/** 一条 running 派活（并发口径只认 status=running + memberId）。 */
const running = (id, memberId = "w1") => ({
  id,
  status: "running",
  memberId,
  assignee: memberId,
  sessionId: null,
  startedAt: null,
  lastActivityAt: null,
  result: null,
  outcome: null,
});

/** 取某张成员卡的属性片段（到下一个 > 为止）。 */
function memberTag(html, id) {
  const start = html.indexOf(`data-member-id="${id}"`);
  assert.ok(start >= 0, `找到成员卡 ${id}`);
  const open = html.lastIndexOf("<", start);
  const close = html.indexOf(">", start);
  return html.slice(open, close + 1);
}

test("formationRequiredWidth：成员排实际需要的画布宽度（单人/单成员不提要求）", () => {
  assert.equal(formationRequiredWidth(0), 0);
  assert.equal(formationRequiredWidth(1), 0, "只有 lead：任意宽度都放得下");
  assert.equal(formationRequiredWidth(2), 0, "1 个成员：居中即可");
  // 3 人 = lead + 2 个成员：两个成员中心相距一个 PITCH，再加一张卡宽与左右留白。
  assert.equal(formationRequiredWidth(3), 200 + 176 + 32);
  // 60 人：59 个成员按 MEMBER_PITCH 排开，任务画布必须放宽到这个宽度，
  // 否则成员卡会被画布右缘裁掉（「多派成员」在界面上看不到人）。
  assert.equal(formationRequiredWidth(60), 58 * 200 + 176 + 32);
});

test("runningTicketsByMember / runningAssignmentCount：成员同时跑多张票（并发不被折叠）", () => {
  const snap = snapshot(
    [LEAD, member("w1", { status: "running" })],
    [
      ticket("t1", { assignments: [running("a1")] }),
      // 同一张票两条 running 派活：票只算一次（票是并发的单位）。
      ticket("t2", { assignments: [running("a2"), running("a3")] }),
      // pending 不算在跑。
      ticket("t3", { assignments: [{ ...running("a4"), status: "pending" }] }),
      // 未落在名册上的派活：仍按 memberId 归组（memberId 为 null 才丢弃），
      // 只是不会有卡片渲染它；全队并发数照算。
      ticket("t4", { assignments: [running("a5", "ghost")] }),
    ],
  );
  const byMember = runningTicketsByMember(snap);
  assert.deepEqual(byMember.get("w1"), ["t1", "t2"]);
  assert.deepEqual(byMember.get("ghost"), ["t4"], "只按 memberId 归组，是否有名册成员由卡片层决定");
  assert.equal(runningAssignmentCount(snap.tickets), 4, "三条 running 在名册成员 + 一条 orphan");

  const html = render(snap);
  assert.equal(memberTag(html, "w1").includes('data-concurrent-tickets="2"'), true, "卡上如实给出 2 张在跑");
  assert.match(html, /×2/, "并发数直接写在任务行上，而不是只画第一张");
  assert.equal(memberTag(html, "lead").includes('data-concurrent-tickets="0"'), true);
  // 全队并发读数：标题旁的「N 项进行中」。
  assert.match(html, /data-testid="agent-teams-formation-running"/);
  assert.match(html, /4 running/);
  assert.equal(memberTag(html, "w1").includes('data-current-ticket="t1"'), true, "当前票仍是最近活动的那张");
});

test("单张在跑时不加 ×N（保持既有单任务口径）", () => {
  const html = render(snapshot(
    [LEAD, member("w1", { status: "running" })],
    [ticket("t1", { assignments: [running("a1")] })],
  ));
  const tag = memberTag(html, "w1");
  assert.equal(tag.includes('data-concurrent-tickets="1"'), true);
  assert.doesNotMatch(html, /×1/);
  assert.match(html, /Working on #t1/);
});

test("长成员名不撑破卡片：名字节点带 title 与折行护栏", () => {
  const longName = "worker-" + "x".repeat(80);
  const html = render(snapshot([LEAD, member(longName)]));
  const nameIndex = html.indexOf(longName);
  assert.ok(nameIndex > 0, "全名仍在 DOM 里（title）");
  assert.match(html, /overflow-wrap:anywhere/, "flex 子项给折行护栏");
  assert.match(html, /min-width:0/, "flex 子项必须能收缩，ellipsis 才生效");
});
