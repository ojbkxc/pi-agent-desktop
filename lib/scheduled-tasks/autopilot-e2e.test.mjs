import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { makeDeps } from "./test-helpers.mjs";

/**
 * 无人值守「定时任务失败 → 自动建 autofix」的进程内端到端测试。
 *
 * 走真实 Scheduler.tick() + 真实 autopilot 设置读取 + 真实 autofix store/detect，
 * 只把「启动修复引擎」这一步用注入的 autofixStart 拦住（不真跑 npm test / 不建修复
 * 会话）。这正是 autofixStart 注入点的用途：默认路径仍动态 import 真 runner。
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { Scheduler } = await jiti.import("./scheduler.ts");
const store = await jiti.import("./store.ts");
const autofixStore = await jiti.import("../autofix/store.ts");
const autopilotLib = await jiti.import("../autopilot.ts");

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const at = (iso) => new Date(iso);

/** 轮询直到 predicate 为真（maybeAutoFix 是 fire-and-forget，不等 run 记录）。 */
async function waitUntil(predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function flush(turns = 100) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function setup(t, { behavior = () => "error", autopilot = { enabled: true, autoFixFailedRuns: true, maxAutoFixRounds: 2, autoApproveTeamPlans: true } } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-autopilot-"));
  const work = mkdtempSync(join(tmpdir(), "pi-web-autopilot-cwd-"));
  t.after(() => { rmSync(agentDir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

  // 工作目录 = 一个能探测出验证命令的 git 仓库（.git 目录即可，无需真提交）。
  mkdirSync(join(work, ".git"), { recursive: true });
  writeFileSync(
    join(work, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: 'node -e "process.exit(1)"' } }, null, 2)}\n`,
  );

  // autopilot 设置：maybeAutoFix 读 <agentDir>/pi-web/settings.json。
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  writeFileSync(join(agentDir, "pi-web", "settings.json"), `${JSON.stringify({ autopilot }, null, 2)}\n`);

  const clock = { now: at("2026-10-07T09:00:30Z") };
  const deps = makeDeps({ behavior, clock: () => clock.now });
  const startedIds = [];
  const scheduler = new Scheduler({
    runnerDeps: deps,
    agentDir,
    pid: 100,
    isPidAlive: () => true,
    now: () => clock.now,
    autofixStart: (taskId) => { startedIds.push(taskId); },
  });

  const addTask = (n, extra = {}) => store.mutateTasks((tasks) => {
    const task = {
      id: ID(n), name: `task ${n}`, prompt: "go", cwd: work,
      schedule: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
      toolPreset: "read-only", maxDurationMin: 30, enabled: true,
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
      lastScheduledFor: "2026-10-06T09:00:00.000Z", consecutiveFailures: 0, ...extra,
    };
    return { tasks: [...tasks, task], result: task };
  }, agentDir);

  const settle = async () => {
    for (let i = 0; i < 200 && scheduler.activeRunCount() > 0; i += 1) await new Promise((r) => setImmediate(r));
  };

  return { agentDir, work, deps, scheduler, addTask, settle, startedIds };
}

test("定时任务失败 → autopilot 自动建 autofix 任务，并把 id 交给注入的 autofixStart", async (t) => {
  const s = setup(t);
  s.addTask(1);
  await s.scheduler.tick();
  await s.settle();
  await waitUntil(() => autofixStore.listAutofixTasks(s.agentDir).length > 0 && s.startedIds.length > 0, "autofix created + started");

  const [run] = store.listRuns(ID(1), s.agentDir);
  assert.equal(run.status, "failed", "运行应记为失败（provider 中断以外的真失败）");
  assert.equal(run.error, "boom");

  const tasks = autofixStore.listAutofixTasks(s.agentDir);
  assert.equal(tasks.length, 1, "恰好建一条 autofix 任务");
  const [created] = tasks;
  assert.ok(
    created.task.includes(`[scheduled:${ID(1)}:${run.runId}]`),
    "任务文本带 [scheduled:<taskId>:<runId>] 幂等标记",
  );
  assert.equal(created.cwd, s.work, "工作目录 = 失败任务的工作目录");
  assert.equal(created.verifyCommand, "npm test", "从 package.json 探测出验证命令");
  assert.equal(created.maxRounds, 2, "轮次上限取自 autopilot 设置");
  assert.deepEqual(s.startedIds, [created.id], "注入的 autofixStart 收到该任务 id");
});

test("autopilot 关闭时不建 autofix 任务", async (t) => {
  const s = setup(t, { autopilot: { enabled: false, autoFixFailedRuns: true, maxAutoFixRounds: 2, autoApproveTeamPlans: true } });
  s.addTask(1);
  await s.scheduler.tick();
  await s.settle();
  await flush();
  assert.equal(store.listRuns(ID(1), s.agentDir)[0].status, "failed", "运行确实失败了");
  assert.equal(autofixStore.listAutofixTasks(s.agentDir).length, 0, "总开关关闭 → 不建任务");
  assert.deepEqual(s.startedIds, [], "关闭时 autofixStart 从未被调用");
});

test("autoFixFailedRuns 子开关关闭时不建 autofix 任务", async (t) => {
  const s = setup(t, { autopilot: { enabled: true, autoFixFailedRuns: false, maxAutoFixRounds: 2, autoApproveTeamPlans: true } });
  s.addTask(1);
  await s.scheduler.tick();
  await s.settle();
  await flush();
  assert.equal(autofixStore.listAutofixTasks(s.agentDir).length, 0, "子开关关闭 → 不建任务");
  assert.deepEqual(s.startedIds, []);
});

test("超引擎上限的 maxAutoFixRounds 被回落而不是静默跳过修复", async (t) => {
  // 修复前：autopilot 允许 21..50，autofix store 只接受 1..20，createAutofixTask 抛错
  // 被 maybeAutoFix 的 catch 吞掉 → 失败运行既没有修复也没有任何提示。
  const s = setup(t, { autopilot: { enabled: true, autoFixFailedRuns: true, maxAutoFixRounds: 21, autoApproveTeamPlans: true } });
  s.addTask(1);
  await s.scheduler.tick();
  await s.settle();
  await waitUntil(() => autofixStore.listAutofixTasks(s.agentDir).length > 0, "autofix created");

  const [created] = autofixStore.listAutofixTasks(s.agentDir);
  assert.equal(created.maxRounds, autopilotLib.AUTOPILOT_DEFAULTS.maxAutoFixRounds, "越界值读取时回落到默认");
  assert.deepEqual(s.startedIds, [created.id], "修复任务确实被启动");
});