/**
 * ClawHub（https://clawhub.ai）provider。
 *
 * 端点（2026-11 实测）：
 *   GET /api/v1/skills?limit=&cursor=&sort=downloads  → { items[], nextCursor }
 *   GET /api/v1/search?q=                            → { results[] }（无分页）
 *   GET /api/v1/skills/{slug}?owner=                 → { skill, latestVersion, owner, moderation }
 *   GET /api/v1/skills/{slug}/versions/{v}?owner=     → { version: { files[], license, security } }
 *   GET /api/v1/skills/{slug}/file?path=&owner=       → 原始文件文本
 *
 * owner 是必须钉住的：同一个 slug 在不同 owner 下可重复，不带 owner 的读取会拿到
 * 409 `AMBIGUOUS_SKILL_SLUG`。列表与搜索都会带出 owner，页面回传即可。
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { providerFetch, providerFetchJson, getProviderBase, readTextWithLimit } from "./provider-fetch";
import {
  detectMarketLanguage,
  MarketUpstreamError,
  skillId,
  type MarketProvider,
  type NormalizedSkill,
  type NormalizedSkillDetail,
  type ProviderFileEntry,
  type ProviderListPage,
  type SecurityReport,
  type SecurityStatus,
} from "./types";
import { MARKET_LIMITS } from "./types";

const CLAWHUB_SITE = "https://clawhub.ai";

interface ClawhubStats {
  downloads?: number;
  installs?: number;
  stars?: number;
}

interface ClawhubListItem {
  slug?: string;
  ownerHandle?: string;
  displayName?: string;
  summary?: string;
  description?: string | null;
  topics?: unknown;
  tags?: Record<string, string>;
  stats?: ClawhubStats;
  updatedAt?: number;
  createdAt?: number;
  latestVersion?: { version?: string };
}

interface ClawhubSearchResult {
  slug?: string;
  ownerHandle?: string;
  owner?: { handle?: string; displayName?: string; image?: string };
  displayName?: string;
  summary?: string;
  downloads?: number;
  updatedAt?: number;
  source?: string;
  install?: { kind?: string };
}

interface ClawhubScanner {
  status?: string;
  normalizedStatus?: string;
  recommendation?: string;
  summary?: string;
}

interface ClawhubSecurity {
  status?: string;
  hasWarnings?: boolean;
  virustotalUrl?: string;
  scanners?: { vt?: ClawhubScanner; skillspector?: ClawhubScanner; llm?: ClawhubScanner };
}

interface ClawhubDetail {
  skill?: {
    slug?: string;
    displayName?: string;
    summary?: string;
    description?: string;
    topics?: unknown;
    tags?: Record<string, string>;
    stats?: ClawhubStats;
    updatedAt?: number;
    latestVersion?: { version?: string };
    icon?: string;
  };
  owner?: { handle?: string; displayName?: string; image?: string };
  latestVersion?: { version?: string; license?: string; createdAt?: number; changelog?: string };
}

interface ClawhubVersionDetail {
  version?: {
    version?: string;
    license?: string;
    files?: Array<{ path?: string; size?: number; sha256?: string; contentType?: string }>;
    security?: ClawhubSecurity;
  };
}

function firstTagVersion(tags: Record<string, string> | undefined): string | undefined {
  return tags?.latest?.trim() || undefined;
}

function topicsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapSecurity(security: ClawhubSecurity | undefined): { status: SecurityStatus; reports: SecurityReport[] } {
  if (!security?.status) return { status: "unknown", reports: [] };
  const clean = security.status === "clean";
  const reports: SecurityReport[] = [{
    vendor: "clawhub-scan",
    status: security.status,
    statusText: clean
      ? security.hasWarnings ? "Clean (with warnings)" : "Clean"
      : `Scan status: ${security.status}`,
    reportUrl: security.virustotalUrl,
  }];
  const scanners: Array<[string, ClawhubScanner | undefined]> = [
    ["VirusTotal", security.scanners?.vt],
    ["skillspector", security.scanners?.skillspector],
    ["LLM review", security.scanners?.llm],
  ];
  for (const [vendor, scanner] of scanners) {
    const status = scanner?.normalizedStatus || scanner?.status;
    if (typeof status !== "string" || !status) continue;
    reports.push({
      vendor,
      status,
      statusText: scanner?.recommendation ? `${status} · ${scanner.recommendation}` : status,
      ...(scanner?.summary ? { summary: scanner.summary } : {}),
      ...(vendor === "VirusTotal" && security.virustotalUrl ? { reportUrl: security.virustotalUrl } : {}),
    });
  }
  return { status: clean ? "benign" : "flagged", reports };
}

function normalizeListItem(item: ClawhubListItem): NormalizedSkill {
  const slug = item.slug ?? "";
  return {
    id: skillId("clawhub", slug),
    source: "clawhub",
    slug,
    owner: item.ownerHandle,
    name: item.displayName || slug,
    summary: item.summary || "",
    author: { handle: item.ownerHandle ?? "" },
    stats: {
      downloads: item.stats?.downloads ?? 0,
      installs: item.stats?.installs,
      stars: item.stats?.stars,
    },
    tags: topicsOf(item.topics),
    version: item.latestVersion?.version ?? firstTagVersion(item.tags),
    updatedAt: item.updatedAt,
    securityStatus: "unknown",
    pageUrl: item.ownerHandle
      ? `${CLAWHUB_SITE}/${encodeURIComponent(item.ownerHandle)}/skills/${encodeURIComponent(slug)}`
      : `${CLAWHUB_SITE}/skills/${encodeURIComponent(slug)}`,
    installState: "installable",
  };
}

function normalizeSearchResult(result: ClawhubSearchResult): NormalizedSkill {
  const slug = result.slug ?? "";
  const owner = result.owner?.handle || result.ownerHandle || "";
  return {
    id: skillId("clawhub", slug),
    source: "clawhub",
    slug,
    owner: owner || undefined,
    name: result.displayName || slug,
    summary: result.summary || "",
    author: {
      handle: owner,
      ...(result.owner?.displayName ? { displayName: result.owner.displayName } : {}),
      ...(result.owner?.image ? { avatarUrl: result.owner.image } : {}),
    },
    stats: { downloads: result.downloads ?? 0 },
    tags: [],
    updatedAt: result.updatedAt,
    securityStatus: "unknown",
    pageUrl: owner
      ? `${CLAWHUB_SITE}/${encodeURIComponent(owner)}/skills/${encodeURIComponent(slug)}`
      : `${CLAWHUB_SITE}/skills/${encodeURIComponent(slug)}`,
    installState: "installable",
  };
}

/** 拼 owner 参数：只有形状合法的 handle 才会被带上（它也进 query string）。 */
function withOwner(url: URL, owner: string | undefined): URL {
  if (owner && /^[A-Za-z0-9_.-]{1,64}$/.test(owner)) url.searchParams.set("owner", owner);
  return url;
}

