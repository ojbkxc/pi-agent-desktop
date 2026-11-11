import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SkillMarketCard } = await jiti.import("./SkillMarketCard.tsx");
const {
  MarketSecurityTab,
  CapabilityPanel,
  MarketChangelogTab,
  detailTabKeys,
} = await jiti.import("./SkillMarketDetail.tsx");
const { MarketSidebarRow } = await jiti.import("./MarketSidebarRow.tsx");
const {
  MarketFilterBar,
  MarketCategoryBar,
  MarketResultSummary,
  MarketSkeleton,
  MarketLoadMore,
  MarketDisclaimer,
  MarketSourceStatusBar,
} = await jiti.import("./SkillMarketView.tsx");
const helpers = await jiti.import("./market-helpers.ts");
const insights = await jiti.import("./skill-insights.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const renderWith = (locale, element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: locale }, element),
);
const render = (element) => renderWith("en", element);
// React 会把文本里的 < > & " ' 转义成 HTML 实体,断言前先解码回字面量。
const text = (html) => html.replace(/<[^>]*>/g, "")
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

const item = {
  id: "clawhub:demo",
  source: "clawhub",
  slug: "demo",
  owner: "someone",
  name: "Demo Skill",
  summary: "A demo skill for tests.",
  author: { handle: "someone" },
  stats: { downloads: 491656 },
  tags: ["pdf"],
  version: "4.0.5",
  securityStatus: "benign",
  installState: "installable",
};

test("卡片：名字 / 摘要 / 来源 / 下载量 / 版本 / 安全结论", () => {
  const html = render(React.createElement(SkillMarketCard, {
    item, installed: false, active: false, onOpen: () => {},
  }));
  const body = text(html);
  assert.ok(body.includes("Demo Skill"));
  assert.ok(body.includes("A demo skill for tests."));
  assert.ok(body.includes("ClawHub"), "来源标签");
  assert.ok(body.includes("491.7K"), "下载量按紧凑写法");
  assert.ok(body.includes("v4.0.5"));
  assert.ok(body.includes("No issues found"), "benign 的安全文案");
  assert.ok(!body.includes("market."), "不能把 i18n 键原文渲染出来");
  assert.ok(!body.includes("Installed"), "未安装时不出已安装标记");
});

test("卡片：已安装标记与选中态", () => {
  const installed = render(React.createElement(SkillMarketCard, {
    item: { ...item, installState: "installed" }, installed: true, active: true, onOpen: () => {},
  }));
  assert.ok(text(installed).includes("Installed"));
  assert.ok(installed.includes('aria-current="true"'), "选中态");
  assert.ok(installed.includes("is-active"));
});

test("卡片：没有摘要与图标时给兜底文案与首字母块", () => {
  const html = render(React.createElement(SkillMarketCard, {
    item: { ...item, summary: "", iconUrl: undefined, securityStatus: "unknown" },
    installed: false, active: false, onOpen: () => {},
  }));
  assert.ok(text(html).includes("No description provided."));
  assert.ok(html.includes("is-fallback"), "无图标时的首字母块");
  assert.ok(text(html).includes("Not scanned"));
});

test("侧栏行：标题取 i18n 且激活态带 aria-current", () => {
  const html = render(React.createElement(MarketSidebarRow, { active: true, onOpen: () => {} }));
  assert.ok(text(html).includes("Market"));
  assert.ok(html.includes('aria-current="page"'));
  const idle = render(React.createElement(MarketSidebarRow, { active: false, onOpen: () => {} }));
  assert.ok(!idle.includes('aria-current="page"'));
});

