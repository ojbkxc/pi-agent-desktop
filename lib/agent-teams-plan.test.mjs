import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * B3 计划卡的**纯逻辑**：可见性、审批前置校验、成员名合法性、幂等键、投递 prompt、
 * identity 并发校验。全部无 DOM / 无 fs。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const plan = await jiti.import("@/lib/agent-teams-plan.ts");

const member = (over = {}) => ({
  id: "m1",
  name: "impl",
  agentType: "general-purpose",
  prompt: "do it",
  runtime: { providerId: "openai", modelId: "gpt-5" },
  ...over,
});
const task = (over = {}) => ({ id: "t1", subject: "build", dependencies: [], ...over });
const view = (over = {}) => ({
  planId: "p-1",
  sessionId: "s-1",
  teamName: "demo",
  incarnationId: "inc-1",
  state: "review_pending",
  revision: 3,
  leaderRuntime: { providerId: "openai", modelId: "gpt-5" },
  members: [member()],
  tasks: [task({ ownerId: "m1" })],
  updatedAt: 0,
  ...over,
});

test("isPlanState 只认 7 个已知状态", () => {
  for (const state of ["draft", "review_pending", "launching", "running", "launch_failed", "cancelled", "interrupted"]) {
    assert.equal(plan.isPlanState(state), true, state);
  }
  for (const bad of ["", "pending", "DRAFT", null, 7, undefined]) {
    assert.equal(plan.isPlanState(bad), false, String(bad));
  }
});

test("isPlanCardVisible：无 plan / launching / running / cancelled 无 parent 隐藏", () => {
  assert.equal(plan.isPlanCardVisible(null), false);
  assert.equal(plan.isPlanCardVisible(undefined), false);
  assert.equal(plan.isPlanCardVisible({ state: "launching" }), false);
  assert.equal(plan.isPlanCardVisible({ state: "running" }), false);
  assert.equal(plan.isPlanCardVisible({ state: "cancelled" }), false, "自己取消、无 parent → 隐藏");
  assert.equal(plan.isPlanCardVisible({ state: "cancelled", parentPlanId: "p-prev" }), true, "增量计划保留给 Stop");
  for (const state of ["draft", "review_pending", "launch_failed", "interrupted"]) {
    assert.equal(plan.isPlanCardVisible({ state }), true, state);
  }
});

test("isValidTeamMemberName 与 pi-team 一致：字母数字下划线连字符，team-lead 保留", () => {
  assert.equal(plan.isValidTeamMemberName("impl"), true);
  assert.equal(plan.isValidTeamMemberName("a-b_c1"), true);
  assert.equal(plan.isValidTeamMemberName("中文名"), true);
  assert.equal(plan.isValidTeamMemberName("team-lead"), false);
  assert.equal(plan.isValidTeamMemberName("has space"), false);
  assert.equal(plan.isValidTeamMemberName(""), false);
});

test("derivePlanReview：未分配任务 / 非法成员名；只读态 presetChanged 恒 false", () => {
  const clean = plan.derivePlanReview(view());
  assert.deepEqual(clean, { hasUnassignedTasks: false, invalidNames: [], presetChanged: false });

  const unassigned = plan.derivePlanReview(view({
    members: [member()],
    tasks: [task({ ownerId: undefined }), task({ id: "t2", ownerId: "ghost" })],
  }));
  assert.equal(unassigned.hasUnassignedTasks, true, "缺 owner 或 owner 不存在都算未分配");

  const invalid = plan.derivePlanReview(view({ members: [member({ name: "team-lead" })] }));
  assert.deepEqual(invalid.invalidNames, ["team-lead"]);
});

test("isApproveDisabled = presetChanged || hasUnassignedTasks || invalidNames>0", () => {
  assert.equal(plan.isApproveDisabled(view()), false);
  assert.equal(plan.isApproveDisabled(view({ tasks: [task({ ownerId: undefined })] })), true);
  assert.equal(plan.isApproveDisabled(view({ members: [member({ name: "team-lead" })] })), true);
});

test("desktopApprovalRequestId 由 planId + revision 确定性生成", () => {
  const a = plan.desktopApprovalRequestId({ planId: "p-1", revision: 3 });
  const b = plan.desktopApprovalRequestId({ planId: "p-1", revision: 3 });
  const c = plan.desktopApprovalRequestId({ planId: "p-1", revision: 4 });
  assert.equal(a, b, "同 plan 同 revision 恒同 id");
  assert.notEqual(a, c, "revision 变则 id 变");
  assert.match(a, /desktop-approve-p-1-r3/);
});

test("buildUserApprovalPrompt：带上 planId/revision/确定性 request_id，并要求 approve 后再 launch", () => {
  const text = plan.buildUserApprovalPrompt(view());
  assert.match(text, /demo/);
  assert.match(text, /p-1/);
  assert.match(text, /revision=3/);
  assert.match(text, /desktop-approve-p-1-r3/, "只允许用确定性 request_id");
  assert.match(text, /launch/, "必须显式 launch（approve 不自动派发）");
  assert.match(text, /committed=false|幂等/, "提醒幂等命中不要重复批准");
});

test("checkPlanIdentity：四字段一致才通过", () => {
  const id = { planId: "p-1", sessionId: "s-1", incarnationId: "inc-1", expectedRevision: 3 };
  assert.equal(plan.checkPlanIdentity(view(), id).ok, true);
  assert.equal(plan.checkPlanIdentity(view({ revision: 4 }), id).ok, false, "revision 不匹配");
  assert.equal(plan.checkPlanIdentity(view({ incarnationId: "other" }), id).ok, false);
  assert.equal(plan.checkPlanIdentity(view({ sessionId: "other" }), id).ok, false);
  assert.equal(plan.checkPlanIdentity(view({ planId: "other" }), id).ok, false);
});

test("isUsableRuntime：pi-team 的占位 unknown/unknown 不算可用运行时", () => {
  assert.equal(plan.isUsableRuntime({ providerId: "openai", modelId: "gpt-5" }), true);
  assert.equal(plan.isUsableRuntime({ providerId: "openai", modelId: " a/b " }), true, "两端空白不算空");
  // 本服务进程从不设置 PI_PROVIDER_ID / PI_MODEL_ID，pi-team 写下的 leaderRuntime 恒是这对占位值。
  assert.equal(plan.isUsableRuntime({ providerId: "unknown", modelId: "unknown" }), false);
  assert.equal(plan.isUsableRuntime({ providerId: "unknown", modelId: "gpt-5" }), false);
  assert.equal(plan.isUsableRuntime({ providerId: "openai", modelId: "unknown" }), false);
  assert.equal(plan.isUsableRuntime({ providerId: "", modelId: "gpt-5" }), false);
  assert.equal(plan.isUsableRuntime({ providerId: "openai", modelId: "" }), false);
  assert.equal(plan.isUsableRuntime(null), false);
  assert.equal(plan.isUsableRuntime(undefined), false);
});

test("isPlanApprovable：只有 review_pending 能批准（其余状态批准路由一律 409）", () => {
  assert.equal(plan.isPlanApprovable(view({ state: "review_pending" })), true);
  for (const state of ["draft", "launching", "running", "launch_failed", "cancelled", "interrupted"]) {
    assert.equal(plan.isPlanApprovable(view({ state })), false, state);
  }
});
