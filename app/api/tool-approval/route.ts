import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { APPROVAL_MODES, isApprovalMode, type ApprovalMode } from "@/lib/tool-approval/policy";
import { readApprovalMode, writeApprovalMode } from "@/lib/tool-approval/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/tool-approval — 当前模式与可选档位（设置页只读这里，不引 node 侧策略实现）。
export async function GET(req: Request) {
  return NextResponse.json(
    {
      mode: readApprovalMode(),
      modes: APPROVAL_MODES,
      local: isLocalRequest(req),
    },
    { headers: NO_STORE },
  );
}

// PUT /api/tool-approval  body: { mode: "off" | "dangerous" | "all" }
//
// 审批器决定 agent 执行 shell 命令前是否停下来等人，属于本机行为 —— 与监听端口、
// 代理、保活同一条本机限定规则（中继重放的手机请求会 403）。改完对**下一次**
// tool_call 立即生效：扩展每次调用都重新读设置，无需重开会话。
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      { error: "Command approval can only be changed on this computer." },
      { status: 403 },
    );
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { mode?: unknown } | null;
  try {
    body = await req.json() as { mode?: unknown } | null;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isApprovalMode(body?.mode)) {
    return NextResponse.json(
      { error: "mode must be one of off, dangerous, all" },
      { status: 400 },
    );
  }
  try {
    const mode: ApprovalMode = writeApprovalMode(body.mode);
    return NextResponse.json({ mode, modes: APPROVAL_MODES, local: true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}