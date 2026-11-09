/**
 * SkillHub（https://api.skillhub.cn）provider。
 *
 * 端点（2026-11 实测）：
 *   GET /api/skills?page=&pageSize=&keyword=        → { code:0, data:{ skills[], total }, message }
 *   GET /api/v1/skills/{slug}                       → { skill, owner, latestVersion, securityReports }
 *   GET /api/v1/skills/{slug}/files                 → { count, files:[{path, sha256, size}], version }
 *   GET /api/v1/skills/{slug}/file?path=            → 302 到腾讯 COS（fetch 自动跟随）
 *
 * 详情**不含** SKILL.md 正文，要单独拉一次文件；列表的 securityReports 是逐 vendor 的对象
 * （腾讯 Keen / 三卜），`verified` 只是粗信号。
 */

import { providerFetch, providerFetchJson, getProviderBase, readTextWithLimit } from "./provider-fetch";
import {
  detectMarketLanguage,
  MarketUpstreamError,
  skillId,
  type MarketFileMeta,
  type MarketProvider,
  type NormalizedSkill,
  type NormalizedSkillDetail,
  type ProviderFileEntry,
  type ProviderListPage,
  type SecurityReport,
  type SecurityStatus,
} from "./types";
import { MARKET_LIMITS } from "./types";

const SKILLHUB_SITE = "https://skillhub.cn";

interface SkillhubListItem {
  slug?: string;
  name?: string;
  displayName?: string;
  summary?: string;
  summary_zh?: string;
  description?: string;
  description_zh?: string;
  category?: string;
  version?: string;
  updated_at?: number;
  created_at?: number;
  iconUrl?: string;
  verified?: boolean;
  downloads?: number;
  installs?: number;
  stars?: number;
  source?: string;
  upstream_url?: string | null;
  ownerName?: string;
  subCategories?: Array<{ name?: string }>;
  tags?: unknown;
  labels?: Record<string, string>;
}

interface SkillhubEnvelope<T> {
  code?: number;
  data?: T;
  message?: string;
}

type SkillhubSecurityReports = Record<
  string,
  { status?: string; statusText?: string; reportUrl?: string } | undefined
>;

interface SkillhubDetail {
  skill?: SkillhubListItem & { stats?: { downloads?: number; installs?: number; stars?: number } };
  owner?: { handle?: string; displayName?: string; image?: string };
  latestVersion?: { version?: string; changelog?: string; createdAt?: number };
  securityReports?: SkillhubSecurityReports;
}

const BENIGN_STATUSES = new Set(["benign", "safe", "clean"]);

function mapSecurity(
  reports: SkillhubSecurityReports | undefined,
  verified: boolean | undefined,
): { status: SecurityStatus; reports: SecurityReport[] } {
  const normalized: SecurityReport[] = [];
  for (const [vendor, report] of Object.entries(reports ?? {})) {
    if (!report?.status) continue;
    normalized.push({
      vendor,
      status: report.status,
      statusText: report.statusText || report.status,
      ...(report.reportUrl ? { reportUrl: report.reportUrl } : {}),
    });
  }
  if (normalized.length === 0) return { status: "unknown", reports: normalized };
  const anyFlagged = normalized.some((report) => !BENIGN_STATUSES.has(report.status.toLowerCase()));
  if (anyFlagged) return { status: "flagged", reports: normalized };
  return { status: verified ? "verified" : "benign", reports: normalized };
}

/**
 * SkillHub 镜像了 clawhub 的一批技能（`source: "clawhub"`）。这些条目的 `upstream_url`
 * 是 `https://clawhub.ai/{owner}/{slug}`，但**不能**当成 clawhub provider 的 slug 用：
 * 镜像版本的文件集与原站不一定一致，安装要走本源，否则装到的是另一份内容。
 * 这里只保留展示用的来源说明，不跨源去重（同名不同内容很常见）。
 */
