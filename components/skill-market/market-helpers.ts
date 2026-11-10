/**
 * 技能市场前端的共享形状与小工具。
 *
 * 从服务端接口的字段直接镜像过来（`lib/skill-market/types.ts`），只挑 UI 用到的部分，
 * 这样组件里不 import 服务端数据模块（那些会拖进 node:fs / 355KB 快照）。中英文案选择
 * 复用 `lib/skill-market/catalog-locale.ts`——它不 import 快照，可安全进客户端 bundle。
 */

import {
  categoryLabel as catalogCategoryLabel,
  skillSummary as catalogSkillSummary,
  visibleTags as catalogVisibleTags,
} from "@/lib/skill-market/catalog-locale";

export type MarketSource = "clawhub" | "skillhub";
export type MarketSourceFilter = MarketSource | "all";

export const SOURCE_ALL = "all" as const;
export const SKILL_MARKET_SOURCES: readonly MarketSource[] = ["clawhub", "skillhub"];
/** 每页条数，与 cc-haha 的 marketStore PAGE_SIZE 对齐（24）。 */
export const MARKET_PAGE_SIZE = 24;

/** 安全状态筛选：`all` 表示不筛，其余与 NormalizedSkill.securityStatus 一一对应。 */
export type MarketSecurityStatus = "verified" | "benign" | "unknown" | "flagged";
export type MarketSecurityFilter = MarketSecurityStatus | "all";
export const SECURITY_ALL = "all" as const;
export const SKILL_MARKET_SECURITY_FILTERS: readonly MarketSecurityFilter[] =
  ["all", "verified", "benign", "unknown", "flagged"];

/** 安装状态筛选：`all` 不筛，`installable` 即「未安装」。 */
export type MarketInstalledFilter = "all" | "installed" | "installable";
export const INSTALLED_ALL = "all" as const;
export const SKILL_MARKET_INSTALLED_FILTERS: readonly MarketInstalledFilter[] =
  ["all", "installed", "installable"];

/** 三个筛选的下拉选项 i18n 键（键值集中在 locale-plugins.ts，缺键会渲染键名本身）。 */
export function sourceFilterLabelKey(value: MarketSourceFilter): string {
  return value === SOURCE_ALL ? "market.source.all" : `market.source.${value}`;
}
export function securityFilterLabelKey(value: MarketSecurityFilter): string {
  return value === SECURITY_ALL ? "market.security.all" : `market.security.${value}`;
}
export function installedFilterLabelKey(value: MarketInstalledFilter): string {
  return value === INSTALLED_ALL ? "market.installedFilter.all" : `market.installedFilter.${value}`;
}

export type InstalledState = "installed" | "installable" | "not-installable";

/** 精选目录的一类（服务端在 catalog 作用域返回，count 是全量静态计数）。 */
export interface MarketCategory {
  key: string;
  /** 简中展示名（目录按简中编辑）。 */
  name: string;
  /** 英文展示名（非中文语言用）。 */
  nameEn: string;
  count: number;
}

export interface MarketSecurityReport {
  vendor: string;
  status: string;
  statusText: string;
  summary?: string;
  reportUrl?: string;
}

/** 列表项（卡片）。已安装清单也复用这个形状（缺字段一律可选）。 */
export interface MarketListItem {
  id: string;
  source: MarketSource;
  slug: string;
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
  securityStatus?: "verified" | "benign" | "unknown" | "flagged";
  securityReports?: MarketSecurityReport[];
  /** 精选目录标记：卡片上出「精选」徽标。 */
  featured?: boolean;
  /**
   * 条目属于（或匹配）精选目录。仅此时 `category` 才是目录分类 key；
   * 否则是 SkillHub 的原始分类字符串。catalog 路径后端每项都置 true。
   */
  curated?: boolean;
  /** 精选目录的简中摘要之外，保留上游英文摘要供非中文语言展示。 */
  summaryEn?: string;
  license?: string;
  /** 精选技能仍带风险结论时，编辑给出的说明（详情安全页签展示）。 */
  securityNote?: string;
  requiresApiKey?: boolean;
  pageUrl?: string;
  installState: InstalledState;
  installedInfo?: { version?: string; installedAt?: string; dirName: string };
  notInstallableReason?: string;
}

