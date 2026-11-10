import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const catalog = await jiti.import("./catalog.ts");
const locale = await jiti.import("./catalog-locale.ts");

const raw = catalog.getCatalog();

function headHit(entry, term) {
  return `${entry.name} ${entry.slug}`.normalize("NFKC").toLowerCase().includes(catalog.fold(term));
}

test("fold：折叠大小写与全角/半角宽度", () => {
  assert.equal(catalog.fold("GitHub"), "github");
  assert.equal(catalog.fold("ＧＩＴ"), "git");
  assert.equal(catalog.fold("  Ａgent  ").trim(), "agent");
  assert.equal(catalog.fold("PDF-Tools"), "pdf-tools");
});

test("快照不变式：版本、生成时间、13 个分类、398 条技能", () => {
  assert.equal(raw.version, 1);
  assert.equal(Number.isInteger(raw.generatedAt), true);
  assert.equal(raw.categories.length, 13);
  assert.equal(new Set(raw.categories.map((category) => category.key)).size, 13);
  for (const category of raw.categories) {
    assert.ok(category.name.length > 0, category.key);
    assert.ok(category.nameEn.length > 0, category.key);
  }
  // 每条都在已知分类、有 owner 与中文摘要。
  const keys = new Set(raw.categories.map((category) => category.key));
  for (const entry of raw.skills) {
    assert.ok(["clawhub", "skillhub"].includes(entry.source), entry.slug);
    assert.ok(keys.has(entry.category), entry.slug);
    assert.ok(entry.owner.length > 0, entry.slug);
    assert.ok(entry.summary.length > 0, entry.slug);
    assert.ok(entry.tags.length > 0, entry.slug);
    assert.equal(typeof entry.stats.downloads, "number", entry.slug);
  }
});

test("total = 技能总数，catalogUpdatedAt = 快照生成时间", () => {
  assert.equal(catalog.total, raw.skills.length);
  assert.equal(catalog.total, 398);
  assert.equal(catalog.catalogUpdatedAt, raw.generatedAt);
  assert.equal(Number.isInteger(catalog.catalogUpdatedAt), true);
});

test("filterCatalog：无词时按目录顺序返回全部", () => {
  const all = catalog.filterCatalog({});
  assert.equal(all.length, catalog.total);
  assert.deepEqual(all.map((entry) => entry.slug), raw.skills.map((entry) => entry.slug));
  // term 是 q 的别名，行为一致。
  assert.deepEqual(catalog.filterCatalog({ term: "" }).length, catalog.total);
});

test("filterCatalog：category / source 过滤", () => {
  const agent = catalog.filterCatalog({ category: "agent" });
  assert.ok(agent.length > 0);
  assert.ok(agent.every((entry) => entry.category === "agent"));

  const skillhub = catalog.filterCatalog({ source: "skillhub" });
  assert.ok(skillhub.length > 0);
  assert.ok(skillhub.every((entry) => entry.source === "skillhub"));

  // source: "all" 与缺省等价。
  assert.equal(catalog.filterCatalog({ source: "all" }).length, catalog.total);

  // category + source 叠加。
  const both = catalog.filterCatalog({ category: "agent", source: "clawhub" });
  assert.ok(both.every((entry) => entry.category === "agent" && entry.source === "clawhub"));
});

test("filterCatalog：name/slug 命中排在 summary/tags/owner 命中之前", () => {
  for (const term of ["planning", "git", "memory", "pdf"]) {
    const results = catalog.filterCatalog({ q: term });
    let seenWeak = false;
    for (const entry of results) {
      if (headHit(entry, term)) {
        assert.equal(seenWeak, false, `术语 ${term}：弱命中之后不能再出现强命中`);
      } else {
        seenWeak = true;
      }
    }
  }
  // 至少一个真实技能名会被命中且排最前。
  const planning = catalog.filterCatalog({ q: "planning" });
  assert.ok(planning.length > 0);
  assert.equal(headHit(planning[0], "planning"), true);
});