test("工具函数：下载量 / 字节数 / 徽标色调 / 文件排序", () => {
  assert.equal(helpers.formatDownloads(0), "0");
  assert.equal(helpers.formatDownloads(999), "999");
  assert.equal(helpers.formatDownloads(1500), "1.5K");
  assert.equal(helpers.formatDownloads(1_000_000), "1M");
  assert.equal(helpers.formatDownloads(2_500_000), "2.5M");

  assert.equal(helpers.formatBytes(0), "0 B");
  assert.equal(helpers.formatBytes(512), "512 B");
  assert.equal(helpers.formatBytes(2048), "2 KB");
  assert.equal(helpers.formatBytes(5 * 1024 * 1024), "5.0 MB");

  assert.equal(helpers.securityBadgeClass("verified"), "is-safe");
  assert.equal(helpers.securityBadgeClass("benign"), "is-safe");
  assert.equal(helpers.securityBadgeClass("flagged"), "is-flagged");
  assert.equal(helpers.securityBadgeClass("unknown"), "is-unknown");
  assert.equal(helpers.securityBadgeClass(undefined), "is-unknown");

  const sorted = helpers.sortMarketFiles([
    { path: "z.md" }, { path: "SKILL.md" }, { path: "a/b.md" },
  ]);
  assert.deepEqual(sorted.map((file) => file.path), ["SKILL.md", "a/b.md", "z.md"]);
});

test("工具函数：紧凑计数 / ISO 日期 / 筛选 i18n 键映射 / 页大小", () => {
  assert.equal(helpers.formatCount(0), "0");
  assert.equal(helpers.formatCount(999), "999");
  assert.equal(helpers.formatCount(1500), "1.5k");
  assert.equal(helpers.formatCount(482069), "482.1k");
  assert.equal(helpers.formatCount(1_000_000), "1.0M");
  assert.equal(helpers.formatCount(2_500_000), "2.5M");

  assert.equal(helpers.formatIsoDate(undefined), "");
  assert.equal(helpers.formatIsoDate(Number.NaN), "");
  assert.equal(helpers.formatIsoDate(Date.UTC(2026, 0, 5)), "2026-01-05");

  assert.equal(helpers.sourceFilterLabelKey("all"), "market.source.all");
  assert.equal(helpers.sourceFilterLabelKey("clawhub"), "market.source.clawhub");
  assert.equal(helpers.securityFilterLabelKey("all"), "market.security.all");
  assert.equal(helpers.securityFilterLabelKey("flagged"), "market.security.flagged");
  assert.equal(helpers.installedFilterLabelKey("all"), "market.installedFilter.all");
  assert.equal(helpers.installedFilterLabelKey("installable"), "market.installedFilter.installable");

  assert.equal(helpers.securityHintKey("benign"), "market.securityHint.benign");
  assert.equal(helpers.securityHintKey(undefined), "market.securityHint.unknown");
  assert.equal(helpers.MARKET_PAGE_SIZE, 24);
});

test("工具函数：语言选择（zh-CN 归一化）与标签可见性", () => {
  assert.equal(helpers.isChineseLocale("zh-CN"), true);
  assert.equal(helpers.isChineseLocale("zh-TW"), true);
  assert.equal(helpers.isChineseLocale("en"), false);

  assert.equal(helpers.skillSummary({ summary: "中", summaryEn: "EN" }, "en"), "EN");
  assert.equal(helpers.skillSummary({ summary: "中", summaryEn: "EN" }, "zh-CN"), "中");
  assert.equal(helpers.skillSummary({ summary: "中" }, "en"), "中");

  assert.equal(helpers.categoryLabel({ name: "文档", nameEn: "Documents" }, "en"), "Documents");
  assert.equal(helpers.categoryLabel({ name: "文档", nameEn: "Documents" }, "zh-CN"), "文档");

  assert.deepEqual(helpers.visibleTags({ tags: ["x"], curated: true }, "en"), []);
  assert.deepEqual(helpers.visibleTags({ tags: ["x"], curated: true }, "zh-CN"), ["x"]);
  assert.deepEqual(helpers.visibleTags({ tags: ["x"], curated: true }, "zh-TW"), ["x"]);
  assert.deepEqual(helpers.visibleTags({ tags: ["x"], curated: false }, "en"), ["x"]);
  assert.deepEqual(helpers.visibleTags({ tags: ["x"] }, "en"), ["x"]);
});

