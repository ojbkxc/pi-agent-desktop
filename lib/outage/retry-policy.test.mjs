import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 按 provider 的重试策略（用户需求：添加模型 API 时可选「所有错误都持续重试，
 * 直到成功或本轮被停止」）。
 *
 * 纯口径在 `lib/outage/retry-policy.ts`：`all` 档把 terminal / transient 一并升级成
 * 可挂起的 `outage`，于是既有的挂起 + 退避 + 落盘 + 调度恢复原样接管——不另写一套
 * 重试循环（那会与 outage 机制重复驱动同一轮 turn）。
 *
 * 三条不能丢的边界：默认档逐字节不变、Stop 仍然优先、等待与尝试都有上限。
 */
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const policy = await jiti.import("./retry-policy.ts");

test("the default policy changes nothing: transient and terminal keep their kinds", () => {
  for (const kind of ["transient", "terminal", "outage", "quota"]) {
    assert.equal(policy.applyModelRetryPolicy(kind, "default"), kind, `default must leave ${kind} alone`);
  }
  assert.equal(policy.policyMaxWaitHours("default"), undefined);
  assert.equal(policy.policyMaxAttempts("default"), undefined);
});

test("the transient policy also leaves the classification alone (SDK keeps its three tries)", () => {
  assert.equal(policy.applyModelRetryPolicy("transient", "transient"), "transient");
  assert.equal(policy.applyModelRetryPolicy("terminal", "transient"), "terminal");
});

test("`all` upgrades every failure into a suspendable outage", () => {
  // terminal 也要挂起：这正是「所有错误都重试」的含义。
  assert.equal(policy.applyModelRetryPolicy("terminal", "all"), "outage");
  assert.equal(policy.applyModelRetryPolicy("transient", "all"), "outage");
  // 本来就是挂起类的保持原样（quota 有自己更长的退避档）。
  assert.equal(policy.applyModelRetryPolicy("outage", "all"), "outage");
  assert.equal(policy.applyModelRetryPolicy("quota", "all"), "quota");
});

test("`all` still has bounds: wait hours and attempt cap", () => {
  assert.equal(policy.policyMaxAttempts("all"), policy.ALL_POLICY_MAX_ATTEMPTS);
  assert.ok(policy.ALL_POLICY_MAX_ATTEMPTS > 40, "an unbounded-looking policy still needs a ceiling above the default");
  assert.equal(policy.policyMaxWaitHours("all"), policy.DEFAULT_ALL_POLICY_MAX_WAIT_HOURS);
  // 自定义值生效；非法值退回默认而不是变成无限。
  assert.equal(policy.policyMaxWaitHours("all", 72), 72);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      policy.policyMaxWaitHours("all", bad),
      policy.DEFAULT_ALL_POLICY_MAX_WAIT_HOURS,
      `${String(bad)} must fall back to the default`,
    );
  }
});

test("policy parsing is lenient about junk and strict about values", () => {
  assert.equal(policy.normalizeModelRetryPolicy("nope"), "default");
  assert.equal(policy.normalizeModelRetryPolicy(undefined), "default");
  assert.equal(policy.normalizeModelRetryPolicy("all"), "all");

  const map = policy.parseModelRetryPolicyMap({
    openai: "all",
    anthropic: "transient",
    broken: "bogus",
    "  spaced  ": "all",
    "": "all",
  });
  assert.deepEqual(map, { openai: "all", anthropic: "transient", spaced: "all" });
  assert.deepEqual(policy.parseModelRetryPolicyMap(null), {});
  assert.deepEqual(policy.parseModelRetryPolicyMap(["all"]), {});
  assert.equal(policy.resolveModelRetryPolicy("openai", map), "all");
  assert.equal(policy.resolveModelRetryPolicy("unknown", map), "default");
  assert.equal(policy.resolveModelRetryPolicy(null, map), "default");
});