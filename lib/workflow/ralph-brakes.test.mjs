import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * ralph 的三个刹车（审计实测有问题的那三条）。
 *
 * 1. `STATUS: blocked` 被整条丢掉：旧实现只读 `complete`，worker 按契约写 blocked 但
 *    `BLOCKER:` 留空（契约本身允许 `none`）时，被当成「继续」一路空转到 `maxRounds`
 *    ——实测 5 轮全在空转。
 * 2. blocker 用全等比较：大小写或多余空白变一下就算「换了阻塞」，早停永远不触发——实测
 *    同一个阻塞写 5 种大小写，跑满 5 轮不早停。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { parseRalphReport } = await jiti.import("./ralph.ts");

test("`STATUS: blocked` with an empty BLOCKER is still a block (not 'continue')", () => {
  const report = parseRalphReport("STATUS: blocked\nDID: nothing\nNEXT: ask a human\nBLOCKER: none");
  assert.equal(report.blocked, true, "blocked 是 worker 的结论，不该因为缺说明就作废");
  assert.equal(report.blocker, "", "`none` 归一成空串（表示没给理由）");
  assert.equal(report.complete, false);
});

test("`STATUS: continue` is not mistaken for blocked or complete", () => {
  const report = parseRalphReport("STATUS: continue\nDID: x\nNEXT: y\nBLOCKER: none");
  assert.equal(report.blocked, false);
  assert.equal(report.complete, false);
  assert.equal(report.blocker, "");
});

test("only an explicit `complete` counts as done (parsing failure stays 'not done')", () => {
  assert.equal(parseRalphReport("STATUS: complete").complete, true);
  assert.equal(parseRalphReport("STATUS: completed").complete, true);
  // 散文里出现 complete 不算——这是这条循环最危险的失败模式（用户以为做完了）。
  assert.equal(parseRalphReport("I think this is complete, STATUS: continue").complete, false);
  assert.equal(parseRalphReport("").complete, false);
  assert.equal(parseRalphReport("no contract lines at all").complete, false);
});

test("a real blocker is kept as text and marks the round blocked", () => {
  const report = parseRalphReport("STATUS: blocked\nBLOCKER: missing API credentials");
  assert.equal(report.blocker, "missing API credentials");
  assert.equal(report.blocked, true);
});