export interface MarketFileMeta {
  path: string;
  size: number;
  sha256?: string;
  contentType?: string;
  language: string;
  tooBig: boolean;
}

export interface MarketSkillDetail extends MarketListItem {
  description: string;
  descriptionFrontmatter?: Record<string, unknown>;
  license?: string;
  files: MarketFileMeta[];
  totalSize: number;
  changelog?: { version?: string; text: string; publishedAt?: number };
}

export interface MarketListResponse {
  items: MarketListItem[];
  nextCursor: string | null;
  sourceErrors: Array<{ source: string; message: string }>;
  /** catalog 作用域：整个目录里匹配的技能数（跨全部页）。 */
  total?: number;
  /** catalog 作用域：分类栏条目（含全量静态计数）。 */
  categories?: MarketCategory[];
  /** catalog 作用域：快照背后的上游读取时间（epoch 毫秒）。 */
  catalogUpdatedAt?: number;
}

/** 下载量的紧凑写法：491656 → 491.7K。 */
export function formatDownloads(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}

/** 紧凑计数，照 cc-haha marketFormat.ts：482069 → 482.1k，1500000 → 1.5M。 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * 上游时间戳（epoch 毫秒）→ ISO 日期（YYYY-MM-DD）。
 * 用 ISO 而非本地化格式，保证任何语言下同一技能读作同一天；无效值返回空串。
 */
export function formatIsoDate(timestamp: number | undefined): string {
  if (timestamp === undefined) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** 是否为中文语言（zh-CN / zh-TW）。目录按简中编辑，中文读者看 name，其余看 nameEn。 */
export function isChineseLocale(locale: string): boolean {
  return locale === "zh-CN" || locale === "zh-TW";
}

/**
 * 本仓语言是 zh-CN / zh-TW；`lib/skill-market/catalog-locale.ts`（服务端同一份共享实现）
 * 认的是 cc-haha 的 `zh` / `zh-TW`。归一化后委托过去，既保持单一事实来源，又不让 zh-CN 落空。
 */
function toCatalogLocale(locale: string): string {
  return locale === "zh-CN" ? "zh" : locale;
}

/** 分类展示名：中文取 name，其余语言取 nameEn（缺省回退 name）。 */
export function categoryLabel(category: Pick<MarketCategory, "name" | "nameEn">, locale: string): string {
  return catalogCategoryLabel(category, toCatalogLocale(locale));
}

/** 摘要展示：非中文语言优先上游英文摘要（summaryEn），缺省回退目录摘要。 */
export function skillSummary(item: Pick<MarketListItem, "summary" | "summaryEn">, locale: string): string {
  return catalogSkillSummary(item, toCatalogLocale(locale));
}

/** 标签展示：精选且非中文时隐藏（中文标签在英文摘要下是噪声）；上游 live 结果原样保留。 */
export function visibleTags(item: Pick<MarketListItem, "tags" | "curated">, locale: string): string[] {
  return catalogVisibleTags(item, toCatalogLocale(locale));
}

/** 字节数的紧凑写法（文件列表用）。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

/** 安全结论 → 徽标色调类名（样式在 app/native-theme.css 的 .market-badge 一组里）。 */
export function securityBadgeClass(status: string | undefined): string {
  if (status === "verified" || status === "benign") return "is-safe";
  if (status === "flagged") return "is-flagged";
  return "is-unknown";
}

/** 安全结论 → 一句话说明的 i18n 键（徽标 title；未知状态落到 unknown）。 */
export function securityHintKey(status: string | undefined): string {
  const known = status === "verified" || status === "benign" || status === "unknown" || status === "flagged";
  return `market.securityHint.${known ? status : "unknown"}`;
}

/** 详情页的文件清单排序：SKILL.md 在最前，其余按路径字母序。 */
export function sortMarketFiles<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    if (a.path === "SKILL.md") return -1;
    if (b.path === "SKILL.md") return 1;
    return a.path.localeCompare(b.path);
  });
}