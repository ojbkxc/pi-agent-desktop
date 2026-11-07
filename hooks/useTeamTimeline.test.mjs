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
  MAX_RETRY_MS,
  isLiveTeamStatus,
  appendTeamSnapshot,
  clampTimelineIndex,
  frameKey,
  resolvePinnedIndex,
  isPinnedFrameExpired,
  isLivePinnedFrame,
  createSnapshotPoller,
} = await jiti.import("./useTeamTimeline.ts");

/**
 * 时间线纯逻辑：快照去重/截断、帧身份钉帧（回放不漂移）、以及脱离 React 的轮询器
 * （可见性暂停/补拉、失败退避重试）。React 状态机本身跑不动（没有 DOM），所以这里
 * 测的是 hook 导出的纯函数与轮询器工厂；文件末尾再对 hook 源码做几条接线断言。
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 手动定时器队列：可注入 createSnapshotPoller，避免依赖真实时钟与 node:test mock。 */
function createFakeTimers() {
  let nextId = 1;
  const queue = new Map();
  return {
    timers: {
      setTimeout(handler, ms) {
        const id = nextId;
        nextId += 1;
        queue.set(id, { handler, ms });
        return id;
      },
      clearTimeout(id) {
        queue.delete(id);
      },
    },
    pendingDelays() {
      return [...queue.values()].map((entry) => entry.ms).sort((a, b) => a - b);
    },
    size() {
      return queue.size;
    },
    fireNext() {
      const first = [...queue.entries()].sort((a, b) => a[1].ms - b[1].ms)[0];
      if (!first) return false;
      queue.delete(first[0]);
      first[1].handler();
      return true;
    },
  };
}

