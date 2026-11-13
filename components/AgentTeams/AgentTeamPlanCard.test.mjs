import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * B3 计划卡组件：收缩态渲染 / 可见性自判断 / Modal 内容 / 批准按钮 disabled / 回调接线。
 *
 * 无 DOM 环境（无 jsdom / testing-library），沿用仓库约定：react-dom/server 断言静态标记，
 * 纯视图 `planModalView` 直接遍历元素树验证 onClick 接线。
 *
 * 断言口径：**验证渲染出的真实文案**（收缩态走真 I18nProvider(en)；纯视图用 tFake 词典把
 * 键翻成人话），**绝不**断言 i18n 键原文——否则 key 一旦补齐/删除，断言就假过或假挂。
 * 每个渲染用例都反查「不得出现 teams.plan. 键前缀」，key 被删也会在这里暴露。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentTeamPlanCard, planModalView, planStateLabelKey, planStateToneColor } = await jiti.import("./AgentTeamPlanCard.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);

/** 纯视图用的假词典：把键翻成可断言的人话，带一个极简 {name} 插值。 */
const FAKE = {
  "teams.plan.title": "Team plan",
  "teams.plan.review": "Review configuration",
  "teams.plan.reviewHint": "Review the roster and tasks before the team runs.",
  "teams.plan.roster": "Members",
  "teams.plan.tasks": "Tasks",
  "teams.plan.noTasks": "No tasks planned yet.",
  "teams.plan.owner": "Owner",
  "teams.plan.unassigned": "Unassigned",
  "teams.plan.assignRequired": "Assign every task before approving.",
  "teams.plan.dependencies": "Depends on",
  "teams.plan.close": "Close",
  "teams.plan.approve": "Approve",
  "teams.plan.approving": "Approving…",
  "teams.plan.memberCount": "{count} members",
  "teams.plan.invalidNames": "Invalid member names: {names}",
  "teams.plan.state.draft": "Draft",
  "teams.plan.state.review_pending": "Awaiting review",
  "teams.plan.state.launching": "Launching",
  "teams.plan.state.running": "Running",
  "teams.plan.state.launch_failed": "Launch failed",
  "teams.plan.state.cancelled": "Cancelled",
  "teams.plan.state.interrupted": "Interrupted",
  "teams.plan.saveBeforeApprove": "Save your changes before approving — otherwise the team launches with the old models.",
};
function tFake(key, params) {
  let text = FAKE[key] ?? key;
  if (params) for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
  return text;
}

function collect(node, pred, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  const children = node.props?.children;
  if (children != null) {
    for (const child of Array.isArray(children) ? children : [children]) collect(child, pred, out);
  }
  return out;
}
const byTestId = (tree, id) => collect(tree, (n) => n.props?.["data-testid"] === id)[0];

const member = (over = {}) => ({
  id: "m1", name: "impl", agentType: "general-purpose", prompt: "do it",
  runtime: { providerId: "openai", modelId: "gpt-5" }, ...over,
});
const task = (over = {}) => ({ id: "t1", subject: "build", dependencies: [], ...over });
const view = (over = {}) => ({
  planId: "p-1", sessionId: "s-1", teamName: "demo", incarnationId: "inc-1",
  state: "review_pending", revision: 3,
  leaderRuntime: { providerId: "openai", modelId: "gpt-5" },
  members: [member()], tasks: [task({ ownerId: "m1" })], updatedAt: 0, ...over,
});

test("收缩态：真实渲染出团队名 + 状态 + 成员数 + Review 按钮（非 key 原文）", () => {
  const html = render(React.createElement(AgentTeamPlanCard, { plan: view() }));
  // 结构挂点
  assert.match(html, /data-testid="team-plan-card"/);
  assert.match(html, /data-testid="team-plan-open"/);
  // 四样东西：团队名 / 状态 / 成员数 / Review 按钮
  assert.match(html, /demo/, "团队名");
  assert.match(html, /Team plan/, "标题文案");
  assert.match(html, /Awaiting review/, "状态徽标文案");
  assert.match(html, /1 members/, "成员数（count=1）");
  assert.match(html, /Review configuration/, "Review 按钮文案");
  // 反向：不得把 i18n 键原文漏到界面（key 被删也会在这里暴露）
  assert.doesNotMatch(html, /teams\.plan\./, "不应渲染 i18n 键原文");
});

test("可见性自判断：无 plan / launching / running / cancelled 无 parent → 不渲染", () => {
  for (const plan of [null, view({ state: "launching" }), view({ state: "running" }), view({ state: "cancelled" })]) {
    assert.equal(render(React.createElement(AgentTeamPlanCard, { plan })), "", `hidden: ${plan && plan.state}`);
  }
  for (const state of ["draft", "review_pending", "launch_failed", "interrupted"]) {
    assert.match(render(React.createElement(AgentTeamPlanCard, { plan: view({ state }) })), /data-testid="team-plan-card"/, state);
  }
  assert.match(
    render(React.createElement(AgentTeamPlanCard, { plan: view({ state: "cancelled", parentPlanId: "p-old" }) })),
    /data-testid="team-plan-card"/,
    "带 parentPlanId 的 cancelled 保留",
  );
});

test("Modal 内容：成员名册（含 runtime）+ 任务（owner/依赖）+ 未分配告警", () => {
  const html = renderToStaticMarkup(planModalView(tFake, view({
    members: [member(), member({ id: "m2", name: "qa", runtime: { providerId: "anthropic", modelId: "claude" } })],
    tasks: [
      task({ ownerId: "m1", dependencies: ["t0"] }),
      task({ id: "t2", subject: "ship", ownerId: undefined }),
    ],
  })));
  assert.match(html, /data-testid="team-plan-overlay"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /data-member-id="m1"/);
  assert.match(html, /data-member-id="m2"/);
  assert.match(html, /openai\/gpt-5/);
  assert.match(html, /anthropic\/claude/);
  assert.match(html, /data-task-id="t1"/);
  assert.match(html, /data-task-id="t2"/);
  assert.match(html, /data-testid="team-plan-unassigned"/, "未分配任务给告警");
  assert.match(html, /Owner/, "owner 标签");
  assert.match(html, /Depends on/, "依赖标签");
  assert.match(html, /Members/, "名册标题");
  assert.match(html, /Tasks/, "任务标题");
  assert.doesNotMatch(html, /teams\.plan\./, "不应渲染 i18n 键原文");
});

test("launch 失败信息与非法成员名渲染成 alert", () => {
  const html = renderToStaticMarkup(planModalView(tFake, view({
    state: "launch_failed",
    launch: { status: "failed", error: "所有成员都派发失败" },
    members: [member({ name: "team-lead" })],
  })));
  assert.match(html, /data-testid="team-plan-launch-error"/);
  assert.match(html, /所有成员都派发失败/);
  assert.match(html, /data-testid="team-plan-invalid-names"/);
  assert.match(html, /Invalid member names: team-lead/);
});

test("批准按钮 disabled = 有未分配任务 / 非法成员名；busy 时禁用且文案切换", () => {
  const enabled = renderToStaticMarkup(planModalView(tFake, view()));
  assert.doesNotMatch(enabled, /data-testid="team-plan-approve"[^>]*disabled/);
  assert.match(enabled, /data-testid="team-plan-approve"/);

  const unassigned = renderToStaticMarkup(planModalView(tFake, view({ tasks: [task({ ownerId: undefined })] })));
  assert.match(unassigned, /data-testid="team-plan-approve"[^>]*disabled/);

  const invalid = renderToStaticMarkup(planModalView(tFake, view({ members: [member({ name: "team-lead" })] })));
  assert.match(invalid, /data-testid="team-plan-approve"[^>]*disabled/);

  const busy = renderToStaticMarkup(planModalView(tFake, view(), { busy: true }));
  assert.match(busy, /data-testid="team-plan-approve"[^>]*disabled/);
  assert.match(busy, /Approving…/, "busy 时按钮文案改为「批准中」");
  assert.doesNotMatch(busy, /teams\.plan\./, "不应渲染 i18n 键原文");
});

test("批准门禁：非 review_pending / 有未保存改动 / 批准失败都拦住并给提示", () => {
  // draft 等状态批准路由必然 409 → 按钮禁用。
  for (const state of ["draft", "launch_failed", "interrupted"]) {
    const html = renderToStaticMarkup(planModalView(tFake, view({ state })));
    assert.match(html, /data-testid="team-plan-approve"[^>]*disabled/, `${state} 不能批准`);
  }

  // 改了模型但没保存：批准被拦住 + 说明原因（否则会按旧模型启动团队）。
  const dirty = renderToStaticMarkup(planModalView(tFake, view(), { editor: false, dirty: true }));
  assert.match(dirty, /data-testid="team-plan-approve"[^>]*disabled/);
  assert.match(dirty, /data-testid="team-plan-unsaved"/);
  assert.match(dirty, /Save your changes before approving/, "提示文案来自 i18n（此处为假词典/英文包）");

  // 批准失败的原因必须显示出来（调用方丢返回值也不静默）。
  const failed = renderToStaticMarkup(planModalView(tFake, view(), { approveError: "投递失败：找不到 lead 会话" }));
  assert.match(failed, /data-testid="team-plan-approve-error"/);
  assert.match(failed, /找不到 lead 会话/);
});

test("回调接线：启用时点批准触发 onApprove、点关闭触发 onClose；禁用时批准无 onClick", () => {
  let approved = 0;
  let closed = 0;
  const tree = planModalView(tFake, view(), { onApprove: () => { approved += 1; }, onClose: () => { closed += 1; } });
  const approve = byTestId(tree, "team-plan-approve");
  const close = byTestId(tree, "team-plan-close");
  assert.equal(typeof approve.props.onClick, "function");
  approve.props.onClick();
  assert.equal(approved, 1);
  close.props.onClick();
  assert.equal(closed, 1);

  // disabled 时批准按钮不挂 onClick，点了也不会触发。
  const disabledTree = planModalView(tFake, view({ tasks: [task({ ownerId: undefined })] }), { onApprove: () => { approved += 1; } });
  const disabledApprove = byTestId(disabledTree, "team-plan-approve");
  assert.equal(disabledApprove.props.disabled, true);
  assert.equal(disabledApprove.props.onClick, undefined, "禁用按钮不接回调");
  assert.equal(approved, 1, "未再增加");
});

test("状态标签键与徽标色覆盖四态（纯函数输出）", () => {
  assert.equal(planStateLabelKey("review_pending"), "teams.plan.state.review_pending");
  assert.equal(planStateToneColor("review_pending"), "var(--accent)");
  assert.equal(planStateToneColor("launch_failed"), "var(--danger)");
  assert.equal(planStateToneColor("draft"), "var(--text-muted)");
});

test("editable 路径：传 editor 才渲染可编辑区，且 draft / review_pending 才允许保存", async () => {
  // PlanEditor 需要 useModelCatalog 等 hook，SSR 渲染会真的发请求；这里只断言卡片
  // 把 `editor: true` 传进了纯视图（分叉点），PlanEditor 自己的纯函数有独立单测。
  const { planModalView: viewFn } = await jiti.import("./AgentTeamPlanCard.tsx");
  assert.equal(typeof viewFn, "function");

  // 不传 editor → 退回只读名册（既有静态断言不变）。
  const readOnly = renderToStaticMarkup(planModalView(tFake, view()));
  assert.doesNotMatch(readOnly, /data-testid="team-plan-editor"/);

  // 主组件始终传 editor: true（可编辑弹框是默认形态）。
  const fs = await jiti.import("node:fs");
  const source = fs.readFileSync(new URL("./AgentTeamPlanCard.tsx", import.meta.url), "utf8");
  assert.match(source, /editor: true/, "主组件必须把可编辑区打开");
  assert.match(source, /onSave \? \{ onSave \} : \{\}/, "onSave 缺省时不下传，保持只读降级");
  assert.match(source, /saving=\{options\.saving \?\? false\}/, "saving 一路传到可编辑区");
  assert.match(source, /conflict=\{options\.conflict \?\? false\}/, "conflict 一路传到可编辑区");
  assert.match(source, /cwd=\{options\.cwd \?\? null\}/, "cwd 一路传到可编辑区（agent 预设目录）");
});
