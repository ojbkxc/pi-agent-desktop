/**
 * Shared exponential backoff for password authentication failures.
 *
 * Pi Web serves a single operator and binds to 127.0.0.1, so Next.js route
 * handlers have no reliable client address (`x-forwarded-for` is spoofable and
 * absent for direct connections). Rather than trusting a per-IP key, every
 * failure feeds a counter and briefly blocks password attempts.
 *
 * 2026-11-24 攻击面修正（security 审计 P1）：单计数器把「攻击者的失败」和
 * 「操作者的尝试」记在同一本账上。隧道开放后，一个远端访客每 ~60s 发一个错
 * Basic 头就能让 `blockedUntil` 永远在未来——操作员的每次登录都被 429，等于
 * 无限期锁死。现在分两个桶：
 *
 * - `local`：本机请求（relay/tunnel 之外）的失败。操作员自己打错密码，全局
 *   小延迟可以接受，且这台机器上没有陌生人。
 * - `shared`：无法证明是本机的请求。攻击者的失败推这里；查询时两个桶都看
 *   （任一被锁都拒绝），**但本机请求的失败不会把远端桶拉爆**——反向也要成立：
 *   操作员本机登录只受 local 桶约束，攻击者的小动作不再把 local 桶顶满。
 *
 * 判定函数由调用方注入（`proxy.ts` 用 `isLocalRequest`），本模块不 import
 * request-security/remote-access，保持测试可注入。
 */

export const AUTH_THROTTLE_BASE_DELAY_MS = 1_000;
export const AUTH_THROTTLE_MAX_DELAY_MS = 60_000;

/**
 * Idle time after the last failure before the counter is forgotten. It must be
 * longer than the maximum delay, otherwise waiting out one block would restart
 * the backoff from the base delay and hand an attacker a fresh burst of guesses.
 */
export const AUTH_THROTTLE_RESET_AFTER_MS = 5 * 60_000;

export interface AuthThrottleState {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

/** 节流桶：`local`=本机，`shared`=其它一切来源。 */
export type AuthThrottleBucket = "local" | "shared";

const STATE_KEY = "pi-web:auth-throttle";

interface ThrottleStore {
  local: AuthThrottleState;
  shared: AuthThrottleState;
}

function freshState(): AuthThrottleState {
  return { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
}

export function createAuthThrottleState(): AuthThrottleState {
  return freshState();
}

function freshStore(): ThrottleStore {
  return { local: freshState(), shared: freshState() };
}

/** Stored on `globalThis` so the counters survive Next.js hot reloads. */
function getGlobalStore(): ThrottleStore {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(STATE_KEY);
  const existing = store[key];
  if (isStore(existing)) return existing;
  const created = freshStore();
  store[key] = created;
  return created;
}

function isState(value: unknown): value is AuthThrottleState {
  return typeof value === "object"
    && value !== null
    && typeof (value as AuthThrottleState).failures === "number"
    && typeof (value as AuthThrottleState).lastFailureAt === "number"
    && typeof (value as AuthThrottleState).blockedUntil === "number";
}

function isStore(value: unknown): value is ThrottleStore {
  return typeof value === "object"
    && value !== null
    && isState((value as ThrottleStore).local)
    && isState((value as ThrottleStore).shared);
}

function expireIfStale(state: AuthThrottleState, now: number): void {
  if (state.failures > 0 && now - state.lastFailureAt >= AUTH_THROTTLE_RESET_AFTER_MS) {
    Object.assign(state, freshState());
  }
}

export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  const exponent = Math.min(failures - 1, 31);
  return Math.min(AUTH_THROTTLE_BASE_DELAY_MS * 2 ** exponent, AUTH_THROTTLE_MAX_DELAY_MS);
}

/**
 * Milliseconds the caller must still wait before another attempt is accepted,
 * or 0 when attempts are allowed.
 *
 * `bucket` 只挑「该桶的失败要不要拦这次请求」；`scope` 决定还看哪些别的桶：
 * - `scope = "local"`：本机请求只受 local 桶约束（shared 桶被远端攻击者拉爆
 *   不阻塞本机操作员）。
 * - `scope = "remote"`：远端请求两个桶都看——本地打爆的锁不该放远端进来，
 *   反向更不该。
 */
export function getAuthRetryAfterMs(
  bucket: AuthThrottleBucket,
  scope: "local" | "remote",
  now = Date.now(),
  store: ThrottleStore = getGlobalStore(),
): number {
  const states = scope === "local" ? [store.local] : [store.local, store.shared];
  let remaining = 0;
  for (const state of states) {
    expireIfStale(state, now);
    remaining = Math.max(remaining, state.blockedUntil - now);
  }
  return Math.max(0, remaining);
}

/** Records a failed attempt into its bucket and returns the delay now imposed on the next one from that bucket. */
export function recordAuthFailure(
  bucket: AuthThrottleBucket,
  now = Date.now(),
  store: ThrottleStore = getGlobalStore(),
): number {
  const state = store[bucket];
  expireIfStale(state, now);
  state.failures += 1;
  state.lastFailureAt = now;
  const delay = backoffDelayMs(state.failures);
  state.blockedUntil = now + delay;
  return delay;
}

/** A successful authentication clears both buckets: the lock exists to slow guessing, not to outlive it. */
export function recordAuthSuccess(store: ThrottleStore = getGlobalStore()): void {
  Object.assign(store.local, freshState());
  Object.assign(store.shared, freshState());
}

/** Whole seconds for the `Retry-After` header; never less than 1 while blocked. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
