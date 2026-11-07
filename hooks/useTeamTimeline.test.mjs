import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  WORKBENCH_HISTORY_LIMIT,
  LIVE_REFRESH_MS,
  REPLAY_STEP_MS,
  isLiveTeamStatus,
  appendTeamSnapshot,
  clampTimelineIndex,
  resolveTimelineIndex,
  isLiveTimelineIndex,
  stepTimelineIndex,
} = await jiti.import("./useTeamTimeline.ts");

/**
 * 时间线纯逻辑：快照去重/截断、index 语义（null=跟随最新）、isLive 判定。
 * React 状态机本身跑不动（没有 DOM），所以这里测的是 hook 导出的纯函数；
 * 文件末尾再对 hook 源码做几条接线断言，防止轮询/播放参数被改掉。
 */

function snapshot(generatedAt, version = 1) {
  return {
    version,
    generatedAt,
    team: { name: "demo" },
    members: [],
    tickets: [],
    lanes: [],
    flows: [],
    taskAnchors: [],
    tasks: [],
    receipts: [],
  };
}

function at(second) {
  return `2026-11-07T00:00:${String(second).padStart(2, "0")}.000Z`;
}

test("timeline constants keep the agreed cadences and history cap", () => {
  assert.equal(WORKBENCH_HISTORY_LIMIT, 60);
  assert.equal(LIVE_REFRESH_MS, 3000);
  assert.equal(REPLAY_STEP_MS, 1200);
});

test("only forming/running/finishing teams keep polling", () => {
  for (const status of ["forming", "running", "finishing"]) {
    assert.equal(isLiveTeamStatus(status), true, status);
  }
  for (const status of ["completed", "ended", undefined]) {
    assert.equal(isLiveTeamStatus(status), false, String(status));
  }
});

test("a snapshot with the same version and generatedAt is not pushed twice", () => {
  const first = snapshot(at(1));
  const snapshots = appendTeamSnapshot([], first);
  assert.deepEqual(snapshots, [first]);

  const unchanged = appendTeamSnapshot(snapshots, snapshot(at(1)));
  assert.equal(unchanged, snapshots, "dedupe must keep the same array reference");
  assert.equal(unchanged.length, 1);
});

test("a changed generatedAt or version appends a new frame", () => {
  const first = snapshot(at(1));
  const second = appendTeamSnapshot([first], snapshot(at(2)));
  assert.equal(second.length, 2);
  assert.equal(second[1].generatedAt, at(2));

  const third = appendTeamSnapshot(second, snapshot(at(2), 2));
  assert.equal(third.length, 3);
});

test("history is capped at the newest WORKBENCH_HISTORY_LIMIT frames", () => {
  let snapshots = [];
  for (let index = 0; index < WORKBENCH_HISTORY_LIMIT + 5; index += 1) {
    snapshots = appendTeamSnapshot(snapshots, snapshot(at(index)));
  }
  assert.equal(snapshots.length, WORKBENCH_HISTORY_LIMIT);
  assert.equal(snapshots[0].generatedAt, at(5), "oldest frames are dropped");
  assert.equal(snapshots.at(-1).generatedAt, at(WORKBENCH_HISTORY_LIMIT + 4));
});

test("historyIndex null follows the latest frame; explicit indexes are clamped", () => {
  assert.equal(resolveTimelineIndex(null, 4), 4);
  assert.equal(resolveTimelineIndex(2, 4), 2);
  assert.equal(resolveTimelineIndex(-3, 4), 0);
  assert.equal(resolveTimelineIndex(99, 4), 4);
  assert.equal(resolveTimelineIndex(2.6, 4), 3, "drag positions round to a frame");
  assert.equal(resolveTimelineIndex(null, -1), -1, "empty timeline has no cursor");
  assert.equal(resolveTimelineIndex(0, -1), -1);
});

test("isLive is true while following or parked on the newest frame", () => {
  assert.equal(isLiveTimelineIndex(null, 4), true);
  assert.equal(isLiveTimelineIndex(4, 4), true);
  assert.equal(isLiveTimelineIndex(3, 4), false);
  assert.equal(isLiveTimelineIndex(null, -1), false);
  assert.equal(isLiveTimelineIndex(99, 4), true, "out-of-range indexes clamp to the newest frame");
});

test("step and clamp stay inside the timeline", () => {
  assert.equal(stepTimelineIndex(0, -1, 4), 0);
  assert.equal(stepTimelineIndex(4, 1, 4), 4);
  assert.equal(stepTimelineIndex(2, 1, 4), 3);
  assert.equal(stepTimelineIndex(2, -1, 4), 1);
  assert.equal(clampTimelineIndex(Number.NaN, 4), 4);
  assert.equal(clampTimelineIndex(3, -1), -1);
});

test("hook wiring keeps the visibility guard, polling cadence, and playback step", async () => {
  const source = await readFile(new URL("./useTeamTimeline.ts", import.meta.url), "utf8");
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /LIVE_REFRESH_MS = 3000/);
  assert.match(source, /REPLAY_STEP_MS = 1200/);
  assert.match(source, /WORKBENCH_HISTORY_LIMIT = 60/);
  assert.match(source, /isLiveTeamStatus\(data\.team\.status\)/);
  assert.match(source, /setHistoryIndex\(selectedIndex \+ 1\)/);
});