test("卡片：标签按 visibleTags 规则展示与折叠", () => {
  const shown = render(React.createElement(SkillMarketCard, {
    item: { ...item, tags: ["a", "b", "c", "d"], curated: false },
    installed: false, active: false, onOpen: () => {},
  }));
  const shownBody = text(shown);
  assert.ok(shown.includes('data-testid="market-card-tags"'));
  assert.ok(shownBody.includes("a") && shownBody.includes("b") && shownBody.includes("c"));
  assert.ok(shownBody.includes("+1"), "超出的标签折叠为 +N");
  assert.ok(!shownBody.includes("market."), "不得渲染裸 i18n 键");

  const hidden = render(React.createElement(SkillMarketCard, {
    item: { ...item, tags: ["中文标签"], curated: true },
    installed: false, active: false, onOpen: () => {},
  }));
  assert.ok(!hidden.includes('data-testid="market-card-tags"'), "精选 + 非中文语不显示标签");

  const zhShown = renderWith("zh-CN", React.createElement(SkillMarketCard, {
    item: { ...item, tags: ["中文标签"], curated: true },
    installed: false, active: false, onOpen: () => {},
  }));
  assert.ok(text(zhShown).includes("中文标签"), "中文语言显示精选标签");
});

test("筛选栏：三筛选渲染默认文案，不泄漏 i18n 键", () => {
  const html = render(React.createElement(MarketFilterBar, {
    source: "all", security: "all", installed: "all",
    onSourceChange: () => {}, onSecurityChange: () => {}, onInstalledChange: () => {},
  }));
  const body = text(html);
  assert.ok(html.includes('data-testid="market-filter-bar"'));
  assert.ok(body.includes("All sources"), "来源筛选默认文案");
  assert.ok(body.includes("All security states"), "安全筛选默认文案");
  assert.ok(body.includes("All skills"), "安装筛选默认文案");
  assert.ok(!body.includes("market."), "不得渲染裸 i18n 键");
});

test("筛选栏：非默认选中把枚举映射到各语言文案", () => {
  const html = render(React.createElement(MarketFilterBar, {
    source: "clawhub", security: "flagged", installed: "installable",
    onSourceChange: () => {}, onSecurityChange: () => {}, onInstalledChange: () => {},
  }));
  const body = text(html);
  assert.ok(body.includes("ClawHub"));
  assert.ok(body.includes("Flagged"));
  assert.ok(body.includes("Not installed"));
  assert.ok(!body.includes("market."));
});

test("分类栏：全部 + 分类名（按语言取 name/nameEn）+ 计数；空分类不渲染", () => {
  const categories = [
    { key: "docs", name: "文档", nameEn: "Documents", count: 12 },
    { key: "data", name: "数据", nameEn: "Data", count: 3 },
  ];
  const en = render(React.createElement(MarketCategoryBar, { categories, value: "docs", onChange: () => {} }));
  const enBody = text(en);
  assert.ok(en.includes('data-testid="market-category-bar"'));
  assert.ok(enBody.includes("All"), "全部 chip");
  assert.ok(enBody.includes("Documents"), "英文语言用 nameEn");
  assert.ok(enBody.includes("12") && enBody.includes("3"), "分类计数");
  assert.ok(en.includes("is-active"), "选中分类高亮");
  assert.ok(!enBody.includes("文档"), "英文语言不显示简中名");
  assert.ok(!enBody.includes("market."), "不得渲染裸 i18n 键");

  const zh = renderWith("zh-CN", React.createElement(MarketCategoryBar, { categories, value: "all", onChange: () => {} }));
  assert.ok(text(zh).includes("文档"), "中文语言用 name");

  const empty = render(React.createElement(MarketCategoryBar, { categories: [], value: "all", onChange: () => {} }));
  assert.equal(empty, "");
});

