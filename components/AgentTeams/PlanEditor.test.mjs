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
const {
  splitModelRef,
  joinModelRef,
  diffPlanEdits,
  draftFromPlan,
  isDraftDirty,
  planMemberModelRef,
  isUsableModelRef,
  baselineMemberDraft,
} = await jiti.import("./PlanEditor.tsx");

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

// ── unknown/unknown 占位：pi-team 读不到 PI_PROVIDER_ID/PI_MODEL_ID 时写的假运行时 ──────
// 旧实现把它当普通值：下拉里多一条假选项、diff 把占位值当「用户改过」发回服务端、
// 「跟随队长」写进一个必然 spawn 失败的模型。
test("planMemberModelRef：unknown 占位 / 空运行时都不当作真模型", () => {
  assert.equal(planMemberModelRef({ providerId: "openai", modelId: "gpt-5" }), "openai/gpt-5");
  assert.equal(planMemberModelRef({ providerId: "unknown", modelId: "unknown" }), "", "占位 → 空串");
  assert.equal(planMemberModelRef({ providerId: "openai", modelId: "unknown" }), "", "半边占位也不算");
  assert.equal(planMemberModelRef({ providerId: " ", modelId: "gpt-5" }), "", "空白 provider");
  assert.equal(planMemberModelRef(null), "");
  assert.equal(planMemberModelRef(undefined), "");
});

test("isUsableModelRef：只有真正的 provider/model 才算可用", () => {
  assert.equal(isUsableModelRef("openai/gpt-5"), true);
  assert.equal(isUsableModelRef("openrouter/anthropic/claude-sonnet"), true);
  assert.equal(isUsableModelRef(""), false, "空串 = 未设置");
  assert.equal(isUsableModelRef(null), false);
  assert.equal(isUsableModelRef("gpt-5"), false, "缺 provider");
  assert.equal(isUsableModelRef("unknown/unknown"), false, "占位");
  assert.equal(isUsableModelRef("openai/unknown"), false);
});

test("draftFromPlan：unknown 运行时进草稿是空串（不是 unknown/unknown），且不会被判成 dirty", () => {
  const base = plan({ members: [member({ runtime: { providerId: "unknown", modelId: "unknown" } })] });
  const draft = draftFromPlan(base);
  assert.equal(draft.members.m1.modelRef, "", "下拉显示「未设置」，不是假模型");
  assert.equal(isDraftDirty(base, draft), false, "占位值不算用户改动");
  assert.deepEqual(diffPlanEdits(base, draft), { members: [], tasks: [] }, "不回写 unknown");
});

test("diffPlanEdits：草稿里残留 unknown 占位也不写回服务端", () => {
  const base = plan();
  const draft = draftFromPlan(base);
  draft.members.m1 = { ...draft.members.m1, modelRef: "unknown/unknown" };
  assert.deepEqual(diffPlanEdits(base, draft).members, [], "unknown/unknown 不是合法 runtime");
  draft.members.m1 = { ...draft.members.m1, modelRef: "" };
  assert.deepEqual(diffPlanEdits(base, draft).members, [], "空模型名同样不写");
});

test("baselineMemberDraft：批量操作落到草稿里没有的成员时按计划兜底", () => {
  const base = plan({ members: [member({ runtime: { providerId: "unknown", modelId: "unknown", effortLevel: "high" } })] });
  assert.deepEqual(baselineMemberDraft(base, "m1"), {
    agentType: "general-purpose",
    modelRef: "",
    effortLevel: "high",
  });
  assert.equal(baselineMemberDraft(base, "missing"), null);
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

// ── 联动边界 bug（用户反馈「这一块 bug 挺多」）────────────────────────────────
test("批量设模型：应用后回到占位项，选中同一个模型也能再次生效", async () => {
  const source = (await readFile(new URL("./PlanEditor.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  // Radix 对同值不再触发 onValueChange：旧实现把值留在 batchRef 里，换成员后再选同一个
  // 模型完全没反应（「选完不生效」）。
  assert.match(
    source,
    /onValueChange=\{\(value\) => \{[\s\S]*?setBatchRef\(""\);[\s\S]*?applyModelRef\(value\);[\s\S]*?\}\}/,
    "应用后重置 batchRef",
  );
  // 只在有可用模型时应用（空值 / unknown 占位一律忽略）。
  assert.match(source, /if \(!isUsableModelRef\(ref\) \|\| selected\.length === 0\) return;/);
  // 勾选状态跟着成员表走：计划里删掉的成员 id 必须剔掉。
  assert.match(source, /const memberIdsKey = plan\.members\.map\(\(member\) => member\.id\)\.join\("\\u0000"\)/);
  assert.match(source, /setSelected\(\(current\) => \{\s*\n\s*const next = current\.filter\(\(id\) => ids\.has\(id\)\);/);
});

test("成员详情联动：unknown 运行时不能写回、空模型名有兜底文案、无模型时思考级别禁用", async () => {
  const source = (await readFile(new URL("./PlanEditor.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  // 空 modelRef 的选项标签必须回落到「未设置」，旧实现用 ?? 兜底，空串时标签就是空串。
  assert.match(source, /label: activeModelRef \|\| t\("teams\.plan\.unspecified"\)/);
  assert.doesNotMatch(source, /label: draft\.members\[activeMember\.id\]\?\.modelRef \?\? t\(/);
  // 思考级别依赖 runtime 整体：没有可用模型就禁用（否则改了发不出去，看起来像被吞掉）。
  assert.match(source, /const activeModelUsable = isUsableModelRef\(activeModelRef\);/);
  assert.match(source, /disabled=\{!editable \|\| !activeModelUsable\}/);
  // 恢复建议 / 跟随队长都走 planMemberModelRef（unknown 占位 → 空串，不是假模型）。
  assert.match(source, /modelRef: planMemberModelRef\(member\.runtime\)/);
  assert.match(source, /applyModelRef\(planMemberModelRef\(plan\.leaderRuntime\)\)/);
  assert.doesNotMatch(source, /joinModelRef\(plan\.leaderRuntime!/, "不再对 leaderRuntime 做非空断言");
  // 任务负责人下拉在草稿缺这个任务时显示计划里的真实值，而不是误报「未分配」。
  assert.match(source, /value=\{draft\.tasks\[task\.id\] \?\? task\.ownerId \?\? ""\}/);
  // 成员数文案与只读分支同一个 key。
  assert.match(source, /t\("teams\.plan\.memberCount", \{ count: plan\.members\.length \}\)/);
});
