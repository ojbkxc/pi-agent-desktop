/**
 * 技能市场的共享类型与上限。
 *
 * 两个上游（clawhub.ai、api.skillhub.cn）的响应形状完全不同，这里先各自 normalize 成
 * `NormalizedSkill` / `NormalizedSkillDetail`，再在 service 层合并、去重、分页；UI 只认这里
 * 的形状。字段语义对齐 cc-haha 的 `desktop/src/types/market.ts`（同一份市场能力，便于对读），
 * 但只保留本仓真正会渲染的部分。
 */

export type MarketSource = "clawhub" | "skillhub";

export const MARKET_SOURCES: readonly MarketSource[] = ["clawhub", "skillhub"];

/** 安全扫描结论。unknown = 上游没给扫描结果（不等于安全）。 */
export type SecurityStatus = "verified" | "benign" | "unknown" | "flagged";

export type InstallState = "installed" | "installable" | "not-installable";

export type SourceHealthStatus = "ok" | "degraded" | "failed" | "cached";

export type NotInstallableReason =
  | "empty-file-list"
  | "file-too-large"
  | "too-many-files"
  | "invalid-name"
  | "name-conflict"
  | "source-unavailable";

export interface SecurityReport {
  vendor: string;
  status: string;
  statusText: string;
  /** 扫描器自己的解释（有才给）。 */
  summary?: string;
  reportUrl?: string;
}

/** 市场里的一张卡（列表项）。 */
export interface NormalizedSkill {
  /** 稳定 id：`<source>:<slug>`（clawhub 的 slug 在不同 owner 下可重复，见 owner 字段）。 */
  id: string;
  source: MarketSource;
  slug: string;
  /**
   * clawhub 的 slug 跨 owner 重复，所有按 slug 的读取都要钉住 owner；
   * list/search 都会带上它，detail / install 原样回传。
   */
  owner?: string;
  name: string;
  summary: string;
  author: { handle: string; displayName?: string; avatarUrl?: string };
  stats: { downloads: number; installs?: number; stars?: number };
  tags: string[];
  category?: string;
  version?: string;
  updatedAt?: number;
  iconUrl?: string;
  securityStatus: SecurityStatus;
  securityReports?: SecurityReport[];
  /** 该技能页在注册源网站上的地址（只用于展示与「去来源看看」）。 */
  pageUrl?: string;
  installState: InstallState;
  notInstallableReason?: NotInstallableReason;
  installedInfo?: { version?: string; installedAt?: string; dirName: string };
}

export interface MarketFileMeta {
  path: string;
  size: number;
  sha256?: string;
  contentType?: string;
  language: string;
  tooBig: boolean;
}

/** 详情页的数据：卡片字段 + SKILL.md 正文 + 文件清单。 */
export interface NormalizedSkillDetail extends NormalizedSkill {
  /** SKILL.md 去掉 frontmatter 后的正文（markdown）。 */
  description: string;
  descriptionFrontmatter?: Record<string, unknown>;
  license?: string;
  files: MarketFileMeta[];
  totalSize: number;
  changelog?: { version?: string; text: string; publishedAt?: number };
}

export interface ProviderListPage {
  items: NormalizedSkill[];
  /** 该源自己的下一页游标；没有更多时为 undefined。 */
  nextCursor?: string;
}

export interface ProviderFileEntry {
  path: string;
  size: number;
  sha256?: string;
  contentType?: string;
}

export interface MarketProvider {
  source: MarketSource;
  list(input: { cursor?: string; limit: number }): Promise<ProviderListPage>;
  search(input: { q: string; limit: number }): Promise<ProviderListPage>;
  detail(slug: string, owner?: string): Promise<NormalizedSkillDetail>;
  listFiles(slug: string, owner?: string, version?: string): Promise<ProviderFileEntry[]>;
  fetchFile(slug: string, filePath: string, owner?: string): Promise<{ content: string; size: number }>;
}

/**
 * 安装 / 预览上限。与 cc-haha 同口径：单文件 5MB、整包 20MB、200 个文件。
 * 超限不截断——直接判 not-installable 并说明原因，避免装出半个技能。
 */
export const MARKET_LIMITS = {
  maxFileSize: 5 * 1024 * 1024,
  maxTotalSize: 20 * 1024 * 1024,
  maxFileCount: 200,
  /** 文件预览正文截断阈值（超过就只给前 N 字节 + truncated 标记）。 */
  previewTruncateBytes: 300 * 1024,
  /** 搜索无分页，合并后结果上限。 */
  searchResultCap: 50,
  /** 列表页每页条数上限。 */
  maxPageSize: 24,
} as const;

/** 可接受的上游 owner handle（clawhub 的 `?owner=` 与安装请求都只收这个形状）。 */
export const MARKET_OWNER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** 技能 slug：只允许安全字符，直接参与落盘目录名，绝不能带路径分隔符或 `..`。 */
export const MARKET_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function skillId(source: MarketSource, slug: string): string {
  return `${source}:${slug}`;
}

export function parseSkillId(id: string): { source: MarketSource; slug: string } | null {
  const separator = id.indexOf(":");
  if (separator <= 0) return null;
  const source = id.slice(0, separator) as MarketSource;
  const slug = id.slice(separator + 1);
  if (!MARKET_SOURCES.includes(source)) return null;
  if (!MARKET_SLUG_PATTERN.test(slug)) return null;
  return { source, slug };
}

/** 落盘目录名：`<source>-<slug>`，两个来源同名技能不会互相覆盖。 */
export function sanitizeDirName(source: MarketSource, slug: string): string {
  const cleaned = slug.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 60);
  return `${source}-${cleaned || "skill"}`;
}

/** 按扩展名猜语言，只用于文件列表上的小标签与预览高亮。 */
export function detectMarketLanguage(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    md: "markdown", markdown: "markdown", json: "json", yaml: "yaml", yml: "yaml",
    js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript",
    jsx: "javascript", py: "python", sh: "shell", bash: "shell", ps1: "powershell",
    css: "css", html: "html", txt: "text", toml: "toml", ini: "ini",
  };
  return map[extension] ?? "text";
}

/** 上游错误：带上来源与错误码，路由层据此决定 HTTP 状态。 */
export class MarketUpstreamError extends Error {
  constructor(
    readonly source: MarketSource,
    readonly code: keyof typeof MARKET_ERROR_CODES,
    message: string,
  ) {
    super(message);
    this.name = "MarketUpstreamError";
  }
}

export const MARKET_ERROR_CODES = {
  upstreamError: "upstream-error",
  upstreamBadResponse: "upstream-bad-response",
  sourceUnavailable: "source-unavailable",
  notFound: "not-found",
  notInstallable: "not-installable",
  installInProgress: "install-in-progress",
  uninstallRefused: "uninstall-refused",
} as const;