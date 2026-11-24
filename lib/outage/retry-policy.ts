// 按 provider 的重试策略（用户需求：每个模型 API 可以自己选重试口径）。
//
// 三个档位（存 `~/.pi/agent/pi-web/settings.json` 的 `modelRetryPolicy`，按
// provider id 键控）：
// - `default`：现有行为，逐字节不变 —— transient 交回 SDK 既有重试，terminal 不挂起。
// - `transient`：只重试被判定为临时性的错误；token 失效、模型不存在这类立即失败。
// - `all`：**所有**失败都持续重试，直到成功或本轮被 Stop / 取消。
//
// `all` 档不是新写一套重试循环——那会与 `lib/outage/` 里已经验证过的挂起 + 退避 +
// 落盘 + 调度恢复重复驱动。做法是**换分类口径**：把 `terminal`（以及不挂起的
// `transient`）一并升级成可挂起的 `outage`，于是既有的恢复链路原样接管。
//
// 两条边界照旧，未因放开而丢失：
// 1. Stop 语义不变：`aborted` 一律不写记录、不续跑——「直到本轮被停止」正是靠这条。
// 2. 仍然有 `deadlineAt` / `maxAttempts` 双闸（`lib/outage/types.ts`）；`all` 档只是
//    把等待上限抬到 `allMaxWaitHours` 档位，不是取消闸门。

import type { OutageKind } from "./types";

/** 用户在「添加模型 API」或 provider 编辑页里能选的重试口径。 */
export type ModelRetryPolicy = "default" | "transient" | "all";

export const MODEL_RETRY_POLICIES: readonly ModelRetryPolicy[] = ["default", "transient", "all"];

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = "default";

/**
 * `all` 档的等待上限档位（小时）。`0` = **不限**：操作者要的是「几天几夜都还在请求」，
 * 而原来的 24 小时上限会把一个跨夜的模型故障当成放弃点。
 *
 * 仍然保留了 `ALL_POLICY_MAX_WAIT_HOURS_OPTIONS` 这个有限档位表供设置面选用——想设
 * 上限的人照样能设，只是默认改成不限。
 */
export const ALL_POLICY_MAX_WAIT_HOURS_OPTIONS: readonly number[] = [0, 6, 24, 72, 168];
export const DEFAULT_ALL_POLICY_MAX_WAIT_HOURS = 0;
/**
 * `all` 档的尝试次数上限：**不设**。
 *
 * 为什么不再填 400：退避已封顶 30 分钟，400 次大约就是 8 天——但那个数字会让「挂了
 * 一周后模型恢复」的会话在恢复前一刻被判定 expired，与用户要的语义相反。判据里
 * `attempts >= maxAttempts` 只有在 maxAttempts 为有限值时才可能成立，所以这里用
 * `Number.POSITIVE_INFINITY` 的落盘安全替身（见下）之外的一个足够大的有限值并明确注释。
 */
export const ALL_POLICY_MAX_ATTEMPTS = Number.MAX_SAFE_INTEGER;

export function isModelRetryPolicy(value: unknown): value is ModelRetryPolicy {
  return typeof value === "string" && (MODEL_RETRY_POLICIES as readonly string[]).includes(value);
}

/** 归一化：未知值一律落回默认档（设置文件被手改坏时不能让会话停摆）。 */
export function normalizeModelRetryPolicy(value: unknown): ModelRetryPolicy {
  return isModelRetryPolicy(value) ? value : DEFAULT_MODEL_RETRY_POLICY;
}

/** 一份「providerId → 策略」的映射，读设置时用。坏条目静默丢弃。 */
export type ModelRetryPolicyMap = Readonly<Record<string, ModelRetryPolicy>>;

export function parseModelRetryPolicyMap(value: unknown): ModelRetryPolicyMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ModelRetryPolicy> = {};
  for (const [providerId, policy] of Object.entries(value as Record<string, unknown>)) {
    if (typeof providerId !== "string" || !providerId.trim()) continue;
    if (!isModelRetryPolicy(policy)) continue;
    out[providerId.trim()] = policy;
  }
  return out;
}

/** 某个 provider 的策略；没有配置就是默认档。 */
export function resolveModelRetryPolicy(
  providerId: string | null | undefined,
  map: ModelRetryPolicyMap,
): ModelRetryPolicy {
  if (!providerId) return DEFAULT_MODEL_RETRY_POLICY;
  return normalizeModelRetryPolicy(map[providerId]);
}

/**
 * 把分类结果按策略调整。
 *
 * - `default` / `transient`：原样返回（前者的 transient 交回 SDK、后者本身就在重试）。
 * - `all`：`terminal` → `outage`，`transient` → `outage`。
 *   仍然返回 `null` 表示「不挂起」的唯一情形是**调用方已经判定为 aborted**——
 *   那不在本函数里判断（Stop 由 `onAgentRunSettled` 的 `aborted` 分支先挡掉）。
 *
 * 为什么 `transient` 也要升级：SDK 的既有重试只有 3 次、合计约 14 秒。用户选 `all`
 * 的语义是「别把一次临时抖动当失败」，3 次显然不够；升级后由退避序列接力。
 */
export function applyModelRetryPolicy(
  kind: OutageKind,
  policy: ModelRetryPolicy,
): OutageKind {
  if (policy !== "all") return kind;
  if (kind === "terminal" || kind === "transient") return "outage";
  return kind;
}

/**
 * `all` 档的等待上限（小时）；其它档返回 undefined，由既有默认值决定。
 *
 * 返回 `0` 表示**不限**（`deadlineAt: 0` 哨兵，见 `isOutageExpired`）。非法值（负数、
 * NaN、Infinity）一律落回默认——默认现在是 0（不限），所以坏值不会把会话锁在「立刻
 * 过期」上。
 */
export function policyMaxWaitHours(
  policy: ModelRetryPolicy,
  allMaxWaitHours: number = DEFAULT_ALL_POLICY_MAX_WAIT_HOURS,
): number | undefined {
  if (policy !== "all") return undefined;
  if (allMaxWaitHours === 0) return 0;
  const hours = Number.isFinite(allMaxWaitHours) && allMaxWaitHours > 0
    ? allMaxWaitHours
    : DEFAULT_ALL_POLICY_MAX_WAIT_HOURS;
  return hours;
}

/** `all` 档的尝试次数上限；其它档返回 undefined。 */
export function policyMaxAttempts(policy: ModelRetryPolicy): number | undefined {
  return policy === "all" ? ALL_POLICY_MAX_ATTEMPTS : undefined;
}
