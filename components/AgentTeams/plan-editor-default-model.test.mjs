import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 团队计划卡：模型的默认值是**当前会话主模型**，且可以改。
 *
 * 用户原话：「那个弹框默认模型设置为主模型可修改」。
 *
 * 为什么之前做不到：计划里成员的 `runtime` 在真实机器上通常是 `unknown/unknown`
 * （pi-team 读 `PI_PROVIDER_ID`/`PI_MODEL_ID`，本服务从不设置这两个 env），归一后是空串，
 * 于是模型栏显示「未设置」——用户看到的是一个空下拉，只能从头挑。
 *
 * 三条口径（缺一条就会退化成「打开就有未保存更改」或「改了不生效」）：
 * 1. `draftFromPlan` 在没有可用 runtime 时用主模型预填；
 * 2. `diffPlanEdits` 用**同一个** fallback 当基线，所以「预填值 = 基线」不算改动
 *    （否则一打开弹框就 `dirty`，还会拦住草稿基线随轮询更新）；
 * 3. 用户真的换了一个模型时，diff 仍然会把它写进 PATCH。
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const editor = await jiti.import("./PlanEditor.tsx");

const plan = {
  planId: "p1",
  sessionId: "s1",
  teamName: "demo",
  incarnationId: "inc1",
  state: "review_pending",
  revision: 3,
  leaderRuntime: { providerId: "unknown", modelId: "unknown" },
  members: [
    { id: "m1", name: "alice", agentType: "general", runtime: { providerId: "unknown", modelId: "unknown", effortLevel: "" } },
    { id: "m2", name: "bob", agentType: "general", runtime: { providerId: "openai", modelId: "gpt-5", effortLevel: "" } },
  ],
  tasks: [],
};

const MAIN = "deepseek/deepseek-v4.1-flash";

test("members with an unknown runtime are pre-filled with the session's main model", () => {
  const draft = editor.draftFromPlan(plan, MAIN);
  assert.equal(draft.members.m1.modelRef, MAIN, "unknown runtime → main model, not an empty select");
  assert.equal(draft.members.m2.modelRef, "openai/gpt-5", "a real planned model is kept as-is");
});

test("the pre-fill is NOT reported as an edit (opening the dialog must not look dirty)", () => {
  const draft = editor.draftFromPlan(plan, MAIN);
  assert.equal(editor.isDraftDirty(plan, draft, MAIN), false, "same baseline ⇒ nothing changed");
  assert.deepEqual(editor.diffPlanEdits(plan, draft, MAIN), { members: [], tasks: [] });
});

test("the pre-fill does get written once the user approves without touching it", () => {
  // 预填是「真值」而不是占位符：不动它也应该按主模型批准，否则成员会带着 unknown 去 spawn。
  // 这由「草稿 ≠ 计划基线」在批准时体现——用空 fallback 比较即可看清它确实与计划不同。
  const draft = editor.draftFromPlan(plan, MAIN);
  assert.equal(editor.isDraftDirty(plan, draft, ""), true, "against the raw plan it IS a change");
  const edits = editor.diffPlanEdits(plan, draft, "");
  assert.ok(edits.members.some((m) => m.id === "m1"), "m1 gets the real model on write");
});

test("changing the model in the draft is still reported as an edit", () => {
  const draft = editor.draftFromPlan(plan, MAIN);
  draft.members.m1.modelRef = "anthropic/claude-sonnet";
  const edits = editor.diffPlanEdits(plan, draft, MAIN);
  const m1 = edits.members.find((m) => m.id === "m1");
  assert.ok(m1, "the changed member is in the patch");
  assert.deepEqual(m1.runtime, { providerId: "anthropic", modelId: "claude-sonnet" });
});

test("with no main model available, an unknown runtime stays empty (honest `未设置`)", () => {
  const draft = editor.draftFromPlan(plan, "");
  assert.equal(draft.members.m1.modelRef, "");
  assert.equal(editor.isDraftDirty(plan, draft, ""), false);
});
