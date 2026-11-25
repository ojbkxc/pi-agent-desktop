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
  SNAPSHOT_TIMEOUT_MS,
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
  assert.equal(SNAPSHOT_TIMEOUT_MS, 20000, "matches the useModelCatalog timeout scale (d5-20)");
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

// ── contentHash 去重（生产路径）────────────────────────────────────────────────
// 上一组用例跑的是「快照没有 contentHash」的向后兼容回退分支。生产快照总是带
// contentHash，且 version 恒为 1、generatedAt 每轮都变——所以必须单独锁住新口径，
// 否则回退分支全绿也说明不了真实链路是对的。

function snapshotWithHash(generatedAt, contentHash) {
  return { ...snapshot(generatedAt), contentHash };
}

test("同 contentHash + 不同 generatedAt 不追加新帧（修掉「60 帧同一张图」）", () => {
  const first = snapshotWithHash(at(1), "aaaa1111aaaa1111");
  const snapshots = appendTeamSnapshot([], first);
  assert.equal(snapshots.length, 1);

  // 内容未变，只是下一轮轮询换了时间戳：必须返回同一数组引用。
  const unchanged = appendTeamSnapshot(snapshots, snapshotWithHash(at(2), "aaaa1111aaaa1111"));
  assert.equal(unchanged, snapshots, "contentHash 相同必须保持引用不变");
  assert.equal(unchanged.length, 1);

  // 再轮询两次也不追加——模拟空闲团队连轮询。
  let current = unchanged;
  for (let second = 3; second <= 6; second += 1) {
    current = appendTeamSnapshot(current, snapshotWithHash(at(second), "aaaa1111aaaa1111"));
  }
  assert.equal(current.length, 1, "空闲团队不应堆帧");
});

test("contentHash 变化必须追加新帧（新消息/新状态不能漏）", () => {
  const first = snapshotWithHash(at(1), "aaaa1111aaaa1111");
  const snapshots = appendTeamSnapshot([first], snapshotWithHash(at(2), "bbbb2222bbbb2222"));
  assert.equal(snapshots.length, 2, "内容变了必须追加");
  assert.equal(snapshots[1].contentHash, "bbbb2222bbbb2222");
});

test("contentHash 优先于 version/generatedAt：两者相同但 hash 不同也算新帧", () => {
  // 防御未来有人把 version 改成真版本号：口径以 contentHash 为准。
  const first = { ...snapshot(at(1)), contentHash: "cccc3333cccc3333" };
  const next = { ...snapshot(at(1)), contentHash: "dddd4444dddd4444" };
  assert.equal(appendTeamSnapshot([first], next).length, 2);
});

