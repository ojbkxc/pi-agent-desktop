import { NextResponse } from "next/server";
import { readTeamWorkbench } from "@/lib/agent-teams-swimlane-store";

export const dynamic = "force-dynamic";

// 默认只保留最新 200 条通信消息：团队跑久了 history.jsonl 线性增长，3 秒轮询
// （TEAM_STRIP_POLL_MS）会把它整个下发。`?limit=` 可覆盖（数据/测试审计 A-3）。
const DEFAULT_MESSAGES_LIMIT = 200;
const MAX_MESSAGES_LIMIT = 2000;

function messagesLimitFrom(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit");
  if (!raw) return DEFAULT_MESSAGES_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MESSAGES_LIMIT;
  return Math.min(Math.floor(value), MAX_MESSAGES_LIMIT);
}

/**
 * `?since=<contentHash>` 条件请求：内容未变时回 304，让客户端省掉整棵快照的
 * JSON 解析与重渲染。内容指纹由 `deriveSnapshotContentHash` 算（除 generatedAt 外全量）。
 */
function sinceFrom(request: Request): string | null {
  const raw = new URL(request.url).searchParams.get("since");
  return raw && raw.length > 0 && raw.length <= 64 ? raw : null;
}

// GET /api/teams/[team]/workbench - 某团队的泳道快照（live）。
// 路径落在 /api/teams/* 下；public/lane-diagram.html 消费该快照。
export async function GET(
  request: Request,
  { params }: { params: Promise<{ team: string }> },
) {
  const { team } = await params;
  const snapshot = await readTeamWorkbench(decodeURIComponent(team), {
    messagesLimit: messagesLimitFrom(request),
  });
  if (!snapshot) {
    return NextResponse.json(
      { error: "团队不存在" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  // 内容没变：回 304（无 body），客户端直接复用上一帧。
  const since = sinceFrom(request);
  if (since !== null && since === snapshot.contentHash) {
    return new Response(null, { status: 304, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
