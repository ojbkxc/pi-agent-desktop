import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { deleteCampaign, getCampaign } from "@/lib/campaign/store";
import { pauseCampaign, resumeCampaign, stopCampaign } from "@/lib/campaign/runner";
import { isActiveCampaignStatus, isTerminalCampaignStatus } from "@/lib/campaign/types";

export const dynamic = "force-dynamic";

/**
 * `/api/campaigns/[id]` —— 单战役读取 + 控制动作（stop / pause / resume）+ 删除。
 *
 * 控制动作交给 `lib/campaign/runner.ts`（异步、返回更新后的 Campaign）。终态战役
 * 不允许 stop/pause（409），活跃战役不允许 resume（409），与 `/api/autofix/[id]` 同口径。
 */

function rejectUnsafeWrite(req: Request): NextResponse | null {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}

const notFound = () => NextResponse.json({ error: "Campaign not found", code: "not_found" }, { status: 404 });

// GET /api/campaigns/[id] —— 单战役（含逐项 backlog 与轮次记录）。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const campaign = getCampaign(id);
  if (!campaign) return notFound();
  return NextResponse.json({ campaign });
}

// POST /api/campaigns/[id] —— { action: "stop" | "pause" | "resume" }。
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const rejected = rejectUnsafeWrite(req);
  if (rejected) return rejected;
  const { id } = await params;
  const campaign = getCampaign(id);
  if (!campaign) return notFound();

  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "stop" || action === "pause") {
    if (isTerminalCampaignStatus(campaign.status)) {
      return NextResponse.json(
        { error: "This campaign has already finished", code: "validation", key: "campaign.error.alreadyFinished" },
        { status: 409 },
      );
    }
    const updated = action === "stop" ? await stopCampaign(id) : await pauseCampaign(id);
    return NextResponse.json({ campaign: updated ?? campaign });
  }

  if (action === "resume") {
    if (isActiveCampaignStatus(campaign.status)) {
      return NextResponse.json(
        { error: "This campaign is already active", code: "validation", key: "campaign.error.alreadyActive" },
        { status: 409 },
      );
    }
    const updated = await resumeCampaign(id);
    return NextResponse.json({ campaign: updated ?? campaign });
  }

  return NextResponse.json(
    { error: "Unknown action", code: "validation", key: "campaign.error.unknownAction" },
    { status: 400 },
  );
}

// DELETE /api/campaigns/[id] —— 在跑时先停止，再删记录。
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const campaign = getCampaign(id);
  if (!campaign) return notFound();
  if (isActiveCampaignStatus(campaign.status)) await stopCampaign(id);
  const removed = deleteCampaign(id);
  return NextResponse.json({ success: removed });
}
