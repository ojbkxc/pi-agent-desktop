import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 界面默认语言政策：简体中文（用户是简体中文用户，要求开箱即中文）。
 * 浏览器语言仍不读取（顶栏语言切换器已移除），localStorage 里用户显式
 * 选择过的语言优先（见 hooks/useI18n.tsx 的 readInitialLocale）。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider, useI18n } = await jiti.import("@/hooks/useI18n");

function LocaleProbe() {
  const { locale } = useI18n();
  return React.createElement("span", { "data-locale": locale });
}

test("the UI defaults to Simplified Chinese with no stored preference", () => {
  // renderToStaticMarkup 不跑 useEffect（window 下 getPref 也只会得到 null），
  // 渲染出的 locale 即 defaultLocale 本身。
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(LocaleProbe)));
  assert.match(html, /data-locale="zh-CN"/);
});

test("a consumer can still pin the provider to another locale pack", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(LocaleProbe)),
  );
  assert.match(html, /data-locale="en"/);
});

test("the source keeps the zh-CN default and never consults the browser language", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const source = await readFile(fileURLToPath(new URL("./useI18n.tsx", import.meta.url)), "utf8");
  assert.match(source, /const defaultLocale: Locale = "zh-CN"/);
  // resolveBrowserLocale 存在于 registry（有独立测试），但 useI18n 不得引用它。
  assert.doesNotMatch(source, /resolveBrowserLocale/);
});
