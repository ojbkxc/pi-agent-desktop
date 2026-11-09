import { NextResponse } from "next/server";
import { listInstalledMarketSkills, marketSkillsDir } from "@/lib/skill-market/install-service";
import { getSourceHealth } from "@/lib/skill-market/provider-fetch";
import { MARKET_SOURCES } from "@/lib/skill-market/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/installed —— 已安装的市场技能（含落盘目录与版本）。
 *
 * 装完一个技能后，**已打开的会话不会自动重新加载技能**：SDK 的技能表在会话启动时装配。
 * 这里不主动重启任何会话，UI 只提示「新会话即可用；已打开的会话需要重载」。
 */
export async function GET() {
  const installed = await listInstalledMarketSkills();
  return NextResponse.json(
    {
      items: installed,
      root: marketSkillsDir(),
      sources: MARKET_SOURCES,
      health: getSourceHealth(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}