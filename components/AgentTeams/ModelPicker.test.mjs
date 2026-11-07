import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ModelPicker, filterCatalogEntries, toggleModelRef, nextSelection, isFlashModelId, flashPresetState } =
  await jiti.import("./ModelPicker.tsx");
const { buildModelCatalog } = await jiti.import("@/hooks/useModelCatalog.ts");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const MODELS_PAYLOAD = {
  modelList: [
    { id: "claude-sonnet", name: "Claude Sonnet", provider: "zenmux" },
    { id: "claude-opus", name: "Claude Opus", provider: "zenmux" },
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
  ],
};
const ENABLED_PAYLOAD = {
  allEnabled: false,
  providers: [
    { id: "zenmux", models: [
      { ref: "zenmux/claude-sonnet", enabled: true },
      { ref: "zenmux/claude-opus", enabled: false },
    ] },
    { id: "openai", models: [{ ref: "openai/gpt-5", enabled: true }] },
  ],
};

const catalog = buildModelCatalog(MODELS_PAYLOAD, ENABLED_PAYLOAD);

const render = (props) => renderToStaticMarkup(React.createElement(
  I18nProvider,
  { initialLocale: "en" },
  React.createElement(ModelPicker, { catalog, value: [], onChange: () => {}, ...props }),
));

test("filterCatalogEntries matches name/id/provider and honours the enabled-only toggle", () => {
  const entries = catalog.entries;
  assert.equal(filterCatalogEntries(entries, "", false).length, 3);
  assert.deepEqual(
    filterCatalogEntries(entries, "opus", false).map((entry) => entry.ref),
    ["zenmux/claude-opus"],
  );
  assert.deepEqual(
    filterCatalogEntries(entries, "openai", false).map((entry) => entry.ref),
    ["openai/gpt-5"],
    "provider 也参与匹配",
  );
  assert.deepEqual(
    filterCatalogEntries(entries, "", true).map((entry) => entry.ref),
    ["zenmux/claude-sonnet", "openai/gpt-5"],
    "仅看已启用时排除未启用项",
  );
});

test("toggleModelRef adds and removes without disturbing order", () => {
  assert.deepEqual(toggleModelRef([], "a/b"), ["a/b"]);
  assert.deepEqual(toggleModelRef(["a/b", "c/d"], "c/d"), ["a/b"]);
  assert.deepEqual(toggleModelRef(["a/b"], "e/f"), ["a/b", "e/f"]);
});

test("nextSelection: multi toggles, single replaces or clears", () => {
  assert.deepEqual(nextSelection(["a"], "b", false), ["a", "b"]);
  assert.deepEqual(nextSelection(["a"], "b", true), ["b"], "单选点别的项即替换");
  assert.deepEqual(nextSelection(["a"], "a", true), [], "单选再点已选项即取消");
  assert.deepEqual(nextSelection([], "a", true), ["a"]);
});

test("single mode hides the Flash preset (it selects many)", () => {
  const html = render({ value: [], single: true });
  assert.doesNotMatch(html, /model-picker-flash/);
  assert.match(html, /model-picker-model/, "模型行仍在");
});

test("renders every model flat, grouped by provider, as real buttons", () => {
  const html = render({ value: [] });
  assert.match(html, /class="model-picker-group"/);
  assert.match(html, /model-picker-provider">zenmux</);
  assert.match(html, /model-picker-provider">openai</);
  // 三个模型全部铺开；每行是 <button type="button">
  assert.equal((html.match(/class="model-picker-model"/g) ?? []).length, 3);
  assert.equal((html.match(/<button type="button" class="model-picker-model"/g) ?? []).length, 3);
  assert.match(html, /title="zenmux\/claude-sonnet"/);
});

test("reflects the controlled selection and shows the selected count", () => {
  const html = render({ value: ["zenmux/claude-sonnet", "openai/gpt-5"] });
  assert.match(html, /data-count="2"/);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2, "仅两行处于选中态");
  assert.match(html, /class="model-picker-model is-selected"/);
  assert.match(html, /model-picker-clear/, "有选中项时出现清空按钮");
});

test("tags models the user has not enabled", () => {
  const html = render({ value: [] });
  assert.match(html, /model-picker-model-tag/, "未启用模型带标记");
});

test("shows dedicated states for loading, error and empty", () => {
  assert.match(render({ loading: true }), /data-state="loading"/);
  assert.match(render({ error: "boom" }), /role="alert" data-state="error"/);
  const emptyCatalog = buildModelCatalog({ modelList: [] }, ENABLED_PAYLOAD);
  const empty = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(ModelPicker, { catalog: emptyCatalog, value: [], onChange: () => {} }),
  ));
  assert.match(empty, /data-state="empty"/);
  assert.doesNotMatch(empty, /class="model-picker-group"/);
});

