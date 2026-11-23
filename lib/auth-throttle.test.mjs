import assert from "node:assert/strict";
import test from "node:test";

const {
  AUTH_THROTTLE_MAX_DELAY_MS,
  AUTH_THROTTLE_RESET_AFTER_MS,
  backoffDelayMs,
  createAuthThrottleState,
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  retryAfterSeconds,
} = await import("./auth-throttle.ts");

/**
 * 单桶时代：createAuthThrottleState() 返回一个 state，函数收 (now, state)。
 * 分桶后：同一批纯函数语义逐字保留，测试改为驱动 { local, shared } 双桶 store。
 * 每个用例拿 freshStore()，与旧测试的 fresh state 对齐。
 */
function freshStore() {
  return { local: createAuthThrottleState(), shared: createAuthThrottleState() };
}

test("allows attempts until the first failure", () => {
  const store = freshStore();
  assert.equal(getAuthRetryAfterMs("local", "local", 1_000, store), 0);
  assert.equal(getAuthRetryAfterMs("shared", "remote", 1_000, store), 0);
});

test("doubles the delay on each failure and caps at the maximum", () => {
  const store = freshStore();
  let now = 0;
  const delays = [];
  for (let i = 0; i < 8; i += 1) {
    delays.push(recordAuthFailure("local", now, store));
    now += delays[delays.length - 1];
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  assert.ok(AUTH_THROTTLE_RESET_AFTER_MS > AUTH_THROTTLE_MAX_DELAY_MS, "waiting out a block must not reset the counter");
  assert.equal(backoffDelayMs(100), AUTH_THROTTLE_MAX_DELAY_MS);
  assert.equal(backoffDelayMs(0), 0);
});

test("reports the remaining block time and lifts it when it expires", () => {
  const store = freshStore();
  recordAuthFailure("local", 10_000, store);
  recordAuthFailure("local", 11_000, store);
  assert.equal(getAuthRetryAfterMs("local", "local", 11_500, store), 1_500);
  assert.equal(getAuthRetryAfterMs("local", "local", 13_000, store), 0);
  assert.equal(store.local.failures, 2, "expired block keeps the failure count for backoff");
});

test("forgets failures once they are older than the reset window", () => {
  const store = freshStore();
  recordAuthFailure("local", 0, store);
  recordAuthFailure("local", 1_000, store);
  const later = 1_000 + AUTH_THROTTLE_RESET_AFTER_MS;
  assert.equal(getAuthRetryAfterMs("local", "local", later, store), 0);
  assert.equal(store.local.failures, 0);
  assert.equal(recordAuthFailure("local", later, store), 1_000, "backoff restarts from the base delay");
});

test("success clears both buckets and the block", () => {
  const store = freshStore();
  recordAuthFailure("local", 0, store);
  recordAuthFailure("shared", 1_000, store);
  recordAuthSuccess(store);
  assert.equal(getAuthRetryAfterMs("local", "local", 1_001, store), 0);
  assert.equal(getAuthRetryAfterMs("shared", "remote", 1_001, store), 0);
  assert.equal(recordAuthFailure("local", 1_001, store), 1_000);
});

test("Retry-After rounds up to whole seconds and is at least one", () => {
  assert.equal(retryAfterSeconds(1), 1);
  assert.equal(retryAfterSeconds(1_000), 1);
  assert.equal(retryAfterSeconds(1_001), 2);
  assert.equal(retryAfterSeconds(60_000), 60);
});

test("shares one global store across module instances", async () => {
  const other = await import(`./auth-throttle.ts?instance=${Date.now()}`);
  recordAuthSuccess();
  recordAuthFailure("shared", 0);
  assert.ok(other.getAuthRetryAfterMs("shared", "remote", 0) > 0);
  other.recordAuthSuccess();
  assert.equal(getAuthRetryAfterMs("shared", "remote", 0), 0);
});

test("a remote attacker's failures never lock the local operator out", () => {
  // security 审计 P1 的复现：老全局单桶下，隧道访客每 ~60s 一个错 Basic 头
  // 就能把 blockedUntil 永远顶在未来，操作员本机登录全部 429。
  const store = freshStore();
  let now = 0;
  for (let round = 1; round <= 30; round += 1) {
    now += 60_000; // 攻击节奏：每分钟一次错误尝试（避开 5 分钟重置窗口）
    recordAuthFailure("shared", now, store);
  }
  // 远端已被锁死……
  assert.ok(getAuthRetryAfterMs("shared", "remote", now + 1, store) > 0);
  // ……但本机操作员不受攻击者那只桶影响，可以正常登录。
  assert.equal(getAuthRetryAfterMs("local", "local", now + 1, store), 0, "the operator must not be locked out by a remote guesser");
});

test("a local lock still gates remote guesses (and vice versa)", () => {
  const store = freshStore();
  // 本机连错两次：local 桶进入退避。
  recordAuthFailure("local", 0, store);
  recordAuthFailure("local", 1_100, store);
  // 远端请求两个桶都看：不能借本机的锁放远端进来。
  assert.ok(getAuthRetryAfterMs("shared", "remote", 1_200, store) > 0);
  // 反过来：shared 桶的锁也拦远端。
  const store2 = freshStore();
  recordAuthFailure("shared", 0, store2);
  assert.ok(getAuthRetryAfterMs("shared", "remote", 100, store2) > 0);
  // 但 shared 桶的锁不拦本机（操作员没做错任何事）。
  assert.equal(getAuthRetryAfterMs("local", "local", 100, store2), 0);
});