test("计数行：catalog 读精选计数与更新日期，live 读实时结果数", () => {
  const catalog = render(React.createElement(MarketResultSummary, {
    scope: "catalog", total: 42, loadedCount: 24, catalogUpdatedAt: Date.UTC(2026, 0, 5),
  }));
  const catalogBody = text(catalog);
  assert.ok(catalogBody.includes("42 curated skills"), "精选总数文案");
  assert.ok(catalogBody.includes("Catalog updated 2026-01-05"), "清单更新日期");

  const fallback = render(React.createElement(MarketResultSummary, {
    scope: "catalog", total: null, loadedCount: 5,
  }));
  assert.ok(text(fallback).includes("5 skills"), "无总数时回退已加载条数");

  const live = render(React.createElement(MarketResultSummary, {
    scope: "live", total: null, loadedCount: 7,
  }));
  const liveBody = text(live);
  assert.ok(liveBody.includes("7 live results"), "实时结果数");
  assert.ok(liveBody.includes("Not curated"), "live 的未精选标记");
  assert.ok(!liveBody.includes("market."));
});

test("骨架：加载态给形状卡片而不是一行文字", () => {
  const html = render(React.createElement(MarketSkeleton, { label: "Loading skills…" }));
  assert.ok(html.includes('data-testid="market-skeleton"'));
  assert.equal((html.match(/is-skeleton/g) || []).length, 8, "默认 8 张骨架卡");
  assert.ok(html.includes("market-skeleton-line"));
  assert.ok(text(html).includes("Loading skills…"), "骨架带无障碍加载文案");
});

test("免责声明：首屏渲染标题与正文且不泄漏 i18n 键", () => {
  const html = render(React.createElement(MarketDisclaimer));
  const body = text(html);
  assert.ok(html.includes('data-testid="market-disclaimer"'));
  assert.ok(body.includes("Third-party skills"), "免责声明标题");
  assert.ok(body.includes("does not audit"), "免责声明正文");
  assert.ok(!body.includes("market."), "不得渲染裸 i18n 键");
});

test("详情安全页签：有 securityNote 时展示「精选说明」，浏览路径可消费快照回填字段", () => {
  // O1：catalog 详情命中快照时服务端回填 securityNote；详情消费侧必须把它渲染出来。
  const html = render(React.createElement(MarketSecurityTab, {
    securityNote: "该技能读取剪贴板，已由编辑复核。",
    reports: [{ vendor: "ClawHub", status: "flagged", statusText: "Flagged by scanner" }],
  }));
  const body = text(html);
  assert.ok(html.includes('data-testid="market-security-note"'));
  assert.ok(body.includes("Editor's note"), "精选说明标题");
  assert.ok(body.includes("该技能读取剪贴板，已由编辑复核。"), "精选说明正文");
  assert.ok(body.includes("Flagged by scanner"), "扫描报告仍在");
  assert.ok(!body.includes("market."), "不得渲染裸 i18n 键");

  const withoutNote = render(React.createElement(MarketSecurityTab, { reports: [] }));
  assert.ok(!withoutNote.includes('data-testid="market-security-note"'), "无 securityNote 时不渲染区块");
  assert.ok(text(withoutNote).includes("No security scan reported"), "无报告时的兜底文案");
});

test("详情镜像类型：securityNote/curated/featured/license/summaryEn 均在 MarketListItem 上", () => {
  // 类型层面（tsc）已保证；这里以运行期样例确认消费侧字段名与契约一致，防拼写漂移。
  const sample = {
    ...item,
    curated: true,
    featured: true,
    summaryEn: "EN summary",
    license: "MIT",
    securityNote: "编辑说明",
  };
  const html = render(React.createElement(SkillMarketCard, { item: sample, installed: false, active: false, onOpen: () => {} }));
  assert.ok(text(html).includes("Featured"), "featured 驱动精选徽标");
  assert.ok(text(html).includes("EN summary"), "summaryEn 供非中文语言取摘要");
});