/** 409 的交集歧义：这是「必须指定 owner」，不是上游故障。 */
async function readAmbiguousOwner(response: Response): Promise<string | undefined> {
  const body = await response.json().catch(() => null) as { matches?: Array<{ ownerHandle?: string }> } | null;
  return body?.matches?.[0]?.ownerHandle;
}

async function clawhubFetch(url: URL, slug: string, owner: string | undefined): Promise<Response> {
  const response = await providerFetch("clawhub", withOwner(url, owner).toString());
  if (response.status !== 409) return response;
  // 没指定 owner 时按上游给的第一条匹配重试一次；指定了还 409 就是真异常。
  const resolved = owner ? undefined : await readAmbiguousOwner(response);
  if (!resolved) {
    throw new MarketUpstreamError("clawhub", "upstreamError", `clawhub responded 409 for ${slug}`);
  }
  return providerFetch("clawhub", withOwner(url, resolved).toString());
}

async function clawhubFetchJson<T>(url: URL, slug: string, owner: string | undefined): Promise<T> {
  const response = await clawhubFetch(url, slug, owner);
  if (!response.ok) {
    throw new MarketUpstreamError(
      "clawhub",
      response.status === 404 ? "notFound" : "upstreamError",
      `clawhub responded ${response.status} for ${url.pathname}`,
    );
  }
  const { content } = await readTextWithLimit("clawhub", response, 8 * 1024 * 1024, `response for ${url.pathname}`);
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new MarketUpstreamError("clawhub", "upstreamBadResponse", "clawhub returned invalid JSON");
  }
}