test("hides the enabled-only filter when the catalog has no enabled info", () => {
  const blind = buildModelCatalog(MODELS_PAYLOAD, null);
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(ModelPicker, { catalog: blind, value: [], onChange: () => {} }),
  ));
  assert.doesNotMatch(html, /model-picker-filter/);
});

test("keyboard access is real buttons with visible focus rings (source + CSS)", async () => {
  const source = await readFile(new URL("./ModelPicker.tsx", import.meta.url), "utf8");
  assert.match(source, /<button\s+type="button"/, "行与筛选控件都是真 button");
  assert.doesNotMatch(source, /role="checkbox"/, "不用 div 模拟控件");
  const css = await readFile(new URL("../../app/native-theme.css", import.meta.url), "utf8");
  assert.match(css, /\.model-picker-model:focus-visible/);
  assert.match(css, /\.model-picker-search:focus-visible/);
  assert.match(css, /\.model-picker-flash:focus-visible/);
});

// ── Flash 预设 ──────────────────────────────────────────────────────────────
const FLASH_PAYLOAD = {
  modelList: [
    { id: "qwen3.8-flash", name: "Qwen Flash", provider: "qwen" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek Flash", provider: "deepseek" },
    { id: "claude-sonnet", name: "Claude Sonnet", provider: "zenmux" },
  ],
};
const flashCatalog = buildModelCatalog(FLASH_PAYLOAD, { allEnabled: true, providers: [] });

test("isFlashModelId is data-driven on /flash/i, not a hard-coded list", () => {
  assert.equal(isFlashModelId("qwen3.8-flash"), true);
  assert.equal(isFlashModelId("deepseek-v4.1-flash"), true);
  assert.equal(isFlashModelId("GLM-5.3-FLASH"), true, "大小写不敏感");
  assert.equal(isFlashModelId("future-provider/nano-flash-preview"), true, "将来新增自动纳入");
  assert.equal(isFlashModelId("claude-sonnet"), false);
});

test("flashPresetState scopes to the visible set and reports full selection", () => {
  const entries = flashCatalog.entries;
  const none = flashPresetState(entries, []);
  assert.deepEqual(none.refs, ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash"], "按目录排序");
  assert.equal(none.active, false);
  assert.equal(flashPresetState(entries, ["qwen/qwen3.8-flash"]).active, false);
  assert.equal(
    flashPresetState(entries, ["qwen/qwen3.8-flash", "deepseek/deepseek-v4.1-flash"]).active,
    true,
  );
  // 无 flash 项的可见集（例如搜索命中非 flash）→ refs 空，按钮应禁用
  const noFlash = entries.filter((entry) => entry.id === "claude-sonnet");
  assert.deepEqual(flashPresetState(noFlash, []).refs, []);
});

test("flash preset button is disabled with an explanatory title when no flash model is visible", () => {
  const html = render({ value: [] }); // 基础目录里没有 flash 模型
  assert.match(html, /class="model-picker-flash" aria-pressed="false" disabled="" title="[^"]+"/, "禁用且带非空 title 说明");
});

test("flash preset button activates when every visible flash model is selected and counts them", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(ModelPicker, {
      catalog: flashCatalog,
      value: ["qwen/qwen3.8-flash", "deepseek/deepseek-v4.1-flash"],
      onChange: () => {},
    }),
  ));
  assert.match(html, /class="model-picker-flash" aria-pressed="true"/, "全选 flash 时按钮激活");
  assert.match(html, /data-flash-count="2"/);
});
