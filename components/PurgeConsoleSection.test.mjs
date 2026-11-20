import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const repoRoot = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8").replace(/\r\n/g, "\n");
const componentSource = read("components/PurgeConsoleSection.tsx");
const panelSource = read("components/SettingsPanel.tsx");
const cssSource = read("app/native-theme.css");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");
const { SETTINGS_SECTION_VALUES, settingsSectionRequiresProject } = await jiti.import("../lib/settings-navigation.ts");

const renderJiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const purge = await renderJiti.import("./PurgeConsoleSection.tsx");
// Same resolver the component uses (`@/hooks/useI18n`), so provider and hook
// share one module instance and therefore one React context.
const { I18nProvider } = await renderJiti.import("@/hooks/useI18n");

/** First paint: the GET has not answered yet, so `stats` is null and nothing is loaded. */
function renderFirstPaint() {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(purge.PurgeConsoleSection),
  ));
}

const ZERO_STATS = {
  requests: 0,
  rewrite_hits: 0,
  synonym_hits: 0,
  skill_hits: 0,
  reasoning_clamps: 0,
  structured_appends: 0,
  started_at: "",
};

/** The wire contract, in the order `PUT /api/purge` receives it. */
const CONTRACT_FIELDS = [
  "enabled",
  "system_normalize",
  "dead_zone_rewrite",
  "synonym_enabled",
  "reduce_reasoning",
  "skill_inject",
  "structured_prompt",
  "reasoning_floor",
  "rewrite_rules",
  "synonym_pairs",
  "normalize_strip_prefixes",
  "skill_dir",
  "skill_inject_limit",
  "structured_suffix",
  "structured_templates",
  "active_template",
];

test("declares exactly the seven governance switches of the settings contract", () => {
  // The contract has seven boolean fields: the master switch plus six. AIGX's
  // eighth switch (cross_source_fallback) is not part of the ported contract.
  assert.deepEqual([...purge.PURGE_TOGGLE_KEYS], [
    "enabled",
    "system_normalize",
    "dead_zone_rewrite",
    "synonym_enabled",
    "reduce_reasoning",
    "skill_inject",
    "structured_prompt",
  ]);
  for (const key of purge.PURGE_TOGGLE_KEYS) {
    assert.equal(typeof purge.DEFAULT_PURGE_SETTINGS[key], "boolean", `${key} must be a boolean field`);
    assert.match(purge.PURGE_TOGGLE_LABEL_KEYS[key], /^purge\./, `${key} label key`);
    assert.match(purge.PURGE_TOGGLE_HINT_KEYS[key], /^purge\./, `${key} hint key`);
  }
  assert.deepEqual(Object.keys(purge.PURGE_TOGGLE_LABEL_KEYS), [...purge.PURGE_TOGGLE_KEYS]);
  assert.deepEqual(Object.keys(purge.PURGE_TOGGLE_HINT_KEYS), [...purge.PURGE_TOGGLE_KEYS]);
  // Every reasoning tier the server accepts has a label.
  assert.deepEqual([...purge.PURGE_REASONING_FLOORS], ["off", "low", "medium", "high", "xhigh"]);
  for (const floor of purge.PURGE_REASONING_FLOORS) {
    assert.match(purge.PURGE_REASONING_FLOOR_LABEL_KEYS[floor], /^purge\./);
  }
});

test("first paint renders the master switch and the six governance switches", () => {
  const html = renderFirstPaint();
  assert.equal((html.match(/role="switch"/g) ?? []).length, 7, "expected 7 switches on first paint");
  assert.match(html, /Purge Console/);
  assert.match(html, /Purge master switch/);
  for (const key of purge.PURGE_TOGGLE_KEYS) {
    const label = getLocalePlugin("en").messages[purge.PURGE_TOGGLE_LABEL_KEYS[key]];
    assert.ok(html.includes(label), `missing switch label: ${key} (${label})`);
  }
  // The three value fields keep their ids, so their <label for> resolves.
  for (const id of [
    "settings-purge-skill-dir",
    "settings-purge-skill-limit",
    "settings-purge-prefixes",
    "settings-purge-structured-suffix",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /settings-purge-floor/);
  assert.match(html, /Reading counters/);
  assert.match(html, /settings-purge-empty/);
});

test("uses accessible controls, never a native select", () => {
  // 思考强度是档位选择：五个档位平铺成按钮组，aria-pressed 表达选中态。
  // 旧的下拉要先展开才知道有哪几档，也看不到相邻档位。
  assert.match(componentSource, /settings-purge-floor-btn/);
  assert.match(componentSource, /aria-pressed=\{draft\.reasoning_floor === floor\}/);
  assert.equal(/<select\b|<datalist\b/.test(componentSource), false);
  // Every text/number/textarea control names itself; the rule inputs carry the
  // row number so a screen reader can tell the rows apart.
  assert.ok((componentSource.match(/aria-label=/g) ?? []).length >= 6, "expected aria-labels on every input");
  assert.match(componentSource, /aria-label=\{`\$\{columnFrom\} \$\{index \+ 1\}`\}/);
  assert.equal(/<div[^>]*onClick=/.test(componentSource), false, "clickable rows must be buttons");
  // No emoji anywhere in the section.
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(componentSource), false);
});

