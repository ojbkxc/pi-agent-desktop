import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 连点「批准」不能静默（团队计数审计 P3-3）。
 *
 * `mutationRef` 的单飞守卫是对的（防重复投递 → 防 lead 重复 spawn），但它只 `return` 一个
 * reason，而调用方 `void teamPlan.saveAndApprove(...)` 把返回值丢掉了 —— 用户连点第二下时
 * 界面既不报错、也不动，看着就是「点了没反应」。
 *
 * 修法：守卫命中时同时把原因写到 `approveError` 上，界面就有话可说（收缩态卡片也会显示）。
 */
const source = readFileSync(new URL("./useTeamPlan.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the single-flight guard surfaces its reason instead of only returning it", () => {
  const approveGuard = source.slice(
    source.indexOf("if (mutationRef.current) {"),
    source.indexOf('mutationRef.current = "approve";'),
  );
  assert.match(approveGuard, /setApproveError\(reason\)/, "the guard must be visible");
  assert.match(approveGuard, /return \{ ok: false, reason \}/, "…and still refuse the duplicate");

  const saveGuard = source.slice(
    source.indexOf("上一次保存/批准还在进行中"),
    source.indexOf("const hasEdits ="),
  );
  assert.match(saveGuard, /setApproveError\(reason\)/, "saveAndApprove's guard too");
});

test("the guard still refuses to fire a second approval (no duplicate spawn)", () => {
  // 单飞语义必须保留：守卫在 `mutationRef.current = "approve"` 之前 return。
  const at = source.indexOf('mutationRef.current = "approve";');
  const guardAt = source.indexOf("上一次批准还在进行中");
  assert.ok(guardAt > 0 && guardAt < at, "the guard runs before the write is claimed");
});
