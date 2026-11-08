import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const repoRoot = join(import.meta.dirname, "..");
const componentSource = readFileSync(join(repoRoot, "components", "CompactionSettingsSection.tsx"), "utf8");
const panelSource = readFileSync(join(repoRoot, "components", "SettingsPanel.tsx"), "utf8");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");

const renderJiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CompactionSettingsSection, asCompactionPolicy, asCompactionSettings } = await renderJiti.import("./CompactionSettingsSection.tsx");
// Same resolver the component uses (`@/hooks/useI18n`), so the provider and the
// hook share one module instance and therefore one React context.
const { I18nProvider } = await renderJiti.import("@/hooks/useI18n");

/** Renders the block with no server data yet: `payload` and `policy` are both null on first paint. */
function renderWithoutServerData() {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(CompactionSettingsSection),
  ));
}

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

test("the price wording states only what the UI knows", () => {
  // The runtime may trust a finite 0/0 cost (lib/compaction-model-select.ts), but the
  // provider writes 0/0 whenever it declares no cost at all, so the UI says "not
  // confirmed free" and the automatic order says "priced 0/0" — never "free".
  const label = { en: /not confirmed free/, "zh-CN": /未能确认是否免费/, "zh-TW": /未能確認是否免費/ };
  const order = { en: /priced 0\/0/, "zh-CN": /标价 0\/0/, "zh-TW": /標價 0\/0/ };
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = getLocalePlugin(locale).messages;
    assert.match(messages["settings.compactionPriceUnconfirmed"], label[locale], `${locale} price label`);
    assert.match(messages["settings.compactionAutoOrder"], order[locale], `${locale} automatic order wording`);
    assert.doesNotMatch(messages["settings.compactionAutoOrder"], /confirmed.free|已确认免费|已確認免費/, `${locale} claims confirmed-free`);
  }
});

test("first paint with no server data renders the controls instead of throwing", () => {
  // Regression: this is the one state the source-level tests never rendered, and a
  // page-level TypeError here takes the whole Settings › General tab down.
  const html = renderWithoutServerData();
  assert.match(html, /Context compaction/);
  assert.match(html, /Balanced \(50%\)/);
  assert.match(html, /Long context \(80%\)/);
  assert.match(html, /Native/);
  assert.match(html, /Save cost automatically/);
  assert.match(html, /Follow the main model/);
  assert.match(html, /Recent tokens kept verbatim/);
  assert.match(html, /16384/);
  assert.match(html, /262144/);
  assert.match(html, /id="settings-compaction-keep-recent"/);
});

test("a response without a policy reads as no data instead of half a payload", () => {
  // The E2E failure mode: the Settings › General fixture server answers `{}` for
  // every /api path it does not stub, and the block used to read `data.policy`
  // straight away. A non-null payload missing `limits` was the one that threw.
  assert.equal(asCompactionSettings({}), null);
  assert.equal(asCompactionSettings({ error: "nope" }), null);
  assert.equal(asCompactionSettings(null), null);
  assert.equal(asCompactionSettings({ policy: "balanced" }), null);

  const fromPolicyOnly = asCompactionSettings({
    policy: { mode: "long", keepRecentTokens: 32768, compactionModel: "preferred", preferredModels: ["acme/flash"] },
  });
  assert.deepEqual(fromPolicyOnly.limits, {
    keepRecentTokens: { min: 16384, max: 262144, default: 65536 },
    preferredModels: { max: 8 },
  });
  assert.deepEqual(fromPolicyOnly.candidates, []);
  assert.deepEqual(fromPolicyOnly.policy, {
    mode: "long",
    keepRecentTokens: 32768,
    compactionModel: "preferred",
    preferredModels: ["acme/flash"],
  });

  // A payload whose limits are present but partial fills only the missing fields.
  const partialLimits = asCompactionSettings({
    policy: { mode: "balanced" },
    limits: { keepRecentTokens: { max: 999 } },
    candidates: [
      { provider: "acme", modelId: "flash", label: "Flash · acme", priceConfirmed: true },
      { provider: "acme", modelId: "broken" },
      "not a candidate",
    ],
  });
  assert.deepEqual(partialLimits.limits, {
    keepRecentTokens: { min: 16384, max: 999, default: 65536 },
    preferredModels: { max: 8 },
  });
  assert.deepEqual(partialLimits.candidates, [
    { provider: "acme", modelId: "flash", label: "Flash · acme", priceConfirmed: true },
  ]);
});