test("one save sends the whole settings object through PUT /api/purge", () => {
  assert.match(componentSource, /fetch\("\/api\/purge", \{ cache: "no-store" \}\)/);
  assert.match(componentSource, /method: "PUT"/);
  assert.match(componentSource, /headers: \{ "Content-Type": "application\/json" \}/);
  assert.match(componentSource, /const payload = purgeSavePayload\(/);
  assert.match(componentSource, /body: JSON\.stringify\(payload\)/);
  assert.equal(/method: "PATCH"|method: "POST"/.test(componentSource), false);
  // The response is read back into the form (no optimistic-only write).
  assert.match(componentSource, /asPurgeSettings\(isRecord\(data\) \? data\.settings : undefined\)/);

  const payload = purge.purgeSavePayload(purge.DEFAULT_PURGE_SETTINGS);
  assert.deepEqual(Object.keys(payload), CONTRACT_FIELDS, "request body must carry the contract in order");
  assert.equal(typeof payload.skill_inject_limit, "number");
  assert.equal(typeof payload.reasoning_floor, "string");
  assert.ok(Array.isArray(payload.rewrite_rules));
  assert.ok(Array.isArray(payload.synonym_pairs));
  assert.ok(Array.isArray(payload.normalize_strip_prefixes));
});

test("rows whose source is empty never reach the server", () => {
  const payload = purge.purgeSavePayload({
    ...purge.DEFAULT_PURGE_SETTINGS,
    rewrite_rules: [
      { from: "", to: "orphan" },
      { from: "   ", to: "blank" },
      { from: " a ", to: " b " },
      { from: "keep", to: "" },
    ],
    synonym_pairs: [{ from: "", to: "" }],
  });
  assert.deepEqual(payload.rewrite_rules, [{ from: "a", to: "b" }, { from: "keep", to: "" }]);
  assert.deepEqual(payload.synonym_pairs, []);
  assert.equal(JSON.stringify(payload).includes('"from":""'), false, "an empty source row leaked into the body");

  // The same rule applies on the way in, so a stored dead row cannot reappear.
  assert.deepEqual(purge.normalizePurgeRules([{ from: " ", to: "x" }, { from: "y", to: "z" }]), [{ from: "y", to: "z" }]);
  assert.deepEqual(purge.normalizePurgeRules("nope"), []);
});

test("the skill limit is clamped to the range the API enforces", () => {
  const { clampSkillInjectLimit, PURGE_SKILL_INJECT_LIMIT_MIN: min, PURGE_SKILL_INJECT_LIMIT_MAX: max } = purge;
  assert.equal(min, 16);
  assert.equal(max, 20_000);
  assert.equal(clampSkillInjectLimit(5), min);
  assert.equal(clampSkillInjectLimit(min - 1), min);
  assert.equal(clampSkillInjectLimit(min), min);
  // Rounded like the server (`Math.round`), not truncated.
  assert.equal(clampSkillInjectLimit(1500.9), 1501);
  assert.equal(clampSkillInjectLimit(1500), 1500);
  assert.equal(clampSkillInjectLimit(max + 1), max);
  assert.equal(clampSkillInjectLimit("  42 "), 42);
  // The server's own default (`defaultPurgeSettings()`), for anything unusable.
  assert.equal(clampSkillInjectLimit("12abc"), 2000);
  assert.equal(clampSkillInjectLimit(""), 2000);
  assert.equal(clampSkillInjectLimit("   "), 2000);
  assert.equal(clampSkillInjectLimit(Number.NaN), 2000);
  assert.equal(clampSkillInjectLimit(Number.POSITIVE_INFINITY), 2000);
  assert.equal(clampSkillInjectLimit(null), 2000);
  assert.equal(purge.purgeSavePayload({ ...purge.DEFAULT_PURGE_SETTINGS, skill_inject_limit: 3 }).skill_inject_limit, min);
});

test("asPurgeSettings fills every field and refuses a non-object", () => {
  assert.equal(purge.asPurgeSettings(undefined), null);
  assert.equal(purge.asPurgeSettings(null), null);
  assert.equal(purge.asPurgeSettings(["enabled"]), null);
  assert.equal(purge.asPurgeSettings("enabled"), null);

  assert.deepEqual(purge.asPurgeSettings({}), purge.DEFAULT_PURGE_SETTINGS);

  const parsed = purge.asPurgeSettings({
    enabled: true,
    system_normalize: "yes",
    dead_zone_rewrite: 1,
    synonym_enabled: null,
    reasoning_floor: "wild",
    skill_inject_limit: 99_999,
    skill_dir: "  /skills  ",
    structured_suffix: "  answer in JSON\n",
    rewrite_rules: [{ from: " a ", to: " b " }, "junk", { from: "" }],
    synonym_pairs: [{ from: "c", to: "d" }, 7],
    normalize_strip_prefixes: [" You are ", "", 5, "System:"],
  });
  assert.equal(parsed.enabled, true);
  // Only a real boolean counts; "yes", 1 and null are not.
  assert.equal(parsed.system_normalize, false);
  assert.equal(parsed.dead_zone_rewrite, false);
  assert.equal(parsed.synonym_enabled, false);
  assert.equal(parsed.reasoning_floor, purge.DEFAULT_PURGE_SETTINGS.reasoning_floor);
  assert.equal(parsed.skill_inject_limit, 20_000);
  assert.equal(parsed.skill_dir, "/skills");
  assert.equal(parsed.structured_suffix, "  answer in JSON\n", "the suffix is kept verbatim");
  assert.deepEqual(parsed.rewrite_rules, [{ from: "a", to: "b" }]);
  assert.deepEqual(parsed.synonym_pairs, [{ from: "c", to: "d" }]);
  assert.deepEqual(parsed.normalize_strip_prefixes, ["You are", "System:"]);
  for (const field of CONTRACT_FIELDS) {
    assert.ok(field in parsed, `missing contract field ${field}`);
  }
  // The same object round-trips unchanged through the save payload.
  assert.deepEqual(purge.purgeSavePayload(parsed), parsed);
});

test("asPurgeStats and asPurgeRuntime read the read-only block without throwing", () => {
  assert.equal(purge.asPurgeStats(null), null);
  assert.deepEqual(purge.asPurgeStats({}), ZERO_STATS);
  assert.deepEqual(purge.asPurgeStats({ requests: 12.7, rewrite_hits: -3, synonym_hits: "9", skill_hits: Number.NaN }), {
    ...ZERO_STATS,
    requests: 12,
  });
  assert.equal(purge.asPurgeStats({ started_at: "2024-05-01T00:00:00Z" }).started_at, "2024-05-01T00:00:00Z");

  assert.equal(purge.asPurgeRuntime(null), null);
  assert.equal(purge.asPurgeRuntime({ uptime_secs: 10 }), null, "a runtime without a pid is unusable");
  assert.deepEqual(purge.asPurgeRuntime({ pid: 4242.9, uptime_secs: 61 }), { pid: 4242, uptime_secs: 61 });
  assert.deepEqual(purge.asPurgeRuntime({ pid: 1, uptime_secs: -5 }), { pid: 1, uptime_secs: 0 });
});

test("rule-row helpers add, patch and remove without mutating the input", () => {
  const rows = [{ from: "a", to: "b" }];
  assert.deepEqual(purge.addPurgeRule(rows), [{ from: "a", to: "b" }, { from: "", to: "" }]);
  assert.deepEqual(rows, [{ from: "a", to: "b" }], "add must not mutate");
  assert.deepEqual(purge.patchPurgeRule(rows, 0, { to: "c" }), [{ from: "a", to: "c" }]);
  assert.deepEqual(purge.patchPurgeRule(rows, 5, { to: "c" }), [{ from: "a", to: "b" }], "out-of-range patch is a no-op");
  assert.deepEqual(purge.removePurgeRule([{ from: "a", to: "1" }, { from: "b", to: "2" }], 0), [{ from: "b", to: "2" }]);
  // The API keeps every row, so the form must not truncate the list.
  const longList = Array.from({ length: 250 }, (_, index) => ({ from: `r${index}`, to: "t" }));
  assert.equal(purge.normalizePurgeRules(longList).length, 250);
  assert.equal(purge.addPurgeRule(longList).length, 251);
});

test("toggling one switch leaves every other field alone", () => {
  const start = purge.asPurgeSettings({ enabled: false, skill_dir: "/s", skill_inject_limit: 40 });
  const next = purge.setPurgeToggle(start, "skill_inject", true);
  assert.equal(next.skill_inject, true);
  assert.equal(next.enabled, false);
  assert.equal(next.skill_dir, "/s");
  assert.equal(next.skill_inject_limit, 40);
  assert.notEqual(next, start, "a new object, so React re-renders");
  const back = purge.setPurgeToggle(next, "skill_inject", false);
  assert.deepEqual(back, start);
});

test("prefix and uptime formatting stay pure and predictable", () => {
  assert.deepEqual(purge.splitPurgePrefixes("You:, System: ,  ,"), ["You:", "System:"]);
  assert.deepEqual(purge.splitPurgePrefixes("你是一个，System:"), ["你是一个", "System:"]);
  // Half/full-width commas and whitespace all separate entries (like AIGX's splitList).
  assert.deepEqual(purge.splitPurgePrefixes("a b\tc"), ["a", "b", "c"]);
  assert.deepEqual(purge.splitPurgePrefixes(""), []);
  assert.equal(purge.joinPurgePrefixes(["a", "b"]), "a, b");
  assert.deepEqual(purge.normalizePrefixList([" x ", "", "y"]), ["x", "y"]);
  // Same here: the server keeps every prefix, so nothing is dropped client-side.
  assert.equal(purge.normalizePrefixList(Array.from({ length: 70 }, (_, index) => `p${index}`)).length, 70);

  const units = { seconds: "s", minutes: "min", hours: "h", days: "d" };
  assert.equal(purge.formatPurgeUptime(0, units), "0 s");
  assert.equal(purge.formatPurgeUptime(59, units), "59 s");
  assert.equal(purge.formatPurgeUptime(60, units), "1 min");
  assert.equal(purge.formatPurgeUptime(3_599, units), "59 min");
  assert.equal(purge.formatPurgeUptime(3_600, units), "1 h 0 min");
  assert.equal(purge.formatPurgeUptime(3_661, units), "1 h 1 min");
  assert.equal(purge.formatPurgeUptime(86_400, units), "1 d");
  assert.equal(purge.formatPurgeUptime(Number.NaN, units), "0 s");
  assert.equal(purge.formatPurgeUptime(-30, units), "0 s");
});

test("the counter block lists every field the API counts", () => {
  const rows = purge.purgeStatValues({
    requests: 1,
    rewrite_hits: 2,
    synonym_hits: 3,
    skill_hits: 4,
    reasoning_clamps: 5,
    structured_appends: 6,
    started_at: "t",
  });
  assert.deepEqual(rows.map((row) => row.value), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows.map((row) => row.labelKey), [
    "purge.statRequests",
    "purge.statRewriteHits",
    "purge.statSynonymHits",
    "purge.statSkillHits",
    "purge.statReasoningClamps",
    "purge.statStructuredAppends",
  ]);
  // `started_at` and the runtime uptime are shown by the render, not by this list.
  assert.match(componentSource, /t\("purge\.statStartedAt"\)/);
  assert.match(componentSource, /runtime\.uptime_secs/);
  assert.match(componentSource, /t\("purge\.statUptime"\)/);
});

test("every purge translation key exists in all three language packs", () => {
  const locales = getSupportedLocales();
  assert.deepEqual(locales, ["en", "zh-CN", "zh-TW"]);
  const packs = Object.fromEntries(locales.map((locale) => [locale, getLocalePlugin(locale).messages]));

  const literalKeys = [...componentSource.matchAll(/\bt\("(purge\.[A-Za-z]+)"/g)].map((match) => match[1]);
  const mappedKeys = [
    ...Object.values(purge.PURGE_TOGGLE_LABEL_KEYS),
    ...Object.values(purge.PURGE_TOGGLE_HINT_KEYS),
    ...Object.values(purge.PURGE_REASONING_FLOOR_LABEL_KEYS),
    ...purge.purgeStatValues(ZERO_STATS).map((row) => row.labelKey),
  ];
  const keys = [...new Set([...literalKeys, ...mappedKeys])].filter((key) => key.startsWith("purge."));
  assert.ok(keys.length >= 60, `expected the purge key set, got ${keys.length}`);
  for (const locale of locales) {
    for (const key of keys) {
      assert.equal(typeof packs[locale][key], "string", `${locale} is missing ${key}`);
      assert.ok(packs[locale][key].trim().length > 0, `${locale}.${key} is empty`);
    }
  }
  // The section title is the tab label and must read the same in all three packs.
  assert.equal(packs.en["purge.title"], "Purge Console");
  assert.equal(packs["zh-CN"]["purge.title"], "破甲控制台");
  assert.equal(packs["zh-TW"]["purge.title"], "破甲控制台");
  // The seven switch labels are all present, not just the master one.
  for (const key of Object.values(purge.PURGE_TOGGLE_LABEL_KEYS)) {
    assert.ok(keys.includes(key), `component does not reference ${key}`);
  }
});

test("Settings gains the purge section last, without reordering earlier values", () => {
  // Appending keeps a section stored in localStorage by an older build valid.
  assert.deepEqual([...SETTINGS_SECTION_VALUES], [
    "general",
    "appearance",
    "models",
    "skills",
    "agents",
    "plugins",
    "mcp",
    "purge",
  ]);
  // The gateway settings are process-wide, so no project is needed to show them.
  assert.equal(settingsSectionRequiresProject("purge"), false);

  assert.match(panelSource, /import \{ PurgeConsoleSection \} from "\.\/PurgeConsoleSection"/);
  assert.match(panelSource, /\{ id: "purge", labelKey: "purge\.title", requiresProject: false \}/);
  assert.match(panelSource, /sectionHost\("purge", <PurgeConsoleSection \/>\)/);
  assert.match(panelSource, /if \(section === "purge"\) return <svg/);
});

test("the locally declared contract stays locked to lib/purge/types.ts", async () => {
  // The component declares PurgeSettings itself, so the browser bundle never
  // depends on the server module; this keeps the two copies from drifting.
  const types = await jiti.import("../lib/purge/types.ts");
  const serverDefaults = types.defaultPurgeSettings();
  assert.deepEqual(
    Object.keys(purge.DEFAULT_PURGE_SETTINGS),
    Object.keys(serverDefaults),
    "field names and order must match lib/purge/types.ts",
  );
  assert.deepEqual([...purge.PURGE_REASONING_FLOORS], [...types.PURGE_THINKING_FLOORS]);
  assert.equal(purge.PURGE_SKILL_INJECT_LIMIT_MIN, types.PURGE_LIMITS.skill_inject_limit.min);
  assert.equal(purge.PURGE_SKILL_INJECT_LIMIT_MAX, types.PURGE_LIMITS.skill_inject_limit.max);
  // The placeholder the form falls back to is the server's own default.
  assert.equal(purge.DEFAULT_PURGE_SETTINGS.skill_inject_limit, serverDefaults.skill_inject_limit);
  assert.equal(purge.DEFAULT_PURGE_SETTINGS.reasoning_floor, serverDefaults.reasoning_floor);
  // A real settings object survives the client-side read without losing a field.
  const parsed = purge.asPurgeSettings(serverDefaults);
  for (const field of Object.keys(serverDefaults)) {
    assert.ok(field in parsed, `dropped ${field}`);
  }
});

test("every section class has a rule in app/native-theme.css", () => {
  // Read the classes off className attributes only: the same prefix is used for
  // element ids, which need no CSS rule.
  const classes = new Set();
  for (const match of componentSource.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    // Drop `${…}` expressions first: a conditional class is still a static class.
    const value = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const token of value.split(/\s+/)) {
      if (token.startsWith("settings-purge")) classes.add(token);
    }
  }
  assert.ok(classes.size >= 10, `expected the section's class set, got ${[...classes].join(", ")}`);
  for (const name of classes) {
    assert.match(cssSource, new RegExp(`\\.${name}\\b`), `${name} has no rule in app/native-theme.css`);
  }
  // New rules never add `!important` (scripts/native-theme-important-baseline.test.mjs).
  assert.equal(/settings-purge[^}]*!important/.test(cssSource), false);
});