test("filterCatalog：多词按 AND，词须同时命中", () => {
  const single = catalog.filterCatalog({ q: "planning" });
  const two = catalog.filterCatalog({ q: "planning files" });
  assert.ok(two.length <= single.length);
  for (const entry of two) {
    const hay = catalog.fold(
      `${entry.name} ${entry.slug} ${entry.summary} ${entry.summaryEn ?? ""} ${entry.tags.join(" ")} ${entry.owner}`,
    );
    assert.ok(hay.includes("planning") && hay.includes("files"), entry.slug);
  }
});

test("catalogCategories：按编辑顺序、count 覆盖整库、只留 count>0", () => {
  const cats = catalog.catalogCategories();
  const expectedKeys = raw.categories
    .map((category) => category.key)
    .filter((key) => raw.skills.some((entry) => entry.category === key));
  assert.deepEqual(cats.map((category) => category.key), expectedKeys);
  assert.ok(cats.every((category) => category.count > 0));
  for (const category of cats) {
    assert.equal(category.count, raw.skills.filter((entry) => entry.category === category.key).length);
    assert.ok(category.name.length > 0 && category.nameEn.length > 0);
  }
});

test("catalogEntryFor：按 source:slug 取回同一条", () => {
  const entry = raw.skills[0];
  assert.equal(catalog.catalogEntryFor(entry.source, entry.slug), entry);
  const other = entry.source === "clawhub" ? "skillhub" : "clawhub";
  assert.equal(catalog.catalogEntryFor(other, `${entry.slug}-nope`), undefined);
});

test("catalogEntryToSkill：投影到卡片且持有副本（不动共享快照）", () => {
  const entry = raw.skills[0];
  const skill = catalog.catalogEntryToSkill(entry);
  assert.equal(skill.id, `${entry.source}:${entry.slug}`);
  assert.equal(skill.owner, entry.owner);
  assert.equal(skill.name, entry.name);
  assert.equal(skill.summary, entry.summary);
  assert.equal(skill.summaryEn, entry.summaryEn);
  assert.equal(skill.category, entry.category);
  assert.equal(skill.securityStatus, entry.security);
  assert.equal(skill.curated, true);
  assert.equal(skill.installState, "installable");
  assert.deepEqual(skill.tags, entry.tags);

  skill.tags.push("__mutated__");
  assert.equal(entry.tags.includes("__mutated__"), false, "卡片必须是快照的副本");
});

test("精选里的 flagged 必须带放行说明；否则不得有 securityNote", () => {
  for (const entry of raw.skills) {
    assert.ok(["verified", "benign", "unknown", "flagged"].includes(entry.security), entry.slug);
    if (entry.security === "flagged") assert.ok((entry.securityNote ?? "").trim().length > 0, entry.slug);
    else assert.equal(entry.securityNote, undefined, entry.slug);
  }
});

/** 造一个 provider 详情假件：编辑性字段都与快照不同，用来证明「只覆盖编辑性字段」。 */
function fakeProviderDetail(overrides = {}) {
  return {
    id: "clawhub:self-improving-agent",
    source: "clawhub",
    slug: "self-improving-agent",
    owner: "pskoett",
    name: "self-improving agent",
    summary: "Upstream English summary",
    author: { handle: "pskoett" },
    stats: { downloads: 1 },
    tags: ["upstream-tag"],
    securityStatus: "benign",
    installState: "installable",
    description: "Body text",
    files: [{ path: "SKILL.md", size: 12 }],
    totalSize: 12,
    version: "4.0.2",
    license: "MIT-0",
    securityReports: [{ vendor: "clawhub-scan", status: "clean", statusText: "Clean" }],
    ...overrides,
  };
}

test("withCatalogMetadata：命中快照的 flagged 技能用快照覆盖编辑性字段", () => {
  const detail = fakeProviderDetail();
  const result = catalog.withCatalogMetadata(detail, "pskoett");

  // 快照的审核口径（上游说是 benign，仍必须是 flagged + 说明）。
  assert.equal(result.securityStatus, "flagged");
  assert.ok(result.securityNote && result.securityNote.trim().length > 0);
  assert.equal(result.curated, true);
  assert.equal(result.category, "agent");
  assert.notEqual(result.summary, detail.summary, "摘要换成快照的编辑文案");
  assert.ok(result.summaryEn && result.summaryEn.length > 0);
  assert.deepEqual(result.tags, raw.skills.find((s) => s.slug === "self-improving-agent").tags);

  // provider 的实时字段必须原样：正文 / 文件清单 / 版本 / 扫描明细。
  assert.equal(result.description, "Body text");
  assert.deepEqual(result.files, detail.files);
  assert.equal(result.version, "4.0.2");
  assert.equal(result.totalSize, 12);
  assert.deepEqual(result.securityReports, detail.securityReports);
});

