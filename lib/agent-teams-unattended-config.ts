/**
 * 无人值守兜底——设置面 PUT body 的校验与合并。
 *
 * 独立放在 lib/ 而不是 route.ts：Next 的路由模块只允许约定导出
 * （GET/POST/PUT/…、dynamic、runtime 等），多一个具名导出会让生成的
 * `.next/types` 报 TS2344、build 直接红。抽出来还顺带保住了可单测性
 * （见 app/api/teams/fallback/route.test.mjs）。
 */
import type { UnattendedConfig } from "./agent-teams-unattended";

// 下限 1 分钟：再短会在 lead 还没机会处理前反复提醒。
export const MIN_APPROVAL_TIMEOUT_MS = 60_000;
// 上限 24 小时：再长实际等于「永不提醒」。
export const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000;
// 0=只通知用户、不自动恢复；上限 5 防重试风暴。
export const MAX_RETRY_LIMIT = 5;

export type ConfigUpdateParse =
  | { ok: true; config: UnattendedConfig }
  | { ok: false; error: string };

/** 校验并合并 PUT body 到现有 config：只认三个字段，未给的保持原值。 */
export function parseUnattendedConfigUpdate(raw: unknown, current: UnattendedConfig): ConfigUpdateParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const config: UnattendedConfig = { ...current };

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    config.enabled = body.enabled;
  }
  if (body.approvalTimeoutMs !== undefined) {
    const value = body.approvalTimeoutMs;
    if (typeof value !== "number" || !Number.isInteger(value)
      || value < MIN_APPROVAL_TIMEOUT_MS || value > MAX_APPROVAL_TIMEOUT_MS) {
      return { ok: false, error: `approvalTimeoutMs must be an integer between ${MIN_APPROVAL_TIMEOUT_MS} and ${MAX_APPROVAL_TIMEOUT_MS}` };
    }
    config.approvalTimeoutMs = value;
  }
  if (body.maxFailureRetries !== undefined) {
    const value = body.maxFailureRetries;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_RETRY_LIMIT) {
      return { ok: false, error: `maxFailureRetries must be an integer between 0 and ${MAX_RETRY_LIMIT}` };
    }
    config.maxFailureRetries = value;
  }
  return { ok: true, config };
}