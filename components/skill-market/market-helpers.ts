/**
 * 技能市场前端的共享形状与小工具。
 *
 * 从服务端接口的字段直接镜像过来（`lib/skill-market/types.ts`），只挑 UI 用到的部分，
 * 这样组件里不 import 服务端模块（那个模块会拖进 node:fs）。
 */

export type MarketSource = "clawhub" | "skillhub";
export type MarketSourceFilter = MarketSource | "all";

export const SOURCE_ALL = "all" as const;
export const SKILL_MARKET_SOURCES: readonly MarketSource[] = ["clawhub", "skillhub"];
export const MARKET_PAGE_SIZE = 12;

export type InstalledState = "installed" | "installable" | "not-installable";

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
}

/** 下载量的紧凑写法：491656 → 491.7K。 */
export function formatDownloads(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
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

/** 详情页的文件清单排序：SKILL.md 在最前，其余按路径字母序。 */
export function sortMarketFiles<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    if (a.path === "SKILL.md") return -1;
    if (b.path === "SKILL.md") return 1;
    return a.path.localeCompare(b.path);
  });
}