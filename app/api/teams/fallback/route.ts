import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  clearManualNeeds,
  isUnattendedDisabledByEnv,
  readUnattendedFile,
  unattendedSettingsPath,
  writeUnattendedConfig,
} from "@/lib/agent-teams-unattended-store";
import { type UnattendedConfig } from "@/lib/agent-teams-unattended";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 无人值守兜底的设置面。
 *
 * GET  → { config, envDisabled, manualNeeds }：envDisabled 如实反映
 *        `PI_WEB_DISABLE_TEAMS_FALLBACK=1`（被环境变量关掉时不能显示成开着）。
 * PUT  → 只改 config 的三个字段（范围校验），**只合并 config、绝不碰 state**。
 * POST → { action: "clear-manual-needs", keys }：只从 manualNeeds 删指定 key，
 *        不碰 config / approvalNudges / failureNudges。
 *
 * 写操作只允许本机请求（照 app/api/remote-access 的做法）。
 */

// 下限 1 分钟：再短会在 lead 还没机会处理前反复提醒。
const MIN_APPROVAL_TIMEOUT_MS = 60_000;
// 上限 24 小时：再长实际等于「永不提醒」。
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000;
// 0=只通知用户、不自动恢复；上限 5 防重试风暴。
const MAX_RETRY_LIMIT = 5;

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

function readView(path = unattendedSettingsPath()) {
  const { config, state } = readUnattendedFile(path);
  return { config, envDisabled: isUnattendedDisabledByEnv(), manualNeeds: state.manualNeeds ?? {} };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(readView(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Fallback settings can only be changed on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const parsed = parseUnattendedConfigUpdate(await req.json(), readUnattendedFile().config);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    writeUnattendedConfig(parsed.config);
    return NextResponse.json(readView(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

interface ClearBody {
  action?: unknown;
  keys?: unknown;
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Fallback settings can only be changed on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as ClearBody;
    if (body.action !== "clear-manual-needs") {
      return NextResponse.json({ error: "action must be clear-manual-needs" }, { status: 400 });
    }
    if (!Array.isArray(body.keys) || body.keys.length === 0
      || !body.keys.every((key): key is string => typeof key === "string" && key.length > 0)) {
      return NextResponse.json({ error: "keys must be a non-empty array of strings" }, { status: 400 });
    }
    clearManualNeeds(body.keys);
    return NextResponse.json(readView(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
