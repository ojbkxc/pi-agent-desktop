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
  "teams.plan.stop": "Stop team and main task",
  "teams.plan.stopping": "Stopping team and main task…",
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
  "teams.plan.discardUnsaved": "Discard the unsaved changes?",
  "teams.plan.discardAndClose": "Discard and close",
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

test("批准门禁：非 review_pending 拦住；未保存改动不再拦批准；批准失败有提示", () => {
  // draft 等状态批准路由必然 409 → 按钮禁用。
  for (const state of ["draft", "launch_failed", "interrupted"]) {
    const html = renderToStaticMarkup(planModalView(tFake, view({ state })));
    assert.match(html, /data-testid="team-plan-approve"[^>]*disabled/, `${state} 不能批准`);
  }

  // 改了模型但没保存：批准**不再**被拦住 —— 点批准时先自动保存草稿。
  const dirty = renderToStaticMarkup(planModalView(tFake, view(), { editor: false, dirty: true }));
  assert.doesNotMatch(dirty, /data-testid="team-plan-approve"[^>]*disabled/, "dirty 不拦批准");
  assert.equal(byTestId(planModalView(tFake, view(), { editor: false, dirty: true }), "team-plan-unsaved"), undefined,
    "旧的「先保存再批准」告警已移除");

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

test("停止按钮（cc-haha team-plan-stop 移植）：canStop=Boolean(plan.parentPlanId)", () => {
  const calls = [];
  const tree = planModalView(tFake, view({ parentPlanId: "p-old" }), {
    onStop: () => calls.push("stop"),
    onClose: () => calls.push("close"),
  });
  const stop = byTestId(tree, "team-plan-stop");
  assert.ok(stop, "带 parentPlanId 时显示停止按钮");
  assert.equal(stop.props.children, "Stop team and main task", "文案非 key 原文");
  stop.props.onClick();
  assert.deepEqual(calls, ["stop"], "点击调 onStop（停 lead 生成），不误触 close");

  // 无 parentPlanId：不显示（普通计划不提供停止入口）。
  const noParent = planModalView(tFake, view(), { onStop: () => calls.push("stop") });
  assert.equal(byTestId(noParent, "team-plan-stop"), undefined, "无 parentPlanId 不显示");

  // 缺 onStop 回调：按「缺省回调不出现按钮」的既有口径隐藏。
  const noCallback = planModalView(tFake, view({ parentPlanId: "p-old" }));
  assert.equal(byTestId(noCallback, "team-plan-stop"), undefined, "缺 onStop 不显示");
});

test("停止按钮 stopping 态：文案切换 + 禁用 + 点击不触发", () => {
  const calls = [];
  const stopping = planModalView(tFake, view({ parentPlanId: "p-old" }), {
    onStop: () => calls.push("stop"),
    stopping: true,
  });
  const stop = byTestId(stopping, "team-plan-stop");
  assert.equal(stop.props.children, "Stopping team and main task…", "进行态文案");
  assert.equal(stop.props.disabled, true, "进行中禁用防重复点击");
  assert.equal(stop.props.onClick, undefined, "禁用不接回调");
  stop.props.onClick?.();
  assert.deepEqual(calls, [], "stopping 态点击被拒");
});

// 覆盖层修复：overlay 的 z-index 必须是令牌而非 literal 60。卡片挂在聊天列，不在
// `.scheduled-view` 的 z 30 上下文里；60 < 顶栏 --z-chrome=90，会让 backdrop 与对话框
// 顶带被顶栏盖住，aria-modal 期间顶栏仍可点。改 --z-modal 即与全局对话框同层。
test("overlay 用 --z-modal 令牌（不是 literal 60，不得掉到顶栏 90 之下）", () => {
  const html = renderToStaticMarkup(planModalView(tFake, view()));
  assert.match(html, /data-testid="team-plan-overlay"/);
  assert.match(html, /z-index:var\(--z-modal\)/, "必须用层叠令牌");
  assert.doesNotMatch(html, /z-index:60\b/, "literal 60 会掉到顶栏之下");
  assert.match(html, /aria-modal="true"/, "模态语义保留");
});

// 宽度：弹框与输入框等宽，跟随聊天内容列实际宽度（--chat-content-region-width，
// ChatWindow 用 ResizeObserver 写入）；聊天列窄时同步收窄，宽于上限时取
// --chat-content-max-width。旧的 720 固定封顶会横跨屏幕（用户反馈）。
test("dialog 宽度与输入框等宽：跟随聊天内容列，不再 720 固定封顶", async () => {
  const { readFile } = await jiti.import("node:fs/promises");
  const source = (await readFile(new URL("./AgentTeamPlanCard.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(
    source,
    /width: "min\(var\(--chat-content-max-width, 820px\), var\(--chat-content-region-width, 100%\), 100%\)"/,
    "与输入框同一公式",
  );
  assert.match(source, /--chat-content-region-width/, "宽度跟随聊天内容列");
  assert.doesNotMatch(source, /720px/, "不得再用 720 固定封顶");
  assert.match(source, /className="team-plan-dialog"/, "弹框挂载容器查询/换行规则的类名");
  assert.match(source, /overflowWrap: "anywhere"/, "长文本可断行，防撑宽弹框");
});

test("状态标签键与徽标色覆盖四态（纯函数输出）", () => {
  assert.equal(planStateLabelKey("review_pending"), "teams.plan.state.review_pending");
  assert.equal(planStateToneColor("review_pending"), "var(--accent)");
  assert.equal(planStateToneColor("launch_failed"), "var(--danger)");
  assert.equal(planStateToneColor("draft"), "var(--text-muted)");
});

// ── interaction.md P1：dirty 时 Esc / 遮罩 / Close 不能静默丢草稿 ──────────────
test("dirty 时关闭路径走 requestClose（遮罩 / Close / Esc 同一条），不再直接 onClose", async () => {
  const { readFile } = await jiti.import("node:fs/promises");
  const source = (await readFile(new URL("./AgentTeamPlanCard.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  // 遮罩与 Close 都接 requestClose（dirty 时进二次确认）；旧实现是 onClick={options.onClose}。
  assert.match(source, /data-testid="team-plan-overlay" onClick=\{requestClose\}/, "遮罩走 requestClose");
  assert.match(source, /data-testid="team-plan-close" style=\{S\.ghost\} onClick=\{requestClose\}/, "Close 走 requestClose");
  // Esc 由共享模态 hook 接管（capture 段 preventDefault + stopPropagation），不再是
  // 原来的 document 冒泡监听直接把 setOpen(false)。
  assert.match(source, /useModalDismiss<HTMLDivElement>\(requestClose, open\)/);
  assert.doesNotMatch(source, /document\.addEventListener\("keydown", onKey\)/, "不得留旧的 Esc 冒泡监听");
  // requestClose：busy 按住；确认态再按一次 = 撤销这次关闭（不是放弃草稿）；
  // dirty 进二次确认；否则真关。
  assert.match(source, /if \(busy\) return;[\s\S]*if \(discardPrompt\) \{\s*\n\s*setDiscardPrompt\(false\);\s*\n\s*return;[\s\S]*if \(dirty\) setDiscardPrompt\(true\);[\s\S]*setOpen\(false\);/);
});

test("二次确认行：dirty+discardPrompt 时出现，取消留在卡片、确认才真关", () => {
  let cancelDiscard = 0;
  let discard = 0;
  const tree = planModalView(tFake, view(), {
    dirty: true,
    discardPrompt: true,
    onDiscard: () => { discard += 1; },
    onCancelDiscard: () => { cancelDiscard += 1; },
  });
  const prompt = byTestId(tree, "team-plan-discard-prompt");
  assert.ok(prompt, "确认行必须出现");
  // 二次确认态下不再叠加旧的「先保存再批准」常驻告警（该告警已整体移除）。
  assert.equal(byTestId(tree, "team-plan-unsaved"), undefined);
  byTestId(tree, "team-plan-discard-cancel").props.onClick();
  assert.equal(cancelDiscard, 1, "取消只退出确认，不关卡片");
  byTestId(tree, "team-plan-discard-confirm").props.onClick();
  assert.equal(discard, 1, "确认才丢弃并关闭");

  // 非 dirty / 未进确认态：不渲染确认行。
  assert.equal(byTestId(planModalView(tFake, view()), "team-plan-discard-prompt"), undefined);
});

test("i18n：新增的丢弃确认键不得漏成原文（三语由 fix-shared-css 落库）", () => {
  const html = renderToStaticMarkup(planModalView(tFake, view(), { dirty: true, discardPrompt: true }));
  assert.doesNotMatch(html, /teams\.plan\.discard/, "确认文案必须走 i18n");
  assert.match(html, /Discard the unsaved changes\?/);
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
  assert.match(source, /onDraftChange: \(edits\) => \{ editsRef\.current = edits; \}/, "编辑器 diff 上报到卡片（批准时先保存）");
  assert.match(source, /onApprove: \(\) => onApprove\?\.\(editsRef\.current\)/, "批准携带 diff");
  assert.match(source, /saving=\{options\.saving \?\? false\}/, "saving 一路传到可编辑区");
  assert.match(source, /conflict=\{options\.conflict \?\? false\}/, "conflict 一路传到可编辑区");
  assert.match(source, /cwd=\{options\.cwd \?\? null\}/, "cwd 一路传到可编辑区（agent 预设目录）");
});
