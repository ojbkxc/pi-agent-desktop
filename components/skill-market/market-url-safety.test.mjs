import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 市场详情外链的协议白名单（`reportUrl` / `pageUrl`）。
 *
 * 这些 URL 来自第三方源（registry 的扫描报告、作者主页），不可信：`javascript:` /
 * `data:` 之类进 `href` 会在点击时执行，所以只放行 http/https（修复安全建议 3 的回归锚点）。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { MarketSecurityTab } = await jiti.import("./SkillMarketDetail.tsx");
const { safeMarketUrl } = await jiti.import("./market-helpers.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);

test("详情安全页签：reportUrl 走协议白名单，非 http(s) 不渲染链接", () => {
  const renderTab = (reportUrl) => render(React.createElement(MarketSecurityTab, {
    reports: [{ vendor: "ClawHub", status: "flagged", statusText: "Flagged by scanner", reportUrl }],
  }));

  const safe = renderTab("https://www.virustotal.com/gui/report/abc");
  assert.ok(safe.includes('href="https://www.virustotal.com/gui/report/abc"'), "http(s) 链接渲染");

  // 白名单外一律不渲染链接（报告本身还在）。
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "  ", "not a url"]) {
    const html = renderTab(bad);
    assert.ok(!html.includes("<a "), `坏协议 ${JSON.stringify(bad)} 不渲染链接`);
    assert.ok(html.includes("Flagged by scanner"), "报告本身仍在");
  }

  // 缺 reportUrl 不渲染链接。
  const missing = render(React.createElement(MarketSecurityTab, {
    reports: [{ vendor: "ClawHub", status: "flagged", statusText: "Flagged by scanner" }],
  }));
  assert.ok(!missing.includes("<a "), "缺 reportUrl 不渲染链接");
});

test("safeMarketUrl：协议白名单与解析", () => {
  assert.equal(safeMarketUrl("http://a.example/x"), "http://a.example/x");
  assert.equal(safeMarketUrl("https://a.example"), "https://a.example/");
  assert.equal(safeMarketUrl("HTTP://A.EXAMPLE"), "http://a.example/");
  assert.equal(safeMarketUrl("javascript:alert(1)"), null);
  assert.equal(safeMarketUrl("data:text/html,x"), null);
  assert.equal(safeMarketUrl("ftp://a.example"), null);
  assert.equal(safeMarketUrl("not a url"), null);
  assert.equal(safeMarketUrl(""), null);
  assert.equal(safeMarketUrl(undefined), null);
});
