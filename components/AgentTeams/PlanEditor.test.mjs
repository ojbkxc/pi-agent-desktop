import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 计划编辑器（PlanEditor）的**纯函数层**：模型 ref 拆分/拼接、草稿生成、脏判定、
 * 以及「只提交真正改过的字段」这一 PATCH 体口径。
 *
 * 组件本体需要 React hook（useModelCatalog / 预设接口），不在无 DOM 环境渲染；
 * 卡片 editable 路径的静态断言放在 AgentTeamPlanCard.test.mjs。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { splitModelRef, joinModelRef, diffPlanEdits, draftFromPlan, isDraftDirty } =
  await jiti.import("./PlanEditor.tsx");

const member = (over = {}) => ({
  id: "m1",
  name: "impl",
  agentType: "general-purpose",
  prompt: "do it",
  runtime: { providerId: "openai", modelId: "gpt-5" },
  ...over,
});
const task = (over = {}) => ({ id: "t1", subject: "build", dependencies: [], ...over });
const plan = (over = {}) => ({
  planId: "p-1",
  sessionId: "s-1",
  teamName: "demo",
  incarnationId: "inc-1",
  state: "review_pending",
  revision: 1,
  leaderRuntime: { providerId: "openai", modelId: "gpt-5" },
  members: [member(), member({ id: "m2", name: "qa" })],
  tasks: [task({ ownerId: "m1" }), task({ id: "t2", subject: "ship" })],
  updatedAt: 0,
  ...over,
});

test("splitModelRef：provider 不含斜杠，模型 id 里的斜杠归模型", () => {
  assert.deepEqual(splitModelRef("openai/gpt-5"), { providerId: "openai", modelId: "gpt-5" });
  assert.deepEqual(
    splitModelRef("openrouter/anthropic/claude-sonnet"),
    { providerId: "openrouter", modelId: "anthropic/claude-sonnet" },
    "只按第一个斜杠切",
  );
  assert.equal(splitModelRef(""), null, "空串");
  assert.equal(splitModelRef("no-slash"), null, "缺 provider");
  assert.equal(splitModelRef("/model"), null, "空 provider");
  assert.equal(splitModelRef("provider/"), null, "空 model");
});

test("joinModelRef 与 splitModelRef 互逆", () => {
  assert.equal(joinModelRef("openai", "gpt-5"), "openai/gpt-5");
  assert.equal(joinModelRef("", "gpt-5"), "", "缺一不可");
  assert.deepEqual(splitModelRef(joinModelRef("p", "a/b")), { providerId: "p", modelId: "a/b" });
});

test("draftFromPlan：基线原样来自 plan（含思考级别）", () => {
  const draft = draftFromPlan(plan());
  assert.deepEqual(draft.members.m1, { agentType: "general-purpose", modelRef: "openai/gpt-5", effortLevel: "" });
  assert.deepEqual(draft.members.m2, { agentType: "general-purpose", modelRef: "openai/gpt-5", effortLevel: "" });
  assert.equal(draft.tasks.t1, "m1");
  assert.equal(draft.tasks.t2, "", "未分配 → 空串（下拉的「未分配」值）");

  const withEffort = draftFromPlan(plan({ members: [member({ runtime: { providerId: "openai", modelId: "gpt-5", effortLevel: "high" } })] }));
  assert.equal(withEffort.members.m1.effortLevel, "high", "计划里的级别进草稿");
});

test("isDraftDirty：未改 → false；改模型 / agent / owner / 思考级别 → true", () => {
  const base = plan();
  const draft = draftFromPlan(base);
  assert.equal(isDraftDirty(base, draft), false);

  const modelChanged = structuredClone(draft);
  modelChanged.members.m1.modelRef = "anthropic/claude";
  assert.equal(isDraftDirty(base, modelChanged), true);

  const agentChanged = structuredClone(draft);
  agentChanged.members.m2.agentType = "explore";
  assert.equal(isDraftDirty(base, agentChanged), true);

  const ownerChanged = structuredClone(draft);
  ownerChanged.tasks.t2 = "m2";
  assert.equal(isDraftDirty(base, ownerChanged), true);

  const effortChanged = structuredClone(draft);
  effortChanged.members.m1.effortLevel = "high";
  assert.equal(isDraftDirty(base, effortChanged), true, "只改思考级别也算改过");
});

test("diffPlanEdits：只改模型时**带上草稿现有的思考级别**（不能静默清掉）", () => {
  const base = plan({ members: [member({ runtime: { providerId: "openai", modelId: "gpt-5", effortLevel: "high" } })] });
  const draft = draftFromPlan(base);
  draft.members.m1 = { ...draft.members.m1, modelRef: "anthropic/claude-sonnet" };
  const edits = diffPlanEdits(base, draft);
  assert.deepEqual(edits.members, [
    { id: "m1", runtime: { providerId: "anthropic", modelId: "claude-sonnet", effortLevel: "high" } },
  ], "只换模型不该丢掉计划里设好的级别");
});

test("diffPlanEdits：只改思考级别也发 runtime（级别在 runtime 里）", () => {
  const base = plan();
  const draft = draftFromPlan(base);
  draft.members.m1 = { ...draft.members.m1, effortLevel: "xhigh" };
  const edits = diffPlanEdits(base, draft);
  assert.deepEqual(edits.members, [
    { id: "m1", runtime: { providerId: "openai", modelId: "gpt-5", effortLevel: "xhigh" } },
  ]);
});

