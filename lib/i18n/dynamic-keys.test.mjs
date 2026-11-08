import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 动态拼键守卫（#35）。
 *
 * lib/i18n/usage.test.mjs 的静态调用点门禁只看字符串字面量键；registry.test.mjs
 * 只断言三语键集合一致（三语同删不红）。于是 FileViewer 的模板拼键
 * t(`i18n.${mode}`) 这类消费方正真依赖的动态键，两道门禁都看不见——哪天键被删，
 * UI 会把键名本身渲染出来且没有任何测试红。这里把消费方依赖的动态键逐个钉住：
 * 任一 locale 缺键或译成空串，本测试红。
 */

const jiti = createJiti(import.meta.url);
const { getLocalePlugin, getSupportedLocales } = await jiti.import("./registry.ts");

// FileViewer.tsx 视图模式按钮：t(`i18n.${mode}`)，mode ∈ { source, preview, diff }。
const FILE_VIEWER_DYNAMIC_KEYS = ["i18n.source", "i18n.preview", "i18n.diff"];

// ModelSelector.tsx 空态与提示（d5-33 接线新增；chip 空态 noModels 与
// tooltip/空列表 noAvailableModels 是历史上一对不同的字符串，拆两键保持原行为）。
const MODEL_SELECTOR_KEYS = [
  "models.selectModel",
  "models.noModels",
  "models.noAvailableModels",
  "models.switchingModel",
  "models.changeModel",
];

test("动态拼键在三个语言包中都存在且非空（FileViewer 视图模式 + ModelSelector 空态）", () => {
  const locales = getSupportedLocales();
  assert.deepEqual(locales, ["en", "zh-CN", "zh-TW"]);
  for (const locale of locales) {
    const messages = getLocalePlugin(locale).messages;
    for (const key of [...FILE_VIEWER_DYNAMIC_KEYS, ...MODEL_SELECTOR_KEYS]) {
      assert.ok(key in messages, `${locale} 缺键 ${key}——动态拼键会把键名渲染到界面`);
      assert.equal(typeof messages[key], "string", `${locale}.${key} 必须是字符串`);
      assert.ok(messages[key].trim().length > 0, `${locale}.${key} 是空串`);
    }
  }
});
