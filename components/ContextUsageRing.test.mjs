import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * C1 上下文用量环 + 用量弹出框。
 *
 * 环旁必须带百分比文字（用户实报：纯弧线被读成「加载圆圈卡住」，对齐 cc-haha 的环+百分比）；
 * 点击环打开的是**上下文用量面板**（不再是直接跳到会话统计），面板里给出：
 * 百分比、进度条、tokens、本会话真实解析出的自动压缩触发点，以及「立即压缩」。
 *
 * 用 SSR 静态标记断言（组件是纯视图，只依赖 props 与 i18n）。弹出内容需要点击才渲染，
 * 所以行为断言由下面的源码结构断言与 e2e/option-controls 覆盖；这里钉的是不可变契约：
 * 环本身、以及「点击不再直接 openSessionStats」。
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ContextUsageRing } = await jiti.import("./ContextUsageRing.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const ringSource = (await jiti.import("node:fs")).readFileSync("components/ContextUsageRing.tsx", "utf8");

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

test("点击环打开用量面板，而不是直接跳会话统计", () => {
  // 关闭态渲染里不应出现面板标题，说明面板只在点击后挂载。
  const closed = render({ contextUsage: { percent: 43, contextWindow: 1_050_000, tokens: 447_110 }, onOpenStats: () => {} });
  assert.doesNotMatch(closed, /Auto-compacts at/, "面板内容默认不渲染");
  assert.doesNotMatch(closed, /Compact now/);

  // 触发按钮只切 open；onOpenStats 只能从面板里的那一行调用。
  assert.match(ringSource, /onClick=\{\(\) => setOpen\(\(value\) => !value\)\}/, "环按钮只负责开合面板");
  assert.doesNotMatch(ringSource, /if \(hasUsage\) onOpenStats\?\.\(\)/, "点击不得再直接打开统计面板");
  assert.match(ringSource, /setOpen\(false\);\s*\n\s*onOpenStats\(\);/, "统计入口保留在面板内");
});

test("面板引用本会话解析出的触发点，不写死比例", () => {
  // 阈值来自服务端 get_state（policy wrapper 解析结果），面板只负责展示。
  assert.match(ringSource, /compactionLimits\?\.trigger/, "触发点必须取自会话解析值");
  assert.match(ringSource, /triggerPercent = trigger !== null && windowSize > 0/);
  assert.doesNotMatch(ringSource, /0\.5\s*\*\s*windowSize|windowSize\s*\*\s*0\.5/, "不得在客户端重算档位比例");
  assert.match(ringSource, /ctx-usage-bar-mark/, "进度条上标出触发点位置");
});

test("面板支持手动压缩与压缩中停止", () => {
  assert.match(ringSource, /chat\.ctxCompactNow/);
  assert.match(ringSource, /onCompact/);
  assert.match(ringSource, /stopCompaction/);
  assert.match(ringSource, /canCompactNow = Boolean\(onCompact && !isCompacting\)/);
});

test("Esc 关闭面板并接管事件，不冒泡去停掉运行中的 agent", () => {
  assert.match(ringSource, /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);\s*\n\s*setOpen\(false\)/);
});