test("无限滚动：哨兵始终存在，无 observer 回退按钮，失败停自动加载", () => {
  const sentinel = { current: null };

  const noObserver = render(React.createElement(MarketLoadMore, {
    canAutoLoad: false, loadingMore: false, loadMoreError: null, onLoadMore: () => {}, sentinelRef: sentinel,
  }));
  assert.ok(noObserver.includes('data-testid="market-load-more-sentinel"'), "哨兵存在");
  assert.ok(text(noObserver).includes("Load more"), "无 observer 时的回退按钮");

  const withObserver = render(React.createElement(MarketLoadMore, {
    canAutoLoad: true, loadingMore: false, loadMoreError: null, onLoadMore: () => {}, sentinelRef: sentinel,
  }));
  assert.ok(withObserver.includes('data-testid="market-load-more-sentinel"'));
  assert.ok(!text(withObserver).includes("Load more"), "有 observer 时不显示回退按钮");

  const failed = render(React.createElement(MarketLoadMore, {
    canAutoLoad: true, loadingMore: false, loadMoreError: "boom", onLoadMore: () => {}, sentinelRef: sentinel,
  }));
  const failedBody = text(failed);
  assert.ok(failedBody.includes("Couldn't load more skills"), "翻页失败文案");
  assert.ok(failedBody.includes("boom"), "展示失败详情");
  assert.ok(failedBody.includes("Load more"), "失败时给手动重试");
});

/* ── 来源状态条（任务 1） ─────────────────────────────────────────────── */

test("来源状态条：有记录的来源各一个 chip，状态文案正确", () => {
  const html = render(React.createElement(MarketSourceStatusBar, {
    sources: {
      clawhub: { status: "ok", at: Date.UTC(2026, 0, 5, 3, 4, 5) },
      skillhub: { status: "failed", message: "HTTP 503" },
    },
  }));
  assert.ok(html.includes('data-testid="market-source-status"'));
  assert.ok(html.includes('data-testid="market-source-status-clawhub"'));
  assert.ok(html.includes('data-testid="market-source-status-skillhub"'));
  const body = text(html);
  assert.ok(body.includes("ClawHub") && body.includes("Online"), "ok 源显示正常");
  assert.ok(body.includes("SkillHub") && body.includes("Unavailable"), "failed 源显示不可用");
  assert.ok(html.includes('title="HTTP 503"'), "失败详情进 title");
  assert.ok(!body.includes("market."), "不得渲染裸 i18n 键");
});

test("来源状态条：降级 / 缓存（含时间）文案", () => {
  const degraded = render(React.createElement(MarketSourceStatusBar, {
    sources: { clawhub: { status: "degraded" } },
  }));
  assert.ok(text(degraded).includes("Degraded"), "degraded 文案");

  const cached = render(React.createElement(MarketSourceStatusBar, {
    sources: { skillhub: { status: "cached", at: Date.UTC(2026, 0, 5, 3, 4, 5) } },
  }));
  const cachedBody = text(cached);
  assert.ok(cachedBody.includes("Cached"), "缓存状态带时间前缀");
  assert.equal((cachedBody.match(/Cached/g) || []).length, 1, "缓存文案只出现一次");
});

test("来源状态条：无记录的来源不渲染，整条为空时不渲染", () => {
  const one = render(React.createElement(MarketSourceStatusBar, {
    sources: { skillhub: { status: "ok" } },
  }));
  assert.ok(one.includes('data-testid="market-source-status-skillhub"'));
  assert.ok(!one.includes('data-testid="market-source-status-clawhub"'), "无记录来源不渲染 chip");

  assert.equal(render(React.createElement(MarketSourceStatusBar, { sources: {} })), "");
  assert.equal(render(React.createElement(MarketSourceStatusBar, { sources: { clawhub: undefined } })), "");
});

/* ── 更新日志页签（任务 2） ───────────────────────────────────────────── */

test("更新日志：有 changelog 才多出页签，无则只有三页签", () => {
  assert.deepEqual(detailTabKeys(true), ["overview", "files", "security", "changelog"]);
  assert.deepEqual(detailTabKeys(false), ["overview", "files", "security"]);
});

