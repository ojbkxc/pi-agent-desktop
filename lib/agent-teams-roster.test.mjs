import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * config ∪ plan 合并名册（lib/agent-teams-roster.ts）：
 * 三处调用点（stop/reclaim、ended、全局配额）与泳道 buildRoster 的合并口径必须逐字段一致。
 */
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { mergeRosterMembers, readMergedRoster, readPlanRosterMembers } =
  await jiti.import("./agent-teams-roster.ts");

const CONFIG_MEMBERS = [
  { agentId: "m-lead", name: "team-lead" },
  { agentId: "m-impl", name: "impl", sessionId: "sess-impl" },
];

test("mergeRosterMembers：config 在前，plan 独有成员按序追加，同名以 config 为准", async () => {
  const merged = mergeRosterMembers(CONFIG_MEMBERS, [
    { agentId: "p-impl", name: "impl" }, // 同名：config 为准，不重复追加
    { agentId: "p-qa", name: "qa" }, // plan 独有：追加
    { agentId: "p-docs", name: "docs" }, // plan 独有：追加
  ]);
  assert.deepEqual(merged, [
    { agentId: "m-lead", name: "team-lead" },
    { agentId: "m-impl", name: "impl", sessionId: "sess-impl" },
    { agentId: "p-qa", name: "qa" },
    { agentId: "p-docs", name: "docs" },
  ]);
});

test("mergeRosterMembers：空 plan / 空 config 的边界", async () => {
  assert.deepEqual(mergeRosterMembers(CONFIG_MEMBERS, []), CONFIG_MEMBERS);
  assert.deepEqual(mergeRosterMembers([], [{ agentId: "p-qa", name: "qa" }]), [
    { agentId: "p-qa", name: "qa" },
  ]);
  // plan 成员无 id 时回退成员名（同 buildRoster）。
  assert.deepEqual(mergeRosterMembers([], [{ agentId: "qa", name: "qa" }]), [
    { agentId: "qa", name: "qa" },
  ]);
});

test("readMergedRoster：config + plan 合并落盘口径", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-roster-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({
    name: "demo",
    leadAgentId: "m-lead",
    members: CONFIG_MEMBERS,
  }));
  await writeFile(join(dir, "plan.json"), JSON.stringify({
    planId: "plan-1",
    members: [
      { id: "p-impl", name: "impl", runtime: { modelId: "m1" } },
      { id: "p-qa", name: "qa", runtime: { modelId: "m2" } },
      { name: "no-id" }, // 无 id：回退成员名
      { name: "" }, // 无名：跳过
      "junk", // 非对象：跳过
    ],
  }));

  const merged = await readMergedRoster(dir);
  assert.deepEqual(merged, [
    { agentId: "m-lead", name: "team-lead" },
    { agentId: "m-impl", name: "impl", sessionId: "sess-impl" },
    { agentId: "p-qa", name: "qa", runtime: { modelId: "m2" } },
    { agentId: "no-id", name: "no-id" },
  ]);
});

test("readMergedRoster：config 缺失/损坏 ⇒ null（不静默当空名册）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-roster-merge2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, "nope");
  await mkdir(missing, { recursive: true });
  assert.equal(await readMergedRoster(missing), null, "config 缺失 ⇒ null");

  await writeFile(join(missing, "config.json"), "{ not json");
  assert.equal(await readMergedRoster(missing), null, "config 损坏 ⇒ null");

  await writeFile(join(missing, "config.json"), JSON.stringify({ members: "junk" }));
  assert.equal(await readMergedRoster(missing), null, "config members 不是数组 ⇒ null");
});

test("readPlanRosterMembers：plan 缺失/损坏 ⇒ 空表（容错，不阻断合并）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-roster-merge3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, "nope");
  await mkdir(missing, { recursive: true });
  assert.deepEqual(await readPlanRosterMembers(missing), [], "plan 缺失 ⇒ 空表");

  await writeFile(join(missing, "plan.json"), "{ broken");
  assert.deepEqual(await readPlanRosterMembers(missing), [], "plan 损坏 ⇒ 空表");

  await writeFile(join(missing, "plan.json"), JSON.stringify({ members: [] }));
  assert.deepEqual(await readPlanRosterMembers(missing), [], "plan 无成员 ⇒ 空表");

  await writeFile(join(missing, "plan.json"), JSON.stringify({
    members: [{ id: "p-1", name: "alpha" }, "junk", null],
  }));
  assert.deepEqual(await readPlanRosterMembers(missing), [{ agentId: "p-1", name: "alpha" }]);
});