function subCategoryTags(item: SkillhubListItem): string[] {
  return (item.subCategories ?? [])
    .map((sub) => sub?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function normalizeListItem(item: SkillhubListItem): NormalizedSkill {
  const slug = item.slug ?? "";
  return {
    id: skillId("skillhub", slug),
    source: "skillhub",
    slug,
    name: item.name || item.displayName || slug,
    summary: item.description_zh || item.description || item.summary_zh || item.summary || "",
    author: { handle: item.ownerName || "" },
    stats: {
      downloads: item.downloads ?? 0,
      installs: item.installs,
      stars: item.stars,
    },
    tags: subCategoryTags(item),
    category: item.category,
    version: item.version,
    updatedAt: item.updated_at,
    iconUrl: item.iconUrl || undefined,
    // 列表没有扫描报告，`verified` 是唯一的粗信号；详情接口再细化成 benign / flagged。
    securityStatus: item.verified ? "verified" : "unknown",
    pageUrl: `${SKILLHUB_SITE}/skills/${encodeURIComponent(slug)}`,
    installState: "installable",
  };
}

async function fetchPage(params: { keyword?: string; page: number; pageSize: number }): Promise<ProviderListPage & { total?: number }> {
  const url = new URL("/api/skills", getProviderBase("skillhub"));
  url.searchParams.set("page", String(params.page));
  url.searchParams.set("pageSize", String(params.pageSize));
  if (params.keyword) url.searchParams.set("keyword", params.keyword);

  const envelope = await providerFetchJson<SkillhubEnvelope<{ skills?: SkillhubListItem[]; total?: number }>>(
    "skillhub",
    url.toString(),
  );
  if (envelope.code !== 0 || !Array.isArray(envelope.data?.skills)) {
    throw new MarketUpstreamError(
      "skillhub",
      "upstreamBadResponse",
      `skillhub responded code=${envelope.code}: ${envelope.message || "bad payload"}`,
    );
  }
  const total = envelope.data.total ?? 0;
  return {
    items: envelope.data.skills.filter((item) => item?.slug).map(normalizeListItem),
    nextCursor: params.page * params.pageSize < total ? String(params.page + 1) : undefined,
    total,
  };
}

export const skillhubProvider: MarketProvider = {
  source: "skillhub",

  async list({ cursor, limit }): Promise<ProviderListPage> {
    const page = cursor ? Math.max(1, Number.parseInt(cursor, 10) || 1) : 1;
    return fetchPage({ page, pageSize: limit });
  },

  async search({ q, limit }): Promise<ProviderListPage> {
    // 搜索没有独立端点，用同一个列表接口的 keyword 参数；第一页足够。
    return fetchPage({ keyword: q, page: 1, pageSize: limit });
  },

  async detail(slug): Promise<NormalizedSkillDetail> {
    const base = getProviderBase("skillhub");
    const data = await providerFetchJson<SkillhubDetail>(
      "skillhub",
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, base).toString(),
    );
    if (!data.skill?.slug) {
      throw new MarketUpstreamError("skillhub", "upstreamBadResponse", "skillhub detail missing skill");
    }

    const item = normalizeListItem(data.skill);
    if (data.skill.stats) {
      item.stats = {
        downloads: data.skill.stats.downloads ?? item.stats.downloads,
        installs: data.skill.stats.installs ?? item.stats.installs,
        stars: data.skill.stats.stars ?? item.stats.stars,
      };
    }
    const security = mapSecurity(data.securityReports, data.skill.verified);
    const version = data.latestVersion?.version || item.version;
    const changelog = typeof data.latestVersion?.changelog === "string" ? data.latestVersion.changelog.trim() : "";
    const publishedAt = data.latestVersion?.createdAt;

    let files: ProviderFileEntry[] = [];
    try {
      files = await skillhubProvider.listFiles(slug);
    } catch {
      // 详情页的文件清单是加分项；安装时会重新拉一次，拿不到就只展示正文。
    }

    // 详情接口没有 SKILL.md 正文，单独拉一次给「概览」页签。
    let description = item.summary;
    if (files.some((file) => file.path === "SKILL.md")) {
      try {
        description = (await skillhubProvider.fetchFile(slug, "SKILL.md")).content;
      } catch {
        description = item.summary;
      }
    }

    return {
      ...item,
      version,
      ...(changelog
        ? { changelog: { version, text: changelog, publishedAt: typeof publishedAt === "number" ? publishedAt : undefined } }
        : {}),
      author: {
        handle: data.owner?.handle || item.author.handle,
        ...(data.owner?.displayName ? { displayName: data.owner.displayName } : {}),
        ...(data.owner?.image ? { avatarUrl: data.owner.image } : {}),
      },
      securityStatus: security.status,
      securityReports: security.reports.length ? security.reports : undefined,
      description,
      license: undefined,
      files: files.map((file): MarketFileMeta => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
        language: detectMarketLanguage(file.path),
        tooBig: file.size > MARKET_LIMITS.maxFileSize,
      })),
      totalSize: files.reduce((sum, file) => sum + (file.size || 0), 0),
    };
  },

  async listFiles(slug): Promise<ProviderFileEntry[]> {
    const base = getProviderBase("skillhub");
    const data = await providerFetchJson<{ count?: number; files?: Array<{ path?: string; sha256?: string; size?: number }> }>(
      "skillhub",
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}/files`, base).toString(),
    );
    if (!Array.isArray(data.files)) {
      throw new MarketUpstreamError("skillhub", "upstreamBadResponse", "skillhub files missing list");
    }
    return data.files
      .filter((file): file is { path: string; sha256?: string; size?: number } => typeof file?.path === "string" && file.path.length > 0)
      .map((file) => ({ path: file.path, size: file.size ?? 0, sha256: file.sha256 }));
  },

  async fetchFile(slug, filePath): Promise<{ content: string; size: number }> {
    const base = getProviderBase("skillhub");
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, base);
    url.searchParams.set("path", filePath);
    // 302 → 腾讯 COS；fetch 默认跟随重定向。
    const response = await providerFetch("skillhub", url.toString());
    if (!response.ok) {
      throw new MarketUpstreamError(
        "skillhub",
        response.status === 404 ? "notFound" : "upstreamError",
        `skillhub file fetch failed (${response.status})`,
      );
    }
    return readTextWithLimit("skillhub", response, MARKET_LIMITS.maxFileSize, `file ${filePath}`);
  },
};