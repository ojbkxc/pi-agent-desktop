import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 定时重复调度器（`lib/goal/goal-repeat.ts`）：「到点投递、先排后投、忙则回滚」。
 * 全部注入假实现，不碰磁盘/网络。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const mod = await jiti.import("./goal-repeat.ts");

const NOW = 2_000_000;
const H = 3_600_000;

const goal = (patch = {}) => ({
  sessionId: "s-1",
  objective: "x",
  status: "active",
  continuations: 2,
  maxContinuations: 20,
  startedAt: NOW - H,
  elapsedMs: H,
  updatedAt: NOW - H,
  intervalMs: 2 * H,
  nextRunAt: NOW - 1,
  ...patch,
});

function deps(patch = {}) {
  const advanced = [];
  const delivered = [];
  return {
    advanced,
    delivered,
    deps: {
      now: () => NOW,
      listGoals: () => [goal()],
      advance: (state) => { advanced.push(state); },
      deliver: async (state) => { delivered.push(state.sessionId); return "delivered"; },
      log: () => {},
      ...patch,
    },
  };
}

test("到点的定时目标 ⇒ 投递一次，且 nextRunAt 先推到下一档", async () => {
  const { deps: d, advanced, delivered } = deps();
  const actions = await mod.runGoalRepeatTick(d);
  assert.deepEqual(delivered, ["s-1"]);
  assert.deepEqual(actions, [{ sessionId: "s-1", outcome: "delivered" }]);
  assert.equal(advanced[0].nextRunAt, NOW + 2 * H, "下一档 = now + 间隔");
  assert.ok(actions.length === 1, "一次 tick 只投一次");
});

test("未到点 / 非 active / 无间隔 ⇒ 都不投；三种都出现在动作里（便于观察）", async () => {
  const cases = [
    { state: goal({ nextRunAt: NOW + H }), outcome: "skipped-not-due" },
    { state: goal({ status: "paused" }), outcome: "skipped-not-active" },
    { state: goal({ intervalMs: 0 }), outcome: null },
  ];
  for (const item of cases) {
    const { deps: d, delivered } = deps({ listGoals: () => [item.state] });
    const actions = await mod.runGoalRepeatTick(d);
    assert.deepEqual(delivered, [], JSON.stringify(item.outcome));
    if (item.outcome) assert.equal(actions[0]?.outcome, item.outcome);
    else assert.equal(actions.length, 0, "无间隔的目标不归调度器管");
  }
});

test("7 天窗用尽 ⇒ exhausted，不投递也不排下一轮", async () => {
  const old = goal({ intervalMs: 24 * H, startedAt: NOW - 7 * 24 * H });
  const { deps: d, delivered, advanced } = deps({ listGoals: () => [old] });
  const actions = await mod.runGoalRepeatTick(d);
  assert.deepEqual(delivered, []);
  assert.deepEqual(advanced, []);
  assert.equal(actions[0].outcome, "exhausted");
});

test("会话正忙（busy）⇒ 把 nextRunAt 回滚到原值，这一档空档不丢", async () => {
  const { deps: d, advanced, delivered } = deps({ deliver: async () => "busy" });
  const actions = await mod.runGoalRepeatTick(d);
  assert.deepEqual(delivered, [], "忙时不投");
  assert.equal(actions[0].outcome, "skipped-busy");
  assert.equal(advanced.length, 2, "先排下一档，再回滚");
  assert.equal(advanced[1].nextRunAt, NOW - 1, "回滚到原来的 nextRunAt");
});

test("投递失败 ⇒ deliver-failed，但 nextRunAt 已被推进（不无限重试同一档）", async () => {
  const { deps: d, advanced } = deps({ deliver: async () => "failed" });
  const actions = await mod.runGoalRepeatTick(d);
  assert.equal(actions[0].outcome, "deliver-failed");
  assert.equal(advanced[0].nextRunAt, NOW + 2 * H, "失败档也推进，避免同一档无限重试");
});

test("deliver 抛异常 ⇒ deliver-failed 带 detail，不影响其它目标", async () => {
  const { deps: d } = deps({
    listGoals: () => [goal({ sessionId: "s-1" }), goal({ sessionId: "s-2" })],
    deliver: async (state) => { if (state.sessionId === "s-1") throw new Error("boom"); return "delivered"; },
  });
  const actions = await mod.runGoalRepeatTick(d);
  assert.equal(actions[0].outcome, "deliver-failed");
  assert.match(actions[0].detail, /boom/);
  assert.equal(actions[1].outcome, "delivered", "第二条照常投递");
});

test("listGoals 抛异常 ⇒ 返回空、不崩（一条坏目录不能卡死调度）", async () => {
  const { deps: d } = deps({ listGoals: () => { throw new Error("ENOENT"); } });
  assert.deepEqual(await mod.runGoalRepeatTick(d), []);
});

test("start/stop 循环幂等：第二次 start 不叠第二个 timer", () => {
  const { deps: d } = deps();
  mod.startGoalRepeatSchedulerLoop({ ...d, tickMs: 10_000 });
  mod.startGoalRepeatSchedulerLoop({ ...d, tickMs: 10_000 });
  mod.stopGoalRepeatSchedulerLoop();
  mod.stopGoalRepeatSchedulerLoop();
  assert.ok(true, "不抛错即通过");
});

test("定时续跑提示点明「距上一轮已过一段时间」（模型不该假设旧结论仍有效）", () => {
  assert.match(mod.GOAL_CONTINUE_PROMPT_FOR_REPEAT, /Time has passed/i);
  assert.match(mod.GOAL_CONTINUE_PROMPT_FOR_REPEAT, /check the current state/i);
});