test("diffPlanEdits：清空思考级别 → runtime 不带 effortLevel（写路径按「未给出=清空」处理）", () => {
  const base = plan({ members: [member({ runtime: { providerId: "openai", modelId: "gpt-5", effortLevel: "high" } })] });
  const draft = draftFromPlan(base);
  draft.members.m1 = { ...draft.members.m1, effortLevel: "" };
  const edits = diffPlanEdits(base, draft);
  assert.deepEqual(edits.members, [{ id: "m1", runtime: { providerId: "openai", modelId: "gpt-5" } }]);
});

test("diffPlanEdits：只把真正改过的字段放进 PATCH 体", () => {
  const base = plan();
  const draft = draftFromPlan(base);
  assert.deepEqual(diffPlanEdits(base, draft), { members: [], tasks: [] }, "未改不动");

  draft.members.m1 = { agentType: "general-purpose", modelRef: "anthropic/claude-sonnet" };
  draft.tasks.t2 = "m2";
  const edits = diffPlanEdits(base, draft);
  assert.deepEqual(edits.members, [
    { id: "m1", runtime: { providerId: "anthropic", modelId: "claude-sonnet" } },
  ], "只换模型：不带 agentType");
  assert.deepEqual(edits.tasks, [{ id: "t2", ownerId: "m2" }]);
});

test("diffPlanEdits：agentType 改动单独成型；取消分配发空串", () => {
  const base = plan();
  const draft = draftFromPlan(base);
  draft.members.m2.agentType = "explore";
  draft.tasks.t1 = "";
  const edits = diffPlanEdits(base, draft);
  assert.deepEqual(edits.members, [{ id: "m2", agentType: "explore" }], "只换 agent：不带 runtime");
  assert.deepEqual(edits.tasks, [{ id: "t1", ownerId: "" }], "空串表示取消分配");
});

test("diffPlanEdits：模型没变的成员不进 PATCH（避免无谓 revision+1）", () => {
  const base = plan();
  const draft = draftFromPlan(base);
  // 同一模型写成不同对象不算改；只有值变化才算。
  draft.members.m1 = { ...draft.members.m1 };
  draft.tasks.t1 = "m1";
  assert.deepEqual(diffPlanEdits(base, draft), { members: [], tasks: [] });
});
// ── interaction.md P2 #4：窄屏横向溢出 ────────────────────────────────────────
// 外层固定 minmax(220,280) + minmax(0,1fr)、任务行再固定 minmax(160,220)：400px
// 视口下右列只剩约 60px，负责人下拉被挤出视口，dialog 出现横向滚动。
// 弹框现在与输入框等宽（可能远窄于视口），断点必须跟随 **弹框内容宽**，所以改成
// CSS 容器查询，而不是视口 matchMedia（视口仍宽时不会切单列 → 内容被挤扁）。
test("列布局改用 CSS 容器查询，PlanEditor 不再按视口切列", async () => {
  const source = (await readFile(new URL("./PlanEditor.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.doesNotMatch(source, /matchMedia/, "不得再按视口宽切列");
  assert.doesNotMatch(source, /useNarrowEditorGrid|planEditorColumns/, "旧视口断点逻辑已移除");
  // 容器挂点
  assert.match(source, /data-testid="team-plan-editor" className="team-plan-editor"/, "编辑器根元素建立 CSS 容器");
  assert.match(source, /className="team-plan-editor-grid"/, "名册/详情两列网格");
  assert.match(source, /className="team-plan-detail-column"/, "详情列自建容器（560 断点相对右列）");
  assert.match(source, /className="team-plan-assignment-grid"/, "成员字段网格");
  assert.match(source, /className="team-plan-task-row"/, "任务行");
  // 旧的行内两列定义必须从 JSX/style 里消失（否则容器查询会被行内样式覆盖）。
  assert.doesNotMatch(source, /gridTemplateColumns: "minmax\(220px/, "行内固定两列会覆盖容器查询");
});

test("容器查询规则落在 app/native-theme.css（760 / 560 断点 + 长文本换行）", async () => {
  const css = (await readFile(new URL("../../app/native-theme.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(css, /\.team-plan-editor\s*\{[^}]*container-type:\s*inline-size/, "编辑器根元素是查询容器");
  assert.match(css, /@container \(min-width: 760px\)[\s\S]*?\.team-plan-editor-grid[^{]*\{[^}]*minmax\(220px, 280px\)/, "760 两列");
  assert.match(css, /@container \(min-width: 560px\)[\s\S]*?\.team-plan-task-row[^{]*\{[^}]*minmax\(160px, 220px\)/, "560 任务行两列");
  assert.match(css, /\.team-plan-detail-column\s*\{[^}]*container-type:\s*inline-size/, "详情列自建容器");
  assert.match(css, /\.team-plan-editor[\s\S]*?overflow-wrap:\s*anywhere/, "长 identifier/path 必须能断行");
});

test("模型生成的长文本字段带 overflowWrap:anywhere（防撑宽弹框）", async () => {
  const source = (await readFile(new URL("./PlanEditor.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const inline = (source.match(/overflowWrap: "anywhere"/g) ?? []).length;
  assert.ok(inline >= 3, `成员名 / 模型行 / 批量区 / 任务标题 / 成员 brief 至少覆盖若干处，实际 ${inline}`);
});
