import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * 设置页的长期记忆块：文案键三语齐全、首屏（无服务端数据）能渲染空态/加载态、
 * 不引入原生 select、不 import 服务端 store。
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const componentSource = readFileSync(join(repoRoot, "components", "memory", "MemorySettings.tsx"), "utf8");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("@/lib/i18n/registry.ts");

const renderJiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MemorySettings, asMemoryEntries, asMemoryEntry, parseTagDraft } = await renderJiti.import("./MemorySettings.tsx");
const { I18nProvider } = await renderJiti.import("@/hooks/useI18n");

function render(locale = "en") {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: locale },
    React.createElement(MemorySettings),
  ));
}

test("首屏可渲染：标题、说明、新增区与加载态（不 fetch 也稳定）", () => {
  const html = render();
  const messages = getLocalePlugin("en").messages;
  // renderToStaticMarkup 会转义引号等字符，所以按前缀做包含断言。
  assert.ok(html.includes(messages["memory.title"]), "title");
  assert.ok(html.includes("Facts kept across sessions"), "description");
  assert.ok(html.includes(messages["memory.loading"]), "entries 为 null 时显示加载态");
  assert.ok(html.includes(messages["memory.addLabel"]), "add label");
  assert.ok(html.includes(messages["memory.add"]), "add button");
  assert.equal(/<select\b|<datalist\b/.test(html), false, "不用原生 select");
});

test("三种语言都能渲染，且不使用中文以外的键名占位", () => {
  for (const locale of getSupportedLocales()) {
    const html = render(locale);
    const messages = getLocalePlugin(locale).messages;
    assert.ok(html.includes(messages["memory.title"]), locale);
    // 未翻译的键会原样出现在界面上；这里反查 memory.* 键名。
    assert.equal(html.includes("memory.addLabel"), false, `${locale} 泄漏键名`);
  }
});

test("组件不 import 服务端 store（node:fs 不得进浏览器包）", () => {
  assert.equal(/from "\.\.?\/.*memory\/store"/.test(componentSource), false);
  assert.equal(/from "@\/lib\/memory\/store"/.test(componentSource), false);
});

test("文案键：memory.* 在三个语言包中齐全且非空", () => {
  const locales = getSupportedLocales();
  const packs = Object.fromEntries(locales.map((locale) => [locale, getLocalePlugin(locale).messages]));
  const literalKeys = [...componentSource.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  const memoryKeys = [...new Set(literalKeys)].filter((key) => key.startsWith("memory."));
  assert.ok(memoryKeys.length >= 18, `expected the memory key set, got ${memoryKeys.length}`);
  for (const locale of locales) {
    for (const key of memoryKeys) {
      assert.equal(typeof packs[locale][key], "string", `${locale} is missing ${key}`);
      assert.ok(packs[locale][key].trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

test("放置建议：组件自包含（无 props），integrator 直接 <MemorySettings /> 即可", () => {
  assert.match(componentSource, /export function MemorySettings\(\)/);
  assert.equal(/export function MemorySettings\([^)]+\)/.test(componentSource), false, "不接收 props");
});

test("asMemoryEntry / asMemoryEntries：坏条目整条丢弃，不把渲染打崩", () => {
  assert.equal(asMemoryEntry(null), null);
  assert.equal(asMemoryEntry({ id: "x" }), null, "缺 text");
  assert.deepEqual(asMemoryEntry({ id: "x", text: "t", tags: ["a", 5] }), {
    id: "x",
    text: "t",
    createdAt: "",
    updatedAt: "",
    tags: ["a"],
  });
  assert.equal(asMemoryEntries({}), null, "缺 entries 数组算失败");
  assert.deepEqual(asMemoryEntries({ entries: [{ id: "x", text: "t" }, null, { id: "y" }] }).map((e) => e.id), ["x"]);
});

test("parseTagDraft：中英文逗号都切、去重去空", () => {
  assert.deepEqual(parseTagDraft("a, b，a,, c "), ["a", "b", "c"]);
  assert.deepEqual(parseTagDraft(""), []);
});