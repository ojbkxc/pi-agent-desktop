import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 团队运行时控件组件（cc-haha AgentTeamsRuntimeControls 移植）：
 * 渲染门（readOnly / scope 不全 / 无数据）、状态徽标、暂停/恢复按钮的显隐与文案、
 * partial 的 Retry 与错误列表。fetch 换桩预填 store 后 renderToStaticMarkup。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentTeamsRuntimeControls, memberStatusKey, statePresentation, teamRuntimeControl, resetTeamRuntimeControlForTest } =
  await jiti.import("./AgentTeamsRuntimeControls.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const TEAM = {
  name: "demo",
  leadSessionId: "sess-lead",
  incarnationId: "inc-1",
  description: "",
  createdAt: "2026-11-15T00:00:00.000Z",
  status: "running",
  id: "demo",
};

const VIEW = (over = {}) => ({
  schemaVersion: 1,
  teamName: "demo",
  leadSessionId: "sess-lead",
  incarnationId: "inc-1",
  revision: 1,
  epoch: 0,
  status: "running",
  updatedAt: 0,
  members: [
    { agentId: "m-lead", sessionId: "sess-lead", name: "team-lead", status: "running" },
    { agentId: "m-impl", sessionId: "sess-impl", name: "impl", status: "running" },
  ],
  resumeEligibleCount: 0,
  ...over,
});

const render = (element) => renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: "en" }, element));

/** fetch 桩：GET 返回给定视图。 */
function stubView(view) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Promise.resolve(new Response(JSON.stringify(view), { status: 200 }));
  return { restore: () => { globalThis.fetch = previous; } };
}

const SCOPE = { teamName: "demo", leadSessionId: "sess-lead", incarnationId: "inc-1" };

async function loadView(view) {
  const stub = stubView(view);
  try {
    await teamRuntimeControl.refresh(SCOPE);
  } finally {
    stub.restore();
  }
}

test.beforeEach(() => {
  resetTeamRuntimeControlForTest();
});

test("渲染门：readOnly / scope 不全 / 无数据 ⇒ 不渲染", () => {
  assert.equal(render(React.createElement(AgentTeamsRuntimeControls, { team: TEAM, readOnly: true })), "", "readOnly 不渲染");
  assert.equal(
    render(React.createElement(AgentTeamsRuntimeControls, { team: { ...TEAM, leadSessionId: null } })),
    "",
    "scope 缺 leadSessionId 不渲染",
  );
  assert.equal(render(React.createElement(AgentTeamsRuntimeControls, { team: null })), "", "无团队不渲染");
  // 无视图且无 loading/error：不渲染（fetch 桩前 store 为空）
  assert.equal(render(React.createElement(AgentTeamsRuntimeControls, { team: TEAM })), "", "无数据不渲染");
});

test("running：状态徽标 + 可恢复数 + 暂停按钮（无恢复按钮）", async () => {
  await loadView(VIEW());
  const html = render(React.createElement(AgentTeamsRuntimeControls, { team: TEAM, onAbort: () => {} }));
  assert.match(html, /data-testid="agent-teams-runtime-controls"/);
  assert.match(html, /data-testid="runtime-state"/);
  assert.match(html, /Running/, "运行中徽标");
  assert.match(html, /0 members can resume/, "可恢复数");
  assert.match(html, /data-testid="runtime-pause"/, "暂停按钮显示");
  assert.match(html, /Pause team/);
  assert.doesNotMatch(html, /data-testid="runtime-resume"/, "running 无恢复按钮");
  assert.doesNotMatch(html, /teams\.runtime\./, "不渲染 i18n 键原文");
});

test("paused：暂停按钮消失、恢复按钮出现、成员状态如实", async () => {
  await loadView(VIEW({
    status: "paused",
    revision: 2,
    resumeEligibleCount: 1,
    members: [
      { agentId: "m-lead", sessionId: "sess-lead", name: "team-lead", status: "running" },
      { agentId: "m-impl", sessionId: "sess-impl", name: "impl", status: "paused" },
    ],
  }));
  const html = render(React.createElement(AgentTeamsRuntimeControls, { team: TEAM, onAbort: () => {} }));
  assert.doesNotMatch(html, /data-testid="runtime-pause"/, "已暂停无暂停按钮");
  assert.match(html, /data-testid="runtime-resume"/);
  assert.match(html, /Resume team/, "恢复按钮文案（partial 才是 Retry）");
  assert.match(html, /impl · paused/, "成员状态");
  assert.match(html, /team-lead · running/);
});

test("partial：Retry 文案 + 错误列表（含 member error）", async () => {
  await loadView(VIEW({
    status: "partial",
    revision: 2,
    error: "部分成员未确认停止",
    members: [{ agentId: "m-impl", sessionId: "sess-impl", name: "impl", status: "paused", error: "host.stop 爆了" }],
  }));
  const html = render(React.createElement(AgentTeamsRuntimeControls, { team: TEAM, onAbort: () => {} }));
  assert.match(html, /Retry resume/, "partial 用 Retry 文案");
  assert.match(html, /data-testid="runtime-errors"/);
  assert.match(html, /部分成员未确认停止/);
  assert.match(html, /impl: host\.stop 爆了/, "成员错误带名字");
});

test("无 onAbort：暂停按钮不出现（缺省回调不出现按钮的既有口径）", async () => {
  await loadView(VIEW());
  const html = render(React.createElement(AgentTeamsRuntimeControls, { team: TEAM }));
  assert.doesNotMatch(html, /data-testid="runtime-pause"/);
});

test("纯函数：memberStatusKey 与 statePresentation 的状态映射", () => {
  assert.equal(memberStatusKey("running"), "teams.runtime.member.running");
  assert.equal(memberStatusKey("failed"), "teams.runtime.member.failed");
  const view = VIEW();
  assert.equal(statePresentation(view, true, false).key, "teams.runtime.pausing", "请求态优先");
  assert.equal(statePresentation(view, false, true).key, "teams.runtime.resuming");
  assert.equal(statePresentation(VIEW({ status: "paused" }), false, false).key, "teams.runtime.paused");
  assert.equal(statePresentation(VIEW({ status: "partial" }), false, false).key, "teams.runtime.partial");
  assert.equal(statePresentation(VIEW({ status: "running" }), false, false).key, "teams.runtime.running");
});
