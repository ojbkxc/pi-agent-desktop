import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * C1 上下文用量环：**环旁必须带百分比文字**。
 *
 * 起因（2026-11-12 用户实报）：环只有一段静止圆弧、没有数字，被读成「加载圆圈卡住」。
 * cc-haha 的同位控件是「环 + 百分比」并排，这里对齐它。
 *
 * 用 SSR 静态标记断言（组件是纯视图，只依赖 props 与 i18n）：
 * - 有 percent → 文字是百分比（41.2 → "41%"，7.5 → "7.5%"）；
 * - percent 为 null（窗口已知但比例未知）→ 不编造数字；
 * - 无 contextUsage → 整个槽位不渲染（空灰环才最像 spinner，组件自己就该不输出）。
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ContextUsageRing } = await jiti.import("./ContextUsageRing.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(ContextUsageRing, props)),
  );
}

test("有百分比：环旁渲染百分比文字（>=10 取整，<10 保留一位）", () => {
  const html = render({ contextUsage: { percent: 41.2, contextWindow: 200_000, tokens: 82_000 } });
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, />41%</, "百分比文字必须真的渲染出来，不能只藏在 tooltip 里");
  assert.match(html, /41\.2% ctx/, "aria-label 仍是精确值 + 单位");
  const small = render({ contextUsage: { percent: 7.55, contextWindow: 200_000, tokens: 15_000 } });
  assert.match(small, />7\.5%</);
});

test("percentage 未知（null）：不编造数字，环仍渲染", () => {
  const html = render({ contextUsage: { percent: null, contextWindow: 200_000, tokens: 82_000 } });
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /\d+%</, "没有比例就不该显示任何百分比文字");
  assert.match(html, /aria-label="— \/ 200k"|aria-label="200k"/);
});

test("没有 contextUsage：整个槽位不渲染（空灰环最像加载动画）", () => {
  assert.equal(render({ contextUsage: null }), "");
  assert.equal(render({}), "");
});