test("timeline constants keep the agreed cadences and history cap", () => {
  assert.equal(WORKBENCH_HISTORY_LIMIT, 60);
  assert.equal(LIVE_REFRESH_MS, 3000);
  assert.equal(REPLAY_STEP_MS, 1200);
  assert.equal(MAX_RETRY_MS, 30000);
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

test("frame identity joins version and generatedAt and stays unique", () => {
  assert.equal(frameKey(snapshot(at(7))), frameKey(snapshot(at(7))));
  assert.notEqual(frameKey(snapshot(at(7))), frameKey(snapshot(at(8))));
  assert.notEqual(frameKey(snapshot(at(7), 1)), frameKey(snapshot(at(7), 2)));
});

test("a pinned frame keeps its identity after the cap drops the oldest frames", () => {
  let snapshots = [];
  for (let index = 0; index < WORKBENCH_HISTORY_LIMIT; index += 1) {
    snapshots = appendTeamSnapshot(snapshots, snapshot(at(index)));
  }
  // 钉住下标 10 那一帧——正文里正是会漂移的格子。
  const pinned = frameKey(snapshots[10]);
  const pinnedAt = snapshots[10].generatedAt;
  assert.equal(resolvePinnedIndex(snapshots, pinned), 10, "pinned frame starts at index 10");

  // 追加 3 帧：满 60 后每追加一帧丢弃最旧一帧，所有数组下标整体左移 1。
  for (let index = WORKBENCH_HISTORY_LIMIT; index < WORKBENCH_HISTORY_LIMIT + 3; index += 1) {
    snapshots = appendTeamSnapshot(snapshots, snapshot(at(index)));
  }
  assert.equal(snapshots.length, WORKBENCH_HISTORY_LIMIT);
  assert.equal(snapshots[0].generatedAt, at(3), "three oldest frames were dropped");

  const selected = resolvePinnedIndex(snapshots, pinned);
  assert.equal(selected, 7, "the index shifted with the drop ...");
  assert.equal(snapshots[selected].generatedAt, pinnedAt, "... but the pinned frame is unchanged");
  assert.equal(frameKey(snapshots[selected]), pinned, "pinned frame identity does not drift");
  assert.equal(isLivePinnedFrame(snapshots, pinned), false, "a pinned frame is not 'live' once newer frames exist");
  assert.equal(isPinnedFrameExpired(snapshots, pinned), false);
});

test("a pinned frame that is evicted clamps to the oldest frame and flags expiry", () => {
  let snapshots = [];
  for (let index = 0; index < WORKBENCH_HISTORY_LIMIT; index += 1) {
    snapshots = appendTeamSnapshot(snapshots, snapshot(at(index)));
  }
  const pinned = frameKey(snapshots[0]);
  for (let index = WORKBENCH_HISTORY_LIMIT; index < WORKBENCH_HISTORY_LIMIT + 5; index += 1) {
    snapshots = appendTeamSnapshot(snapshots, snapshot(at(index)));
  }
  assert.equal(resolvePinnedIndex(snapshots, pinned), 0, "an evicted pin clamps to the oldest frame");
  assert.equal(isPinnedFrameExpired(snapshots, pinned), true);
  assert.equal(isLivePinnedFrame(snapshots, pinned), false);
});

test("null pin follows the newest frame; empty timelines have no cursor", () => {
  const snapshots = [snapshot(at(1)), snapshot(at(2)), snapshot(at(3))];
  assert.equal(resolvePinnedIndex(snapshots, null), 2);
  assert.equal(isLivePinnedFrame(snapshots, null), true);
  assert.equal(isPinnedFrameExpired(snapshots, null), false);

  assert.equal(resolvePinnedIndex([], null), -1);
  assert.equal(resolvePinnedIndex([], frameKey(snapshot(at(1)))), -1);
  assert.equal(isLivePinnedFrame([], null), false);
  assert.equal(isPinnedFrameExpired([], frameKey(snapshot(at(1)))), false);
});

test("pinning the newest frame still reads as live", () => {
  const snapshots = [snapshot(at(1)), snapshot(at(2)), snapshot(at(3))];
  const newest = frameKey(snapshots[2]);
  assert.equal(resolvePinnedIndex(snapshots, newest), 2);
  assert.equal(isLivePinnedFrame(snapshots, newest), true);
});

test("step and clamp stay inside the timeline", () => {
  assert.equal(clampTimelineIndex(0, 4), 0);
  assert.equal(clampTimelineIndex(4, 4), 4);
  assert.equal(clampTimelineIndex(2, 4), 2);
  assert.equal(clampTimelineIndex(-3, 4), 0);
  assert.equal(clampTimelineIndex(99, 4), 4);
  assert.equal(clampTimelineIndex(2.6, 4), 3, "drag positions round to a frame");
  assert.equal(clampTimelineIndex(Number.NaN, 4), 4);
  assert.equal(clampTimelineIndex(3, -1), -1);
});

test("polling resumes when the tab becomes visible again", async () => {
  const fake = createFakeTimers();
  const listeners = new Set();
  let visible = true;
  let fetches = 0;
  const poller = createSnapshotPoller({
    fetchSnapshot: async () => {
      fetches += 1;
      return snapshot(at(fetches));
    },
    onSnapshot: () => {},
    onError: () => {},
    isLive: () => true,
    isVisible: () => visible,
    visibilitySource: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    timers: fake.timers,
    intervalMs: LIVE_REFRESH_MS,
  });

  poller.start();
  await flush();
  assert.equal(fetches, 1, "start fetches immediately");
  assert.equal(fake.size(), 1, "a follow-up poll is armed");

  // 后台：到期的那一拍被跳过，且不再自行重排（这正是原先永久冻住的那一处）。
  visible = false;
  assert.equal(fake.fireNext(), true);
  await flush();
  assert.equal(fetches, 1, "a hidden tick does not fetch");
  assert.equal(fake.size(), 0, "no timer is armed while hidden");

  // 切回前台：visibilitychange 立即补拉并重排定时器。
  visible = true;
  for (const listener of listeners) listener();
  await flush();
  assert.equal(fetches, 2, "visibilitychange triggers an immediate refetch");
  assert.equal(fake.size(), 1, "polling is re-armed after resuming");

  poller.stop();
  assert.equal(fake.size(), 0, "stop clears the pending timer");
});

test("a failed fetch arms a bounded exponential retry", async () => {
  const fake = createFakeTimers();
  let calls = 0;
  let errors = 0;
  const poller = createSnapshotPoller({
    fetchSnapshot: async () => {
      calls += 1;
      throw new Error("boom");
    },
    onSnapshot: () => {},
    onError: () => {
      errors += 1;
    },
    isLive: () => true,
    isVisible: () => true,
    timers: fake.timers,
    intervalMs: LIVE_REFRESH_MS,
    maxRetryMs: MAX_RETRY_MS,
  });

  poller.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(errors, 1);

  const delays = [];
  for (let round = 0; round < 6; round += 1) {
    const pending = fake.pendingDelays();
    assert.equal(pending.length, 1, "exactly one retry timer is armed");
    delays.push(pending[0]);
    assert.equal(fake.fireNext(), true, "the retry timer fires");
    await flush();
    assert.equal(calls, round + 2, "each failure triggers another fetch");
  }
  assert.deepEqual(delays.slice(0, 4), [3000, 6000, 12000, 24000]);
  assert.equal(delays[4], MAX_RETRY_MS, "backoff is capped");
  assert.equal(delays[5], MAX_RETRY_MS, "backoff stays capped");

  poller.stop();
  assert.equal(fake.size(), 0, "stop clears the pending retry");
});

test("a successful load after failures resets the backoff", async () => {
  const fake = createFakeTimers();
  let fail = true;
  const poller = createSnapshotPoller({
    fetchSnapshot: async () => {
      if (fail) throw new Error("boom");
      return snapshot(at(1));
    },
    onSnapshot: () => {},
    onError: () => {},
    isLive: () => true,
    isVisible: () => true,
    timers: fake.timers,
  });

  poller.start();
  await flush();
  assert.equal(fake.pendingDelays()[0], 3000, "first retry uses the base interval");

  fail = false;
  fake.fireNext();
  await flush();
  assert.equal(fake.pendingDelays()[0], 3000, "a success returns to the normal cadence");

  poller.stop();
});

test("polling stops once the team is no longer live", async () => {
  const fake = createFakeTimers();
  let calls = 0;
  const poller = createSnapshotPoller({
    fetchSnapshot: async () => {
      calls += 1;
      return snapshot(at(1));
    },
    onSnapshot: () => {},
    onError: () => {},
    isLive: () => false,
    isVisible: () => true,
    timers: fake.timers,
  });

  poller.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(fake.size(), 0, "no timer is armed after a non-live snapshot");

  poller.stop();
});

test("hook wiring keeps the polling, visibility and pinning seams", async () => {
  const source = await readFile(new URL("./useTeamTimeline.ts", import.meta.url), "utf8");
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /LIVE_REFRESH_MS = 3000/);
  assert.match(source, /REPLAY_STEP_MS = 1200/);
  assert.match(source, /WORKBENCH_HISTORY_LIMIT = 60/);
  assert.match(source, /isLiveTeamStatus\(data\.team\.status\)/);
  assert.match(source, /createSnapshotPoller\(/);
  assert.match(source, /setPinnedFrame\(frameKey\(/);
  assert.doesNotMatch(source, /setHistoryIndex/, "historyIndex must stay a derived value");
});
