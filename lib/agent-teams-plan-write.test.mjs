import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 计划编辑写路径（PATCH /api/teams/[team]/plan → lib/agent-teams-plan-write.ts）。
 *
 * 钉住四件事：
 *  1. 只覆盖允许的字段（runtime / agentType / ownerId），其余逐字保留；
 *  2. expectedRevision 不匹配 → 409（乐观并发）；
 *  3. 保存后**保持** draft / review_pending（评审中保存不打回草稿）；
 *  4. 图校验失败不落盘（非法成员名 / 未知 owner / 依赖环）。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { applyTeamPlanEdits, applyEdits, validatePlanGraph, TeamPlanWriteError } =
  await jiti.import("./agent-teams-plan-write.ts");

const BASE_PLAN = {
  schemaVersion: 1,
  planId: "plan-1",
  sessionId: "session-1",
  teamName: "demo",
  incarnationId: "inc-1",
  revision: 3,
  state: "review_pending",
  workDir: "D:/proj",
  leaderRuntime: { providerId: "p1", modelId: "m-lead" },
  members: [
    {
      id: "m-impl",
      name: "impl",
      agentType: "general-purpose",
      prompt: "干活",
      runtime: { providerId: "p1", modelId: "m-old", effortLevel: "medium" },
      reason: "因为合适",
      difficulty: "high",
    },
    { id: "m-qa", name: "qa", agentType: "general-purpose", prompt: "验证", runtime: { providerId: "p1", modelId: "m-old" } },
  ],
  tasks: [
    { id: "t1", subject: "实现", ownerId: "m-impl", dependencies: [] },
    { id: "t2", subject: "验证", dependencies: ["t1"] },
  ],
  createdAt: 1,
  updatedAt: 1,
};

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-write-"));
  const previous = process.env.PI_TEAM_DIR;
  process.env.PI_TEAM_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_TEAM_DIR;
    else process.env.PI_TEAM_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, "demo");
  await mkdir(dir, { recursive: true });
  const write = (plan) => writeFile(join(dir, "plan.json"), JSON.stringify(plan));
  await write(BASE_PLAN);
  return { dir, write };
}

const identity = (overrides = {}) => ({
  planId: "plan-1",
  sessionId: "session-1",
  incarnationId: "inc-1",
  expectedRevision: 3,
  ...overrides,
});

test("改成员模型与 agent 预设：只覆盖这两个字段，其余逐字保留；revision +1、状态不变", async (t) => {
  await setup(t);
  const plan = await applyTeamPlanEdits("demo", identity({
    members: [{ id: "m-impl", agentType: "explore", runtime: { providerId: "p2", modelId: "m-new" } }],
  }));
  const impl = plan.members.find((member) => member.id === "m-impl");
  assert.equal(impl.agentType, "explore");
  assert.deepEqual(impl.runtime, { providerId: "p2", modelId: "m-new" });
  assert.equal(impl.prompt, "干活", "prompt 保留");
  assert.equal(impl.reason, "因为合适", "reason 保留");
  assert.equal(impl.difficulty, "high", "difficulty 保留");
  assert.equal(plan.revision, 4);
  assert.equal(plan.state, "review_pending", "评审中保存不打回草稿");
  assert.equal(plan.members.find((member) => member.id === "m-qa").runtime.modelId, "m-old", "未提到的成员不动");
});

test("改任务负责人：空串表示取消分配", async (t) => {
  await setup(t);
  const plan = await applyTeamPlanEdits("demo", identity({
    tasks: [{ id: "t2", ownerId: "m-qa" }, { id: "t1", ownerId: "" }],
  }));
  assert.equal(plan.tasks.find((task) => task.id === "t2").ownerId, "m-qa");
  assert.equal(plan.tasks.find((task) => task.id === "t1").ownerId, undefined, "取消分配后字段消失");
});

test("expectedRevision 不匹配 → 409，磁盘不变", async (t) => {
  const { dir } = await setup(t);
  await assert.rejects(
    () => applyTeamPlanEdits("demo", identity({ expectedRevision: 2 })),
    (error) => error instanceof TeamPlanWriteError && error.status === 409,
  );
  const raw = JSON.parse(await readFile(join(dir, "plan.json"), "utf8"));
  assert.equal(raw.revision, 3, "失败不落盘");
});

test("状态不是 draft / review_pending → 409（运行中的计划不能改）", async (t) => {
  const { write } = await setup(t);
  await write({ ...BASE_PLAN, state: "running" });
  await assert.rejects(
    () => applyTeamPlanEdits("demo", identity()),
    (error) => error instanceof TeamPlanWriteError && error.status === 409,
  );
});

test("图校验失败不落盘：非法成员名 / 未知 owner / 依赖环", async (t) => {
  const { dir } = await setup(t);
  // 真正非法的是成员**名字**，直接测纯校验器（agentType 改成 team-lead 是合法的）。
  assert.throws(() => validatePlanGraph({ ...BASE_PLAN, members: [{ ...BASE_PLAN.members[0], name: "team-lead" }] }));
  assert.throws(() => validatePlanGraph({ ...BASE_PLAN, tasks: [{ id: "t1", subject: "x", ownerId: "nope", dependencies: [] }] }));
  assert.throws(() => validatePlanGraph({
    ...BASE_PLAN,
    tasks: [
      { id: "t1", subject: "a", dependencies: ["t2"] },
      { id: "t2", subject: "b", dependencies: ["t1"] },
    ],
  }), /环/);
  // 通过写路径提交一个非法 owner：必须抛错且不落盘。
  await assert.rejects(
    () => applyTeamPlanEdits("demo", identity({ tasks: [{ id: "t1", ownerId: "ghost" }] })),
    (error) => error instanceof TeamPlanWriteError && error.status === 400,
  );
  const raw = JSON.parse(await readFile(join(dir, "plan.json"), "utf8"));
  assert.equal(raw.revision, 3, "校验失败不落盘");
});

test("applyEdits 就地改写传入对象（调用方负责先 structuredClone）", () => {
  // 契约：applyTeamPlanEdits 先 structuredClone 磁盘内容再调它，所以这里就地改是刻意的
  // ——省一次整份深拷贝，也让 `next` 与入参同源。固定这条契约，避免有人误以为它是纯函数。
  const plan = structuredClone(BASE_PLAN);
  const next = applyEdits(plan, {
    planId: "plan-1", sessionId: "session-1", incarnationId: "inc-1", expectedRevision: 3,
    members: [{ id: "m-impl", runtime: { providerId: "p9", modelId: "m9" } }],
  });
  assert.equal(next, plan, "返回的就是入参对象");
  assert.equal(plan.members[0].runtime.modelId, "m9");
});