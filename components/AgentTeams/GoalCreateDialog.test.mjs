import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 「新建目标」弹窗的纯逻辑：`buildGoalCommand` 与 Start 的可用性判据。
 * 不渲染（没有 DOM 环境）：组件里那一层就是这两条纯函数的薄封装。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const mod = await jiti.import("./GoalCreateDialog.tsx");
const interval = await jiti.import("../../lib/goal/goal-interval.ts");

test("buildGoalCommand：条件 + 间隔 ⇒ /goal <条件> --every 2h", () => {
  assert.equal(
    mod.buildGoalCommand({ condition: "npm test exits 0", repeat: "2h" }),
    "/goal npm test exits 0 --every 2h",
  );
});

test("buildGoalCommand：不写间隔 ⇒ 只有目标正文（连续续跑）", () => {
  assert.equal(
    mod.buildGoalCommand({ condition: "npm test exits 0", repeat: "" }),
    "/goal npm test exits 0",
  );
  assert.equal(
    mod.buildGoalCommand({ condition: "把页面做完", repeat: "不停迭代该项目" }),
    "/goal 把页面做完",
    "没有间隔前缀的重复栏是纯备注，不进命令",
  );
});

test("buildGoalCommand：注释文字不进命令（避免它变成目标正文的一部分）", () => {
  const command = mod.buildGoalCommand({ condition: "跑绿", repeat: "1d 不停迭代该项目" });
  assert.equal(command, "/goal 跑绿 --every 1d");
  assert.doesNotMatch(command, /不停迭代/);
});

test("buildGoalCommand：越界间隔不生成 --every（与 parseGoalRepeat 同一判据）", () => {
  assert.equal(mod.buildGoalCommand({ condition: "x", repeat: "5s" }), "/goal x");
  assert.equal(mod.buildGoalCommand({ condition: "x", repeat: "30d" }), "/goal x");
});

test("buildGoalCommand：两栏皆空 ⇒ 只有 /goal（调用方靠 canStart 拦住，不会发出去）", () => {
  assert.equal(mod.buildGoalCommand({ condition: "  ", repeat: "  " }), "/goal");
});

test("Start 的可用性判据与 buildGoalCommand 一致：有正文或有合法间隔", () => {
  // 组件的 canStart = condition.trim().length > 0 || parsed.intervalMs > 0
  const cases = [
    { condition: "", repeat: "不停迭代该项目", usable: false },
    { condition: "npm test exits 0", repeat: "", usable: true },
    { condition: "", repeat: "2h", usable: true },
    { condition: "", repeat: "5s", usable: false, why: "非法间隔不算" },
  ];
  for (const item of cases) {
    const parsed = interval.parseGoalRepeat(item.repeat);
    const usable = item.condition.trim().length > 0 || parsed.intervalMs > 0;
    assert.equal(usable, item.usable, JSON.stringify(item));
  }
});