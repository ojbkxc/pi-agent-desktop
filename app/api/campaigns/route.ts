import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { campaignCreateErrors } from "@/lib/campaign/gate";
import { createCampaign, listCampaigns } from "@/lib/campaign/store";
import {
  isCampaignValidationError,
  type Campaign,
  type CampaignCreateInput,
  type CampaignItemDraft,
} from "@/lib/campaign/types";
import { startCampaign } from "@/lib/campaign/runner";

export const dynamic = "force-dynamic";

/**
 * `/api/campaigns` —— 「长时自主项目战役」列表 / 创建。
 *
 * 创建闸（设计 §5、§6）：`campaignCreateErrors` 先做纯形状校验，再叠加两道 IO 检查
 * ——**成本闸前置**（`maxTotalCostUsd>0` 必填，否则拒绝）与**安全闸**（必须是 git
 * 仓、命令审批档至少 `dangerous`）。任一不过即 400，返回稳定错误码 `campaign.error.<code>`。
 * 通过后 `createCampaign()` 落盘为 `queued`，再 `void startCampaign(id)` 异步驱动。
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

function validationResponse(errors: string[]): NextResponse {
  const code = errors[0];
  return NextResponse.json({
    error: errors.join(", "),
    code: "validation",
    ...(code ? { key: `campaign.error.${code}` } : {}),
    errors,
  }, { status: 400 });
}

function errorResponse(error: unknown): NextResponse {
  if (isCampaignValidationError(error)) {
    return NextResponse.json({
      error: error.message,
      code: "validation",
      key: `campaign.error.${error.reason}`,
      ...(error.params ? { params: error.params } : {}),
    }, { status: 400 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

function optionalNumeric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return numeric(value);
}

// GET /api/campaigns —— 全部战役，最新的在前（列表页）。
export async function GET() {
  try {
    const campaigns: Campaign[] = listCampaigns();
    return NextResponse.json({ campaigns });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/campaigns —— 建战役并立刻排队驱动（后台运行，立即返回 201）。
export async function POST(req: Request) {
  const rejected = rejectUnsafeWrite(req);
  if (rejected) return rejected;
  try {
    const body: unknown = await req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    const raw = body as Record<string, unknown>;
    const maxItems = optionalNumeric(raw.maxItems);
    const maxTotalRounds = optionalNumeric(raw.maxTotalRounds);
    const intervalMs = optionalNumeric(raw.intervalMs);
    const truthFile = typeof raw.truthFile === "string" && raw.truthFile.trim() ? raw.truthFile.trim() : undefined;

    const input: CampaignCreateInput = {
      objective: typeof raw.objective === "string" ? raw.objective : "",
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      items: Array.isArray(raw.items) ? (raw.items as CampaignItemDraft[]) : [],
      maxTotalCostUsd: numeric(raw.maxTotalCostUsd),
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(maxTotalRounds !== undefined ? { maxTotalRounds } : {}),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(truthFile ? { truthFile } : {}),
    };

    // 形状 + 成本闸 + git + 审批档：任一不过即 400（真实 git/设置读取在 gate 内）。
    const errors = campaignCreateErrors(input);
    if (errors.length > 0) return validationResponse(errors);

    const created = createCampaign(input);
    // 异步驱动：PI_WEB_DISABLE_CAMPAIGN_DRIVER=1 时 startCampaign 自身是 no-op（测试缝）。
    void startCampaign(created.id);
    return NextResponse.json({ campaign: created }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
