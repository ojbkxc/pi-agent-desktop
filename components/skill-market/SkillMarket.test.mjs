import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SkillMarketCard } = await jiti.import("./SkillMarketCard.tsx");
const { MarketSidebarRow } = await jiti.import("./MarketSidebarRow.tsx");
const helpers = await jiti.import("./market-helpers.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);
const text = (html) => html.replace(/<[^>]*>/g, "");

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