test("更新日志页签：版本 / 日期 / 正文正确", () => {
  const html = render(React.createElement(MarketChangelogTab, {
    changelog: { version: "1.2.0", text: "Fixed a thing.", publishedAt: Date.UTC(2026, 0, 5) },
  }));
  assert.ok(html.includes('data-testid="market-changelog-tab"'));
  const body = text(html);
  assert.ok(body.includes("v1.2.0"), "版本加 v 前缀");
  assert.ok(body.includes("2026-01-05"), "发布日期");
  assert.ok(body.includes("Fixed a thing."), "更新说明正文");
  assert.ok(!body.includes("market."), "不得渲染裸 i18n 键");
});

test("更新日志页签：无自述版本时用技能版本兜底；缺 changelog 时给兜底文案", () => {
  const fallback = render(React.createElement(MarketChangelogTab, {
    changelog: { text: "No version here." }, version: "2.0.0",
  }));
  assert.ok(text(fallback).includes("v2.0.0"), "无自述版本用技能版本兜底");

  const empty = render(React.createElement(MarketChangelogTab, {}));
  assert.ok(!empty.includes('data-testid="market-changelog-tab"'), "缺 changelog 不出正文块");
  assert.ok(text(empty).includes("Upstream has no release note"), "缺 changelog 的兜底文案");
});

/* ── 能力面板（任务 3） ───────────────────────────────────────────────── */

const fence = "```";
const CAP_MD = [
  "# Demo",
  "Set DEMO_API_TOKEN before running.",
  "",
  `${fence}bash`,
  "mkdir -p ./out",
  "curl https://api.acme-tools.dev/v1/report",
  fence,
  "",
  "Use when (1) you need a report, (2) the data is ready.",
].join("\n");
const CAP_INPUT = {
  markdown: CAP_MD,
  frontmatter: { metadata: { requires: { bins: ["jq"], env: ["DEMO_API_TOKEN"] } } },
  files: [{ path: "scripts/setup.sh" }],
};

test("能力识别：规则命中出对应几类，级别与证据正确", () => {
  const caps = insights.detectCapabilities(CAP_INPUT);
  assert.deepEqual(
    caps.map((capability) => capability.kind),
    ["shell", "secrets", "network", "writes", "binaries"],
    "命中类别按固定顺序",
  );
  const shell = caps.find((capability) => capability.kind === "shell");
  assert.equal(shell.level, "high", "shell 为 high");
  assert.ok(shell.evidence.includes("scripts/setup.sh"), "脚本文件进证据");
  assert.deepEqual(caps.find((capability) => capability.kind === "network").evidence, ["api.acme-tools.dev"]);
  assert.ok(caps.find((capability) => capability.kind === "secrets").evidence.includes("DEMO_API_TOKEN"));
  assert.deepEqual(caps.find((capability) => capability.kind === "binaries").evidence, ["jq"]);
});

test("能力识别：无规则命中时返回空（面板不许给出「没有风险」的结论）", () => {
  const caps = insights.detectCapabilities({ markdown: "Just a plain description.", files: [{ path: "README.md" }] });
  assert.deepEqual(caps, []);
});

test("能力面板：有命中时渲染标题 / 证据 / 级别 / 免责说明", () => {
  const caps = insights.detectCapabilities(CAP_INPUT);
  const html = render(React.createElement(CapabilityPanel, { capabilities: caps }));
  assert.ok(html.includes('data-testid="market-capability-panel"'));
  assert.ok(html.includes('data-testid="market-capability-shell"'));
  const body = text(html);
  assert.ok(body.includes("Before installing"), "面板标题");
  assert.ok(body.includes("scripts/setup.sh"), "证据来源进正文");
  assert.ok(body.includes("High"), "shell 级别徽标");
  assert.ok(body.includes("Detected by rules"), "底部免责说明");
  assert.ok(!body.includes("market."), "不得渲染裸 i18n 键");
});

test("能力面板：无命中时整块不渲染", () => {
  assert.equal(render(React.createElement(CapabilityPanel, { capabilities: [] })), "");
});