export const clawhubProvider: MarketProvider = {
  source: "clawhub",

  async list({ cursor, limit }): Promise<ProviderListPage> {
    const url = new URL("/api/v1/skills", getProviderBase("clawhub"));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "downloads");
    if (cursor) url.searchParams.set("cursor", cursor);
    const data = await providerFetchJson<{ items?: ClawhubListItem[]; nextCursor?: unknown }>("clawhub", url.toString());
    if (!Array.isArray(data.items)) {
      throw new MarketUpstreamError("clawhub", "upstreamBadResponse", "clawhub list missing items");
    }
    const nextCursor = typeof data.nextCursor === "string"
      ? data.nextCursor
      : data.nextCursor && typeof data.nextCursor === "object"
        ? Buffer.from(JSON.stringify(data.nextCursor), "utf-8").toString("base64url")
        : undefined;
    return {
      items: data.items.filter((item) => item?.slug).map(normalizeListItem),
      nextCursor,
    };
  },

  async search({ q, limit }): Promise<ProviderListPage> {
    const url = new URL("/api/v1/search", getProviderBase("clawhub"));
    url.searchParams.set("q", q);
    const data = await providerFetchJson<{ results?: ClawhubSearchResult[] }>("clawhub", url.toString());
    if (!Array.isArray(data.results)) {
      throw new MarketUpstreamError("clawhub", "upstreamBadResponse", "clawhub search missing results");
    }
    // 搜索结果会混进别家注册源，它们的 slug 在本源没有详情/文件端点；先过滤再截断，
    // 免得外部结果把本源的配额吃掉。
    const native = data.results.filter((result) => result?.slug
      && (result.source === undefined || result.source === "clawhub")
      && (result.install?.kind === undefined || result.install.kind === "clawhub"));
    return { items: native.slice(0, limit).map(normalizeSearchResult) };
  },

  async detail(slug, owner): Promise<NormalizedSkillDetail> {
    const base = getProviderBase("clawhub");
    const data = await clawhubFetchJson<ClawhubDetail>(
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, base),
      slug,
      owner,
    );
    if (!data.skill?.slug) {
      throw new MarketUpstreamError("clawhub", "upstreamBadResponse", "clawhub detail missing skill");
    }

    const version = data.latestVersion?.version || data.skill.latestVersion?.version;
    let files: ProviderFileEntry[] = [];
    let license = data.latestVersion?.license;
    let security: { status: SecurityStatus; reports: SecurityReport[] } = { status: "unknown", reports: [] };
    if (version) {
      try {
        const versionDetail = await clawhubFetchJson<ClawhubVersionDetail>(
          new URL(`/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`, base),
          slug,
          owner ?? data.owner?.handle,
        );
        files = (versionDetail.version?.files ?? [])
          .filter((file): file is { path: string } & typeof file => typeof file.path === "string" && file.path.length > 0)
          .map((file) => ({
            path: file.path,
            size: file.size ?? 0,
            sha256: file.sha256,
            contentType: file.contentType,
          }));
        license = versionDetail.version?.license || license;
        security = mapSecurity(versionDetail.version?.security);
      } catch {
        // 版本详情是加分项：拿不到文件清单，详情页仍可展示正文与元数据。
      }
    }

    // clawhub 的 `description` 就是 SKILL.md 的全文（frontmatter + 正文）。
    const raw = data.skill.description || "";
    let body = raw;
    let frontmatter: Record<string, unknown> | undefined;
    if (raw.startsWith("---")) {
      try {
        const parsed = parseFrontmatter<Record<string, unknown>>(raw);
        body = parsed.body;
        frontmatter = parsed.frontmatter;
      } catch {
        // frontmatter 不合法就保留原文，至少内容不丢。
      }
    }

    const item = normalizeListItem({
      ...data.skill,
      // detail 的 skill 对象不带 ownerHandle，用 owner.handle 补上。
      ownerHandle: data.owner?.handle,
    });
    const changelogText = typeof data.latestVersion?.changelog === "string" ? data.latestVersion.changelog.trim() : "";
    return {
      ...item,
      version,
      ...(changelogText
        ? { changelog: { version, text: changelogText, publishedAt: typeof data.latestVersion?.createdAt === "number" ? data.latestVersion.createdAt : undefined } }
        : {}),
      author: {
        handle: data.owner?.handle || "",
        ...(data.owner?.displayName ? { displayName: data.owner.displayName } : {}),
        ...(data.owner?.image ? { avatarUrl: data.owner.image } : {}),
      },
      ...(data.skill.icon ? { iconUrl: data.skill.icon } : {}),
      securityStatus: security.status,
      securityReports: security.reports.length ? security.reports : undefined,
      description: body,
      descriptionFrontmatter: frontmatter,
      license,
      files: files.map((file) => ({
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

  async listFiles(slug, owner, version): Promise<ProviderFileEntry[]> {
    const base = getProviderBase("clawhub");
    let resolved = version;
    if (!resolved) {
      const data = await clawhubFetchJson<ClawhubDetail>(
        new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, base),
        slug,
        owner,
      );
      resolved = data.latestVersion?.version || data.skill?.latestVersion?.version;
    }
    if (!resolved) return [];
    const detail = await clawhubFetchJson<ClawhubVersionDetail>(
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(resolved)}`, base),
      slug,
      owner,
    );
    return (detail.version?.files ?? [])
      .filter((file): file is { path: string } & typeof file => typeof file.path === "string" && file.path.length > 0)
      .map((file) => ({ path: file.path, size: file.size ?? 0, sha256: file.sha256, contentType: file.contentType }));
  },

  async fetchFile(slug, filePath, owner): Promise<{ content: string; size: number }> {
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, getProviderBase("clawhub"));
    url.searchParams.set("path", filePath);
    const response = await clawhubFetch(url, slug, owner);
    if (!response.ok) {
      throw new MarketUpstreamError(
        "clawhub",
        response.status === 404 ? "notFound" : "upstreamError",
        `clawhub file fetch failed (${response.status})`,
      );
    }
    return readTextWithLimit("clawhub", response, MARKET_LIMITS.maxFileSize, `file ${filePath}`);
  },
};