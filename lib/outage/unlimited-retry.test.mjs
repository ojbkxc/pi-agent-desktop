import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 「所有错误——持续重试」必须是**真的**持续：几天几夜还在请求，直到成功或本轮被停止。
 *
 * 报的现象（用户原话）：「这个功能好像还是没有真正落地，我要几天几夜都还在请求的那种」，
 * 并贴了 `upstream_error`（`peer closed connection without sending TLS close_notify`）。
 *
 * 上一版 `all` 档给了 24 小时 / 400 次上限：一个跨夜、甚至跨周的模型故障会在恢复前
 * 一刻被判 `expired` —— 与「持续」正好相反。现在改成**不设上限**：
 * - `deadlineAt: 0` 是「不限」哨兵（不能用 Infinity：落盘成 JSON 会变 null）；
 * - `maxAttempts` 抬到 `Number.MAX_SAFE_INTEGER`；
 * - 两个判据都必须显式判 `> 0`，否则 0 会让 `now >= 0` 恒真、立刻过期。
 *
 * 仍然保留 Stop 与被删除会话的刹车（由 rpc-hook 的 aborted 分支与用户取消负责），
 * 那不是「上限」，是操作者的手。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const backoff = await jiti.import("./backoff.ts");
const types = await jiti.import("./types.ts");
const policy = await jiti.import("./retry-policy.ts");

const HOUR = 3_600_000;

function budget(overrides = {}) {
  return backoff.initialOutageBudget({ kind: "outage", now: 1_000, maxWaitMs: 0, maxAttempts: policy.ALL_POLICY_MAX_ATTEMPTS, ...overrides });
}

test("`all` has no wall-clock ceiling and no practical attempt ceiling", () => {
  assert.equal(policy.DEFAULT_ALL_POLICY_MAX_WAIT_HOURS, 0, "the default is `no ceiling`");
  assert.equal(policy.policyMaxWaitHours("all"), 0);
  assert.ok(policy.ALL_POLICY_MAX_ATTEMPTS > 1_000_000, "attempts are effectively unbounded");
});

test("a zero wait budget writes the sentinel instead of expiring immediately", () => {
  const b = budget();
  assert.equal(b.deadlineAt, 0, "0 is the sentinel for `no deadline`");
  // 关键：`now + 0` 会得到 now，那样第一次判就过期了。
  assert.equal(types.isOutageExpired({ budget: b }, 1_000 + 365 * 24 * HOUR), false, "a year later it is still alive");
});

test("advancing a year of retries never expires the record", () => {
  let record = { budget: budget(), status: "waiting", kind: "outage", updatedAt: 1_000, sessionId: "s", version: 1 };
  let now = 1_000;
  // 退避封顶 30 分钟，一年约 1.75 万次；这里直接推进 20 万次也不该过期。
  for (let i = 0; i < 200_000; i += 1) {
    const result = backoff.advanceOutageBudget(record, now);
    record = result.record;
    now = result.record.budget.nextAttemptAt;
    assert.equal(result.expired, false, `expired at attempt ${i}`);
  }
  assert.ok(record.budget.attempts > 100_000, "it really kept retrying");
});

test("a bounded policy still expires, proving the sentinel did not disable the brake", () => {
  const bounded = budget({ maxWaitMs: 6 * HOUR });
  assert.equal(types.isOutageExpired({ budget: bounded }, 1_000 + 7 * HOUR), true, "6h ceiling still bites");
  const fewAttempts = budget({ maxWaitMs: 0, maxAttempts: 2 });
  assert.equal(types.isOutageExpired({ budget: fewAttempts }, 1_000), false);
  const advanced = backoff.advanceOutageBudget({ ...fewAttempts, budget: { ...fewAttempts, attempts: 2 } }, 1_000);
  assert.equal(advanced.expired, true, "an explicit attempt cap still bites");
});