test("asCompactionPolicy tolerates every malformed field and refuses non-objects", () => {
  assert.equal(asCompactionPolicy(null), null);
  assert.equal(asCompactionPolicy(undefined), null);
  assert.equal(asCompactionPolicy(["balanced"]), null);
  assert.deepEqual(asCompactionPolicy({}), {
    mode: "balanced",
    keepRecentTokens: 65536,
    compactionModel: "auto",
    preferredModels: [],
  });
  assert.deepEqual(asCompactionPolicy({
    mode: "wild",
    keepRecentTokens: "65536",
    compactionModel: "cheap",
    preferredModels: ["acme/flash", 7],
  }), {
    mode: "balanced",
    keepRecentTokens: 65536,
    compactionModel: "auto",
    // All-or-nothing, like the server: one bad entry empties the whole list.
    preferredModels: [],
  });
});

test("the whole client policy normalization matches the server's field for field", async () => {
  // The client cannot import lib/compaction-settings-api.ts (it pulls in node:fs), so
  // every rule is duplicated; this locks the two copies together. Two field-level
  // divergences already slipped through review once (preferredModels, then
  // keepRecentTokens), so this compares all four fields over a corpus that covers
  // each boundary rather than one example per field.
  const server = await jiti.import("../lib/compaction-settings-api.ts");
  const longRef = (length) => `a/${"x".repeat(length - 2)}`;
  const cases = [
    {},
    { mode: "balanced" },
    { mode: "long" },
    { mode: "native" },
    { mode: "wild" },
    { mode: 7 },
    { compactionModel: "auto" },
    { compactionModel: "current" },
    { compactionModel: "preferred" },
    { compactionModel: true },
    { keepRecentTokens: 16384 },
    { keepRecentTokens: 262144 },
    { keepRecentTokens: 65536 },
    { keepRecentTokens: 16383 },
    { keepRecentTokens: 262145 },
    { keepRecentTokens: 65536.5 },
    { keepRecentTokens: 0 },
    { keepRecentTokens: -1 },
    { keepRecentTokens: 1000 },
    { keepRecentTokens: "65536" },
    { keepRecentTokens: NaN },
    { keepRecentTokens: Infinity },
    { keepRecentTokens: null },
    { preferredModels: ["acme/x", 7, "bad"] },
    { preferredModels: Array(9).fill("a/b") },
    { preferredModels: [] },
    { preferredModels: "not-an-array" },
    { preferredModels: {} },
    { preferredModels: 7 },
    { preferredModels: true },
    { preferredModels: ["noslash"] },
    { preferredModels: ["/leading"] },
    { preferredModels: ["trailing/"] },
    { preferredModels: ["   "] },
    { preferredModels: ["a\u0000b/c"] },
    { preferredModels: ["a/b\t"] },
    { preferredModels: ["a b/c"] },
    { preferredModels: [longRef(200)] },
    { preferredModels: [longRef(201)] },
    // Duplicates survive on both sides on purpose: the list is ordered and not deduped.
    { preferredModels: ["a/b", " a/b "] },
    { preferredModels: [" acme/x "] },
    { preferredModels: ["openrouter/anthropic/claude-4"] },
    { preferredModels: undefined },
    { mode: "long", keepRecentTokens: 32768, compactionModel: "preferred", preferredModels: ["a/b", "c/d"] },
  ];
  for (const raw of cases) {
    assert.deepEqual(
      asCompactionPolicy(raw),
      server.normalizeCompactionPolicy(raw),
      `policy ${JSON.stringify(raw)}`,
    );
    assert.deepEqual(
      asCompactionPolicy(raw).preferredModels,
      server.normalizeCompactionPolicy(raw).preferredModels,
      `preferredModels ${JSON.stringify(raw.preferredModels)}`,
    );
  }

  // Declared exception: a non-object body. The server reads it as the defaults (it
  // always has a policy to return), while the client returns null because the UI
  // needs a distinct "the server sent no policy" state — it renders the failed
  // hint instead of pretending the defaults were the stored settings.
  for (const raw of [null, undefined, 7, "balanced", true, ["balanced"]]) {
    assert.equal(asCompactionPolicy(raw), null, `client ${JSON.stringify(raw)}`);
    assert.deepEqual(server.normalizeCompactionPolicy(raw), server.defaultCompactionPolicy(), `server ${JSON.stringify(raw)}`);
  }
});
