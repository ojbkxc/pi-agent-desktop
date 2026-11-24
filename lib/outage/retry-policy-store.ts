// 按 provider 重试策略的读写（落 `~/.pi/agent/pi-web/settings.json`）。
//
// 纯口径在 `retry-policy.ts`（客户端/设置页可直接 import，不含 node:fs）；
// 这个文件只负责落盘与归一化，读侧口径与 `readOutageSettings` 一致：
// **文件坏了一律退回默认**——错在「按默认跑」代价小，错在「策略丢了」看起来像功能坏了。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "../artifact-settings";
import {
  DEFAULT_ALL_POLICY_MAX_WAIT_HOURS,
  DEFAULT_MODEL_RETRY_POLICY,
  isModelRetryPolicy,
  normalizeModelRetryPolicy,
  parseModelRetryPolicyMap,
  resolveModelRetryPolicy,
  type ModelRetryPolicy,
  type ModelRetryPolicyMap,
} from "./retry-policy";

/** settings.json 里的容器键。 */
export const MODEL_RETRY_POLICY_KEY = "modelRetryPolicy";

/** 通配键：没有单独配置的 provider 全都用它的策略。 */
export const MODEL_RETRY_POLICY_WILDCARD = "*";

export interface ModelRetryPolicySettings {
  /** providerId → 策略；`*` 是兜底。 */
  providers: ModelRetryPolicyMap;
  /** `all` 档的等待上限（小时）。 */
  allMaxWaitHours: number;
}

export const MODEL_RETRY_POLICY_DEFAULTS: ModelRetryPolicySettings = {
  providers: {},
  allMaxWaitHours: DEFAULT_ALL_POLICY_MAX_WAIT_HOURS,
};

function normalizeSettings(value: unknown): ModelRetryPolicySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...MODEL_RETRY_POLICY_DEFAULTS };
  const raw = value as { providers?: unknown; allMaxWaitHours?: unknown };
  const hours = typeof raw.allMaxWaitHours === "number" && Number.isFinite(raw.allMaxWaitHours) && raw.allMaxWaitHours > 0
    ? raw.allMaxWaitHours
    : DEFAULT_ALL_POLICY_MAX_WAIT_HOURS;
  return { providers: parseModelRetryPolicyMap(raw.providers), allMaxWaitHours: hours };
}

export function readModelRetryPolicySettings(
  settingsPath: string = getPiWebSettingsPath(),
): ModelRetryPolicySettings {
  try {
    return normalizeSettings(readStored(settingsPath)[MODEL_RETRY_POLICY_KEY]);
  } catch {
    return { ...MODEL_RETRY_POLICY_DEFAULTS };
  }
}

/** 局部合并：只动 `modelRetryPolicy` 这一个键，settings.json 其余部分原样保留。 */
export function writeModelRetryPolicySettings(
  patch: Partial<ModelRetryPolicySettings>,
  settingsPath: string = getPiWebSettingsPath(),
): ModelRetryPolicySettings {
  const current = readModelRetryPolicySettings(settingsPath);
  const merged = normalizeSettings({
    ...current,
    ...patch,
    providers: patch.providers ?? current.providers,
  });
  updatePiWebSettings({ [MODEL_RETRY_POLICY_KEY]: merged }, settingsPath);
  return merged;
}

/**
 * 设置单个 provider 的策略。`default` 直接删键（回到「没有配置」），
 * 免得映射表里堆一堆等于默认值的条目，也让人一眼看出哪些 provider 被特意调过。
 */
export function setProviderModelRetryPolicy(
  providerId: string,
  policy: ModelRetryPolicy,
  settingsPath: string = getPiWebSettingsPath(),
): ModelRetryPolicySettings {
  const id = providerId.trim();
  if (!id) throw new Error("a provider id is required");
  if (!isModelRetryPolicy(policy)) throw new Error(`unknown retry policy: ${String(policy)}`);
  const current = readModelRetryPolicySettings(settingsPath);
  const providers: Record<string, ModelRetryPolicy> = { ...current.providers };
  if (policy === DEFAULT_MODEL_RETRY_POLICY) delete providers[id];
  else providers[id] = policy;
  return writeModelRetryPolicySettings({ providers }, settingsPath);
}

/** 某个 provider 生效的策略（先查自己，再查 `*`，最后默认档）。 */
export function effectiveModelRetryPolicy(
  providerId: string | null | undefined,
  settings: ModelRetryPolicySettings = readModelRetryPolicySettings(),
): ModelRetryPolicy {
  if (!providerId) return normalizeModelRetryPolicy(settings.providers[MODEL_RETRY_POLICY_WILDCARD]);
  const exact = settings.providers[providerId];
  if (exact !== undefined) return normalizeModelRetryPolicy(exact);
  return resolveModelRetryPolicy(MODEL_RETRY_POLICY_WILDCARD, settings.providers);
}

/** 会话侧调用：避开注入 agentDir 的测试与多 agent 目录。 */
export function effectiveModelRetryPolicyForAgentDir(
  providerId: string | null | undefined,
  agentDir: string = getAgentDir(),
): ModelRetryPolicy {
  return effectiveModelRetryPolicy(providerId, readModelRetryPolicySettings(getPiWebSettingsPath(agentDir)));
}
