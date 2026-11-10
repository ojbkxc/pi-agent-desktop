/**
 * 精选目录的中英文案选择（照搬 cc-haha `desktop/src/components/market/catalogLocale.ts`）。
 *
 * 目录是**用简体中文编辑**的：摘要、标签、分类名都是中文。中文读者（zh、zh-CN、zh-TW 等 zh 变体）
 * 看这些；其他语言看上游英文摘要与分类英文名，并且**不显示标签**——英文摘要下一排中文 chips 读起来是
 * 噪声而不是元数据。live（非精选）结果带的是上游自己的文案，任何语言都原样显示。
 *
 * 这个文件**不 import 快照 JSON**（`skills.json` 约 355KB），所以 UI 组件可以安全地把它打进
 * 客户端 bundle；需要数据的地方再去 `catalog.ts`。
 */

import type { MarketCategory, NormalizedSkill } from "./types";

/** 本仓没有独立的 Locale 联合类型，用宽松的 string，比较按字面量。 */
export type MarketLocale = string;

/**
 * 中文读者（zh、zh-CN、zh-TW、zh-Hans… 任意 zh 变体）都为 true。
 *
 * cc-haha 用 `"zh"`，而本仓 i18n 的简中 locale 值是 `"zh-CN"`：两边都要认，
 * 否则本仓调用点会把简中判成非中文、错走英文分支（摘要显示 summaryEn、tags 被隐藏）。
 * 用 `zh-` 前缀匹配，`zh-TW` 自然仍算中文。
 */
export function isChineseLocale(locale: MarketLocale): boolean {
  const base = String(locale).toLowerCase();
  return base === "zh" || base.startsWith("zh-");
}

/** 中文读者看编辑过的 zh 摘要，其他语言看上游英文摘要；英文缺失时回退中文，别给空卡片。 */
export function skillSummary(
  skill: Pick<NormalizedSkill, "summary" | "summaryEn">,
  locale: MarketLocale,
): string {
  if (isChineseLocale(locale)) return skill.summary;
  return skill.summaryEn || skill.summary;
}

/**
 * 非中文语言下隐藏**精选**（中文）标签；上游 live 结果的标签原样保留。
 * 本仓的 NormalizedSkill 用 `curated` 标记精选来源（缺省视为上游，保留标签）。
 */
export function visibleTags(
  skill: Pick<NormalizedSkill, "tags" | "curated">,
  locale: MarketLocale,
): string[] {
  if (skill.curated && !isChineseLocale(locale)) return [];
  return skill.tags;
}

/** 分类名按语言取；英文缺失时回退中文名。 */
export function categoryLabel(
  category: Pick<MarketCategory, "name" | "nameEn">,
  locale: MarketLocale,
): string {
  if (isChineseLocale(locale)) return category.name;
  return category.nameEn || category.name;
}

/**
 * 技能分类的显示名。精选技能上 `category` 是目录 key，用分类表解析；
 * 其他情况是上游原始字符串，原样显示。未知 key 解析为 undefined，不泄露 key 本身。
 */
export function resolveCategory(
  skill: Pick<NormalizedSkill, "category" | "curated">,
  categories: readonly MarketCategory[],
  locale: MarketLocale,
): string | undefined {
  if (!skill.category) return undefined;
  if (!skill.curated) return skill.category;
  const match = categories.find((category) => category.key === skill.category);
  return match ? categoryLabel(match, locale) : undefined;
}
