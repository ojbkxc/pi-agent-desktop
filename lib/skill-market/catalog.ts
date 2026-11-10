/**
 * 精选技能目录（catalog）：随包发布的首页列表。
 *
 * 上游两个注册表加起来十几万条技能，没人从里面挑。首页改成一批**审过的**精选技能，
 * 以 `skills.json` 随应用发布，所以首页**不需要网络**——这是市场 scope 的默认面。
 *
 * 维护方式（与 cc-haha 一致）：
 *  - `curation.json` 是编辑源（选谁、归哪个分类、中文摘要与标签、编辑推荐）——**运行时从不
 *    import 它**，只作为人工同步的依据留在仓库里。
 *  - `skills.json` 是生成产物：上游真正拥有的字段（name、stats、version、icon、安全结论）
 *    由刷新脚本回填，快照不改变选品。
 *
 * 只有**列表**来自快照。详情、文件预览与安装仍然读对应的上游注册表，所以没人会装到快照里的
 * 旧版本。
 *
 * 本文件语义照搬 cc-haha `src/server/services/market/catalog/catalog.ts`。
 */

import data from "./catalog/skills.json";
import {
  skillId,
  type MarketCategory,
  type MarketSource,
  type NormalizedSkill,
  type NormalizedSkillDetail,
  type SecurityStatus,
} from "./types";

export type CatalogEntry = {
  source: MarketSource;
  slug: string;
  /** 上游 owner；clawhub 的 slug 跨 owner 重复，用它消歧。 */
  owner: string;
  /** 上游英文技能名。 */
  name: string;
  /** 面向读者的中文摘要（zh-CN）。 */
  summary: string;
  /** 上游英文摘要，保留给英文读者与搜索。 */
  summaryEn?: string;
  /** 指向 `categories` 的 key。 */
  category: string;
  tags: string[];
  /** 编辑推荐：排前面并在卡片上加标记。 */
  featured?: boolean;
  stats: { downloads: number; installs?: number; stars?: number };
  version?: string;
  updatedAt?: number;
  iconUrl?: string;
  security: SecurityStatus;
  /** 安全结论为何如此（非 clean 时）。 */
  securityNote?: string;
  requiresApiKey?: boolean;
  license?: string;
};

export type CatalogCategoryDef = { key: string; name: string; nameEn: string };

export type CatalogFile = {
  version: 1;
  /** 快照背后那次上游读取的 epoch 毫秒。 */
  generatedAt: number;
  categories: CatalogCategoryDef[];
  skills: CatalogEntry[];
};

const catalog = data as CatalogFile;

/** 整库技能总数（398）；用于「共 N 个精选技能」。 */
export const total: number = catalog.skills.length;

/** 快照生成时间（epoch 毫秒），页面底部「清单更新日期」用它。 */
export const catalogUpdatedAt: number = catalog.generatedAt;

export function getCatalog(): CatalogFile {
  return catalog;
}

const bySkillId = new Map(catalog.skills.map((entry) => [skillId(entry.source, entry.slug), entry]));

export function catalogEntryFor(source: MarketSource, slug: string): CatalogEntry | undefined {
  return bySkillId.get(skillId(source, slug));
}

/** 分类栏条目：按编辑顺序，只保留 count>0 的。 */
export function catalogCategories(): MarketCategory[] {
  const counts = new Map<string, number>();
  for (const entry of catalog.skills) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  return catalog.categories
    .map((category) => ({
      key: category.key,
      name: category.name,
      nameEn: category.nameEn,
      count: counts.get(category.key) ?? 0,
    }))
    .filter((category) => category.count > 0);
}

/** clawhub 上目录钉住的 owner，供 provider 做 slug 消歧。 */
export function catalogClawhubOwners(): Array<readonly [string, string]> {
  return catalog.skills
    .filter((entry) => entry.source === "clawhub")
    .map((entry) => [entry.slug, entry.owner] as const);
}

