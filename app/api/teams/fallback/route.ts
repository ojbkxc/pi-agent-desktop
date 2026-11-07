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
import { parseUnattendedConfigUpdate } from "@/lib/agent-teams-unattended-config";

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
 *
 * ⚠️ 本文件只能导出 Next 约定名（GET/PUT/POST、dynamic、runtime…）。校验逻辑
 * 在 lib/agent-teams-unattended-config.ts —— 多一个具名导出会让生成的 .next/types
 * 做结构校验时报 TS2344，`npm run build`（只在 e2e job 跑）红，而 checks 看不见。
 */

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
