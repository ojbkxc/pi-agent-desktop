import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ModelPicker, filterCatalogEntries, toggleModelRef } = await jiti.import("./ModelPicker.tsx");
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

test("shows dedicated states for loading, error, empty and no-match", () => {
  assert.match(render({ loading: true }), /teams\.modelPicker\.loading/);
  assert.match(render({ error: "boom" }), /role="alert"/);
  const emptyCatalog = buildModelCatalog({ modelList: [] }, ENABLED_PAYLOAD);
  const empty = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(ModelPicker, { catalog: emptyCatalog, value: [], onChange: () => {} }),
  ));
  assert.match(empty, /model-picker-hint/);
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
});