test("只有一侧带 contentHash 时回退到 version + generatedAt（向后兼容）", () => {
  const legacy = snapshot(at(1));
  const withHash = snapshotWithHash(at(1), "eeee5555eeee5555");
  // 两侧都缺才走旧口径；一侧有一侧无 → 按旧口径比较，不同即追加。
  assert.equal(appendTeamSnapshot([legacy], snapshot(at(1))).length, 1, "都缺 hash 且同时间戳 ⇒ 去重");
  assert.equal(appendTeamSnapshot([legacy], withHash).length, 2, "只有一侧带 hash ⇒ 视为变化");
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

test("a hidden tick while a fetch is pending still re-arms the poll (d5-20)", async () => {
  const fake = createFakeTimers();
  const listeners = new Set();
  let visible = true;
  let resolveFetch;
  const poller = createSnapshotPoller({
    // 永不 settle 的 fetch：半开连接的替身。
    fetchSnapshot: () => new Promise((resolve) => { resolveFetch = resolve; }),
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
  assert.equal(fake.size(), 0, "a pending fetch arms no poll timer yet");

  // 挂起期间切后台再切回：补拉被 inFlight 短路，但定时器必须重排——
  // 否则这次挂起之后轮询永久停摆（d5-20 的本体）。
  visible = false;
  for (const listener of listeners) listener();
  visible = true;
  for (const listener of listeners) listener();
  await flush();
  assert.deepEqual(fake.pendingDelays(), [LIVE_REFRESH_MS], "visibility re-arm survives a pending fetch");

  // fetch 落地后轮询继续走既有节奏，不产生第二个定时器。
  resolveFetch(snapshot(at(1)));
  await flush();
  assert.equal(fake.size(), 1, "exactly one poll timer after the fetch settles");

  poller.stop();
});

test("a snapshot fetch that never settles is cut by the poller timeout (d5-20)", async (t) => {
  // 判死定时器是真实 setTimeout（不经注入的 timers，见 load 的注释），所以用
  // node:test 的 mock 时钟拦截全局 setTimeout，快进 20s 让它触发。race 的
  // fetch 侧用可手动 reject 的 promise：判死后必须显式收口，否则这个永不
  // settle 的 promise 会让事件循环以为还有活干/提前清空（Node 对只有
  // pending promise 的进程会直接退出）。注意 mock 时钟也拦住本文件的
  // flush()（它用 setTimeout(0)），mock 区段内的宏任务让位改用 setImmediate。
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectFetch;
  let errors = 0;
  const poller = createSnapshotPoller({
    fetchSnapshot: () => new Promise((_resolve, reject) => { rejectFetch = reject; }),
    onSnapshot: () => {},
    onError: () => {
      errors += 1;
    },
    isLive: () => true,
    timers: createFakeTimers().timers,
    intervalMs: LIVE_REFRESH_MS,
  });

  poller.start();
  t.mock.timers.tick(0);
  await drain();
  assert.equal(errors, 0);

  t.mock.timers.tick(SNAPSHOT_TIMEOUT_MS);
  await drain();
  assert.equal(errors, 1, "the hung fetch surfaces as a retriable error");

  // 收口 fetch 侧，避免进程带着 pending promise 异常退出。
  rejectFetch(new Error("test teardown"));
  await drain();
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

// ── state.md P1：判死定时器必须收口，fetch 必须带 signal ─────────────────────
test("判死定时器在成功路径被 clearTimeout（不留 20s 僵尸），stop() 后也不复燃", async (t) => {
  // 判死用真实 setTimeout（见 load 注释），所以用 node:test mock 时钟统计真实定时器
  // 数量：成功拉的每一拍都必须把自己那个 20s 判死收回。若没有 finally clearTimeout，
  // 这里会看到一个 20000 的残留定时器。
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const fake = createFakeTimers(); // 轮询节奏队列（注入，不受 mock 时钟影响）
  let fetches = 0;
  const poller = createSnapshotPoller({
    fetchSnapshot: async () => {
      fetches += 1;
      return snapshot(at(fetches));
    },
    onSnapshot: () => {},
    onError: () => {},
    isLive: () => true,
    isVisible: () => true,
    timers: fake.timers,
    intervalMs: LIVE_REFRESH_MS,
  });

  poller.start();
  await drain();
  assert.equal(fetches, 1);
  // 判死定时器已被 finally 收回：再快进 20s 不该有任何回调触发。
  const before = fetches;
  t.mock.timers.tick(SNAPSHOT_TIMEOUT_MS);
  await drain();
  assert.equal(fetches, before, "成功拉的判死定时器不得在 20s 后仍触发");

  // 再拉一拍（手动点火轮询队列）后 stop：判死也必须随 finally 收回。
  fake.fireNext();
  await drain();
  assert.equal(fetches, before + 1);
  poller.stop();
  t.mock.timers.tick(SNAPSHOT_TIMEOUT_MS);
  await drain();
  assert.equal(fetches, before + 1, "stop 后判死定时器不得复燃");
});

test("快照拉取带 AbortSignal.timeout（超时不仅让 race 落地，还要真正 abort 请求）", async () => {
  const source = await readFile(new URL("./useTeamTimeline.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /signal: AbortSignal\.timeout\(SNAPSHOT_TIMEOUT_MS\)/,
    "fetch 必须挂 signal，否则半开连接下挂起请求无界增长",
  );
  // 判死句柄必须保存并在 finally 里清。
  assert.match(source, /let deadline: ReturnType<typeof setTimeout> \| undefined;/);
  assert.match(source, /deadline = setTimeout\(/);
  assert.match(source, /if \(deadline !== undefined\) \{\s*\n\s*clearTimeout\(deadline\);/);
});