/** 把一条目录项投影成列表卡片。卡片持有副本，标注安装态时不会改到共享快照。 */
export function catalogEntryToSkill(entry: CatalogEntry): NormalizedSkill {
  return {
    id: skillId(entry.source, entry.slug),
    source: entry.source,
    slug: entry.slug,
    owner: entry.owner,
    name: entry.name,
    summary: entry.summary,
    summaryEn: entry.summaryEn,
    author: { handle: entry.owner },
    stats: { ...entry.stats },
    tags: [...entry.tags],
    category: entry.category,
    version: entry.version,
    updatedAt: entry.updatedAt,
    iconUrl: entry.iconUrl,
    securityStatus: entry.security,
    securityNote: entry.securityNote,
    requiresApiKey: entry.requiresApiKey,
    license: entry.license,
    featured: entry.featured === true ? true : undefined,
    curated: true,
    installState: "installable",
  };
}

/** 折叠大小写与宽度，让 `GitHub`、`github` 与全角输入都能命中。 */
export function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * 把精选快照的编辑性字段叠加到 provider 详情上（详情页与列表 scope=catalog 口径一致）。
 *
 * 背景：详情一直直取上游，快照的 `security`/`securityNote` 会被上游实时结论覆盖，于是
 * 「列表标风险、详情说安全」自相矛盾。这里以**快照为审核口径**：命中目录项时用快照的编辑性
 * 字段覆盖，provider 的实时内容（正文、文件清单、版本、时间、扫描明细）原样保留。
 *
 * clawhub 的 slug 跨 owner 重复：只有 owner 与目录钉住的一致时才是同一条精选技能，
 * 否则（例如另一位作者的同名技能）原样返回，绝不冒用别人的精选结论。
 *
 * 纯函数、无 I/O：由路由在 **TTL 缓存读取之后、返回之前**调用，所以改快照不必等缓存过期。
 */
export function withCatalogMetadata(
  detail: NormalizedSkillDetail,
  requestedOwner?: string,
): NormalizedSkillDetail {
  const entry = catalogEntryFor(detail.source, detail.slug);
  if (!entry) return detail;
  if (detail.source === "clawhub") {
    const owner = requestedOwner || detail.author.handle;
    if (owner && owner !== entry.owner) return detail;
  }
  return {
    ...detail,
    // ── 快照的编辑性字段（审核口径以快照为准，覆盖 provider）──
    securityStatus: entry.security,
    securityNote: entry.securityNote,
    category: entry.category,
    tags: [...entry.tags],
    featured: entry.featured === true ? true : undefined,
    license: entry.license ?? detail.license,
    summary: entry.summary || detail.summary,
    summaryEn: entry.summaryEn ?? detail.summaryEn,
    stats: { ...detail.stats, ...entry.stats },
    requiresApiKey: entry.requiresApiKey ?? detail.requiresApiKey,
    curated: true,
    // ── provider 的实时字段保持不动（上面的展开已带过）──
    // description / descriptionFrontmatter / files / totalSize /
    // changelog / version / pageUrl / iconUrl / updatedAt / securityReports
  };
}

/**
 * 命中每个空白分隔词的目录项，保持目录顺序。
 *
 * name/slug 命中排在 summary/tag/owner 命中之前：输入技能名时应把那个技能顶到最前，
 * 而不是「最常提到它」的那条。`term` 是 `q` 的别名（两种调用点都收）。
 */
export function filterCatalog(params: {
  q?: string;
  /** `q` 的别名，兼容按 term 命名的调用点。 */
  term?: string;
  category?: string;
  source?: "all" | MarketSource;
}): CatalogEntry[] {
  const terms = fold(params.q ?? params.term ?? "").split(/\s+/).filter(Boolean);
  const strong: CatalogEntry[] = [];
  const weak: CatalogEntry[] = [];
  for (const entry of catalog.skills) {
    if (params.category && entry.category !== params.category) continue;
    if (params.source && params.source !== "all" && entry.source !== params.source) continue;
    if (terms.length === 0) {
      strong.push(entry);
      continue;
    }
    const head = fold(`${entry.name} ${entry.slug}`);
    const body = fold(`${entry.summary} ${entry.summaryEn ?? ""} ${entry.tags.join(" ")} ${entry.owner}`);
    if (!terms.every((term) => head.includes(term) || body.includes(term))) continue;
    if (terms.every((term) => head.includes(term))) strong.push(entry);
    else weak.push(entry);
  }
  return [...strong, ...weak];
}
