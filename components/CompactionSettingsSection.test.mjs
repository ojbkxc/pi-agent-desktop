import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const repoRoot = join(import.meta.dirname, "..");
const componentSource = readFileSync(join(repoRoot, "components", "CompactionSettingsSection.tsx"), "utf8");
const panelSource = readFileSync(join(repoRoot, "components", "SettingsPanel.tsx"), "utf8");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");

test("the compaction block uses the shared option control, never a native select", () => {
  assert.match(componentSource, /from "\.\/AppSelect"/);
  assert.match(componentSource, /<AppSelect/);
  assert.equal(/<select\b|<datalist\b/.test(componentSource), false);
});

test("Settings › General renders the compaction block", () => {
  assert.match(panelSource, /import \{ CompactionSettingsSection \} from "\.\/CompactionSettingsSection"/);
  assert.match(panelSource, /<CompactionSettingsSection \/>/);
});

test("every compaction translation key exists in all three language packs", () => {
  const locales = getSupportedLocales();
  assert.deepEqual(locales, ["en", "zh-CN", "zh-TW"]);
  const packs = Object.fromEntries(locales.map((locale) => [locale, getLocalePlugin(locale).messages]));
  const literalKeys = [...componentSource.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  assert.ok(literalKeys.length > 0, "expected t() keys in the component");
  // The tier and summarizer labels are reached through maps
  // (`t(MODE_LABEL_KEYS[mode])`), so collect them from the source strings too.
  const mappedKeys = [...componentSource.matchAll(/"(settings\.compaction[A-Za-z]+)"/g)].map((match) => match[1]);
  const keys = [...new Set([...literalKeys, ...mappedKeys])].filter((key) => key.startsWith("settings.compaction"));
  assert.ok(keys.length >= 16, `expected the compaction key set, got ${keys.length}`);
  for (const locale of locales) {
    for (const key of keys) {
      assert.equal(typeof packs[locale][key], "string", `${locale} is missing ${key}`);
      assert.ok(packs[locale][key].trim().length > 0, `${locale}.${key} is empty`);
    }
  }
  // The three tiers and the three summarizer choices each carry a label.
  for (const key of [
    "settings.compactionModeBalanced",
    "settings.compactionModeLong",
    "settings.compactionModeNative",
    "settings.compactionModelAuto",
    "settings.compactionModelCurrent",
    "settings.compactionModelPreferred",
  ]) {
    assert.ok(keys.includes(key), `component does not reference ${key}`);
  }
});

test("the block explains that the real window is unchanged and a reload is needed", () => {
  const hint = getLocalePlugin("en").messages["settings.compactionHint"].toLowerCase();
  assert.match(hint, /context window/);
  assert.match(hint, /reload/);
});