test("withCatalogMetadata：owner 与目录不一致 → 原样返回 provider 详情", () => {
  const detail = fakeProviderDetail();
  const result = catalog.withCatalogMetadata(detail, "someone-else");
  assert.equal(result.securityStatus, "benign", "别人的同名技能不套用精选结论");
  assert.equal(result.curated, undefined);
  assert.equal(result.summary, detail.summary);
  assert.equal(result.securityNote, undefined);
});

test("withCatalogMetadata：非 catalog 的 slug → 原样返回", () => {
  const detail = fakeProviderDetail({ id: "clawhub:not-curated", slug: "not-curated" });
  const result = catalog.withCatalogMetadata(detail, "pskoett");
  assert.equal(result, detail, "未命中快照时必须是同一个对象，零改动");
});

test("catalog locale：isChineseLocale 认 zh / zh-CN / zh-TW，非中文为 false", () => {
  // 本仓 i18n 的简中 locale 值是 "zh-CN"（cc-haha 才用 "zh"），两者都必须算中文。
  assert.equal(locale.isChineseLocale("zh"), true);
  assert.equal(locale.isChineseLocale("zh-CN"), true);
  assert.equal(locale.isChineseLocale("zh-TW"), true);
  assert.equal(locale.isChineseLocale("zh-Hans"), true);
  assert.equal(locale.isChineseLocale("en"), false);
  assert.equal(locale.isChineseLocale("jp"), false);
  assert.equal(locale.isChineseLocale("kr"), false);
  // 大小写不敏感。
  assert.equal(locale.isChineseLocale("ZH-CN"), true);
  // 其它 zh 开头但不是区域变体的要先归一（"zhx" 不该被当成中文）。
  assert.equal(locale.isChineseLocale("zhx"), false);
});

test("catalog locale：中文读者看 zh 文案，其他语言看英文并隐藏精选标签", () => {
  const skill = { summary: "用文件跟踪任务", summaryEn: "Track tasks" };
  assert.equal(locale.skillSummary(skill, "zh"), "用文件跟踪任务");
  assert.equal(locale.skillSummary(skill, "zh-CN"), "用文件跟踪任务");
  assert.equal(locale.skillSummary(skill, "zh-TW"), "用文件跟踪任务");
  assert.equal(locale.skillSummary(skill, "en"), "Track tasks");
  // 没有英文时回退中文，别给空卡片。
  assert.equal(locale.skillSummary({ summary: "只有中文" }, "jp"), "只有中文");

  assert.deepEqual(locale.visibleTags({ tags: ["任务规划"], curated: true }, "zh-CN"), ["任务规划"]);
  assert.deepEqual(locale.visibleTags({ tags: ["任务规划"], curated: true }, "en"), []);
  // 上游 live 标签（非 curated）在任何语言都保留。
  assert.deepEqual(locale.visibleTags({ tags: ["git"], curated: false }, "en"), ["git"]);

  const cats = [{ key: "dev", name: "开发编程", nameEn: "Development", count: 40 }];
  assert.equal(locale.categoryLabel(cats[0], "zh-CN"), "开发编程");
  assert.equal(locale.categoryLabel(cats[0], "en"), "Development");
  assert.equal(locale.categoryLabel({ name: "开发编程", nameEn: "" }, "en"), "开发编程");

  assert.equal(locale.resolveCategory({ category: "dev", curated: true }, cats, "zh-CN"), "开发编程");
  assert.equal(locale.resolveCategory({ category: "dev", curated: true }, cats, "en"), "Development");
  assert.equal(locale.resolveCategory({ category: "unknown-key", curated: true }, cats, "zh"), undefined);
  assert.equal(locale.resolveCategory({ category: "AI 工具", curated: false }, cats, "en"), "AI 工具");
  assert.equal(locale.resolveCategory({ curated: true }, cats, "zh"), undefined);
});
