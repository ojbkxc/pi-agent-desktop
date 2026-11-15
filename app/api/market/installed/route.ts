import { NextResponse } from "next/server";
import { listInstalledMarketSkills, marketSkillsDir } from "@/lib/skill-market/install-service";
import { getSourceHealth } from "@/lib/skill-market/provider-fetch";
import { catalogEntryFor, catalogEntryToSkill } from "@/lib/skill-market/catalog";
import {
  MARKET_SOURCES,
  skillId,
  type MarketSource,
  type NormalizedSkill,
} from "@/lib/skill-market/types";

export const dynamic = "force-dynamic";

/** `listInstalledMarketSkills()` 返回的条目形状（install-service 的 MarketMeta + 目录名/路径）。 */
interface InstalledMeta {
  source: MarketSource;
  slug: string;
  owner?: string;
  version?: string;
  installedAt: string;
  files: number;
  dirName: string;
  path: string;
}

/**
 * 已安装清单的一条 → 卡片用的列表项。
 *
 * `.market-meta.json` 只有 source/slug/owner/version/installedAt/files——没有
 * name/summary/tags/iconUrl，直接喂给卡片会崩（`item.name.slice`）。这里优先从精选
 * 快照补全编辑性字段；clawhub 的 slug 跨 owner 可重复，安装记录里的 owner 与目录钉住的
 * 不一致时绝不冒用别人的精选结论；快照里没有（或 owner 对不上）时回退 slug 当名字、
 * 空摘要、未知安全结论——卡片侧还有一层防御回退兜底。
 */
function toListItem(meta: InstalledMeta): NormalizedSkill {
  const entry = catalogEntryFor(meta.source, meta.slug);
  const curated = entry && !(meta.source === "clawhub" && meta.owner && meta.owner !== entry.owner)
    ? catalogEntryToSkill(entry)
    : undefined;
  return {
    id: skillId(meta.source, meta.slug),
    source: meta.source,
    slug: meta.slug,
    ...(meta.owner ? { owner: meta.owner } : {}),
    name: curated?.name ?? meta.slug,
    summary: curated?.summary ?? "",
    author: curated?.author ?? { handle: meta.owner ?? "" },
    stats: curated?.stats ?? { downloads: 0 },
    tags: curated?.tags ?? [],
    ...(curated?.category ? { category: curated.category } : {}),
    // 已安装的版本是落盘时的版本，比快照里的更准。
    version: meta.version ?? curated?.version,
    ...(curated?.updatedAt !== undefined ? { updatedAt: curated.updatedAt } : {}),
    iconUrl: curated?.iconUrl,
    securityStatus: curated?.securityStatus ?? "unknown",
    ...(curated?.securityNote !== undefined ? { securityNote: curated.securityNote } : {}),
    ...(curated?.requiresApiKey !== undefined ? { requiresApiKey: curated.requiresApiKey } : {}),
    ...(curated?.license !== undefined ? { license: curated.license } : {}),
    ...(curated?.featured ? { featured: true } : {}),
    ...(curated ? { curated: true, summaryEn: curated.summaryEn } : {}),
    installState: "installed",
    installedInfo: {
      ...(meta.version ? { version: meta.version } : {}),
      installedAt: meta.installedAt,
      dirName: meta.dirName,
    },
  };
}

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
      items: installed.map((meta) => toListItem(meta)),
      root: marketSkillsDir(),
      sources: MARKET_SOURCES,
      health: getSourceHealth(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}