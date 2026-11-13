import assert from "node:assert/strict";
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

test("draftFromPlan：基线原样来自 plan", () => {
  const draft = draftFromPlan(plan());
  assert.deepEqual(draft.members.m1, { agentType: "general-purpose", modelRef: "openai/gpt-5" });
  assert.deepEqual(draft.members.m2, { agentType: "general-purpose", modelRef: "openai/gpt-5" });
  assert.equal(draft.tasks.t1, "m1");
  assert.equal(draft.tasks.t2, "", "未分配 → 空串（下拉的「未分配」值）");
});

test("isDraftDirty：未改 → false；改模型 / agent / owner → true", () => {
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