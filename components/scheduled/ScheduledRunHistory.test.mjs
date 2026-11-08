import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { mergeRunPages } = await jiti.import("../scheduled-helpers.ts");

const source = (await readFile(new URL("./ScheduledRunHistory.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const run = (runId, extra = {}) => ({ runId, status: "succeeded", trigger: "schedule", ...extra });

test("mergeRunPages appends a new page in order (d5-29)", () => {
  const first = mergeRunPages([], [run("r1"), run("r2")]);
  assert.deepEqual(first.map((r) => r.runId), ["r1", "r2"]);
  const second = mergeRunPages(first, [run("r3")]);
  assert.deepEqual(second.map((r) => r.runId), ["r1", "r2", "r3"]);
});

test("mergeRunPages drops runs already in the list, so key=run.runId cannot collide (d5-29)", () => {
  const existing = [run("r1"), run("r2")];
  // 双击旧实现会让两次请求共用同一游标 → 同一页追加两次 → 撞重复 key。
  const merged = mergeRunPages(mergeRunPages(existing, [run("r3")]), [run("r3")]);
  assert.deepEqual(merged.map((r) => r.runId), ["r1", "r2", "r3"]);
});

test("loadMore has an in-flight guard and the button is disabled while loading (d5-29)", () => {
  // 哨兵：同步 ref 拦截重入（state 只管按钮态，ref 才拦得住同 tick 双击）。
  assert.match(source, /if \(!last \|\| loadingMoreRef\.current\) return;/);
  assert.match(source, /loadingMoreRef\.current = true;/);
  assert.match(source, /disabled=\{loadingMore\}/);
  // 合并走去重 helper，而不是裸展开。
  assert.match(source, /setRuns\(\(current\) => mergeRunPages\(current \?\? \[\], page\.runs\)\)/);
});
