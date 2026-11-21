import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { normalizePurgeSettings, readPurgeSettings, writePurgeSettings } = await jiti.import(
  "./purge-settings.ts",
);
const { PURGE_LIMITS, defaultPurgeSettings } = await jiti.import("./purge/types.ts");

const DEFAULT_SKILL_DIR = "~/.agents/skills";
// 默认不追加任何文本：这段内容曾经被静默加在每条请求后面，界面上看不见。
const DEFAULT_SUFFIX = "";

function tempSettingsPath() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-purge-settings-"));
  const path = join(dir, "pi-web", "settings.json");
  return path;
}

test("defaults match the Purge Console contract", () => {
  const defaults = defaultPurgeSettings();
  assert.deepEqual(defaults, {
    enabled: false,
    system_normalize: false,
    dead_zone_rewrite: false,
    synonym_enabled: false,
    reduce_reasoning: false,
    skill_inject: false,
    structured_prompt: false,
    reasoning_floor: "low",
    rewrite_rules: [
      { from: "渗透测试", to: "授权的安全评估测试" },
      { from: "漏洞利用", to: "漏洞验证（授权环境）" },
      { from: "黑客", to: "安全研究人员" },
      { from: "抓包", to: "流量分析" },
      { from: "破解", to: "逆向分析（自有程序）" },
    ],
    synonym_pairs: [
      { from: "黑客", to: "安全研究人员" },
      { from: "漏洞利用", to: "漏洞验证" },
      { from: "攻击", to: "测试" },
      { from: "破解", to: "分析" },
      { from: "渗透", to: "评估" },
    ],
    normalize_strip_prefixes: [],
    skill_dir: DEFAULT_SKILL_DIR,
    skill_inject_limit: 2000,
    structured_suffix: DEFAULT_SUFFIX,
    structured_templates: [],
    active_template: "",
  });
  assert.deepEqual(PURGE_LIMITS, { skill_inject_limit: { min: 16, max: 20000 } });
  // A fresh object each call: callers must not be able to share mutable state.
  assert.notEqual(defaultPurgeSettings(), defaults);
  assert.notEqual(defaultPurgeSettings().rewrite_rules, defaults.rewrite_rules);
});

test("a non-object input normalizes to the defaults", () => {
  for (const value of [undefined, null, 42, "x", [], true]) {
    assert.deepEqual(normalizePurgeSettings(value), defaultPurgeSettings());
  }
});

test("unknown fields are dropped and known fields survive", () => {
  const normalized = normalizePurgeSettings({
    enabled: true,
    skill_inject: true,
    upstream_label: "aigx",
    retry_limit: 8,
    cross_source_fallback: true,
  });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.skill_inject, true);
  assert.equal(normalized.structured_prompt, false);
  assert.deepEqual(Object.keys(normalized).sort(), [
    "active_template",
    "dead_zone_rewrite",
    "enabled",
    "normalize_strip_prefixes",
    "reasoning_floor",
    "reduce_reasoning",
    "rewrite_rules",
    "skill_dir",
    "skill_inject",
    "skill_inject_limit",
    "structured_prompt",
    "structured_suffix",
    "structured_templates",
    "synonym_enabled",
    "synonym_pairs",
    "system_normalize",
  ]);
  assert.equal("upstream_label" in normalized, false);
  assert.equal("retry_limit" in normalized, false);
  assert.equal("cross_source_fallback" in normalized, false);
});

test("non-boolean switches fall back to their defaults", () => {
  const normalized = normalizePurgeSettings({
    enabled: "true",
    system_normalize: 1,
    dead_zone_rewrite: null,
    synonym_enabled: "yes",
    reduce_reasoning: 0,
    skill_inject: [],
    structured_prompt: {},
  });
  for (const key of [
    "enabled",
    "system_normalize",
    "dead_zone_rewrite",
    "synonym_enabled",
    "reduce_reasoning",
    "skill_inject",
    "structured_prompt",
  ]) {
    assert.equal(normalized[key], false, `${key} should fall back to false`);
  }
});

test("an unknown reasoning floor falls back to low, a known one survives", () => {
  assert.equal(normalizePurgeSettings({ reasoning_floor: "medium" }).reasoning_floor, "medium");
  assert.equal(normalizePurgeSettings({ reasoning_floor: "xhigh" }).reasoning_floor, "xhigh");
  assert.equal(normalizePurgeSettings({ reasoning_floor: "off" }).reasoning_floor, "off");
  assert.equal(normalizePurgeSettings({ reasoning_floor: "minimal" }).reasoning_floor, "low");
  assert.equal(normalizePurgeSettings({ reasoning_floor: 3 }).reasoning_floor, "low");
});

test("skill_inject_limit is clamped into the documented range", () => {
  assert.equal(normalizePurgeSettings({ skill_inject_limit: 1 }).skill_inject_limit, 16);
  assert.equal(normalizePurgeSettings({ skill_inject_limit: 15 }).skill_inject_limit, 16);
  assert.equal(normalizePurgeSettings({ skill_inject_limit: 16 }).skill_inject_limit, 16);
  assert.equal(normalizePurgeSettings({ skill_inject_limit: 500 }).skill_inject_limit, 500);
  assert.equal(normalizePurgeSettings({ skill_inject_limit: 20000 }).skill_inject_limit, 20000);
  assert.equal(normalizePurgeSettings({ skill_inject_limit: 999_999 }).skill_inject_limit, 20000);
  assert.equal(normalizePurgeSettings({ skill_inject_limit: 120.6 }).skill_inject_limit, 121);
  for (const value of [undefined, null, "2000", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(normalizePurgeSettings({ skill_inject_limit: value }).skill_inject_limit, 2000);
  }
});

test("rewrite rules drop entries with an empty from and trim the rest", () => {
  const normalized = normalizePurgeSettings({
    rewrite_rules: [
      { from: "  黑客  ", to: "  安全研究人员  " },
      { from: "", to: "x" },
      { from: "   ", to: "x" },
      { from: "抓包" },
      { to: "only-to" },
      "not-a-rule",
      null,
      { from: 7, to: "x" },
      { from: "破解", to: "" },
    ],
    synonym_pairs: [{ from: "攻击", to: "测试" }],
  });
  assert.deepEqual(normalized.rewrite_rules, [
    { from: "黑客", to: "安全研究人员" },
    { from: "抓包", to: "" },
    { from: "破解", to: "" },
  ]);
  assert.deepEqual(normalized.synonym_pairs, [{ from: "攻击", to: "测试" }]);
  // A non-array keeps the defaults, an empty array is a deliberate "no rules".
  assert.deepEqual(
    normalizePurgeSettings({ rewrite_rules: "oops" }).rewrite_rules,
    defaultPurgeSettings().rewrite_rules,
  );
  assert.deepEqual(normalizePurgeSettings({ rewrite_rules: [] }).rewrite_rules, []);
});

test("strip prefixes drop empty strings and trim", () => {
  const normalized = normalizePurgeSettings({
    normalize_strip_prefixes: [" STRIP ", "", "   ", 7, "PRE "],
  });
  assert.deepEqual(normalized.normalize_strip_prefixes, ["STRIP", "PRE"]);
  assert.deepEqual(
    normalizePurgeSettings({ normalize_strip_prefixes: "STRIP" }).normalize_strip_prefixes,
    [],
  );
});

test("skill_dir and structured_suffix tolerances", () => {  assert.equal(normalizePurgeSettings({ skill_dir: "  /tmp/skills " }).skill_dir, "/tmp/skills");
  assert.equal(normalizePurgeSettings({ skill_dir: "  " }).skill_dir, DEFAULT_SKILL_DIR);
  assert.equal(normalizePurgeSettings({ skill_dir: 5 }).skill_dir, DEFAULT_SKILL_DIR);
  assert.equal(normalizePurgeSettings({ structured_suffix: "" }).structured_suffix, "");
  assert.equal(normalizePurgeSettings({ structured_suffix: "  " }).structured_suffix, "");
  assert.equal(normalizePurgeSettings({ structured_suffix: "先结论" }).structured_suffix, "先结论");
  assert.equal(normalizePurgeSettings({ structured_suffix: 9 }).structured_suffix, DEFAULT_SUFFIX);
});

test("structured templates keep a named body and refuse unusable rows", () => {
  const normalized = normalizePurgeSettings({
    structured_templates: [
      { name: "  preset-a  ", text: "\n# body kept verbatim\n" },
      { name: "", text: "dropped" },
      { name: "   ", text: "dropped" },
      { name: 7, text: "dropped" },
      { name: "no-text" },
      "not-a-template",
      null,
      // Same name twice: the later row wins (the preset action upserts).
      { name: "preset-a", text: "second" },
    ],
    active_template: "  preset-a  ",
  });
  assert.deepEqual(normalized.structured_templates, [
    { name: "preset-a", text: "second" },
    { name: "no-text", text: "" },
  ]);
  assert.equal(normalized.active_template, "preset-a");

  // A non-array keeps the defaults; an empty array is a deliberate "no templates".
  assert.deepEqual(
    normalizePurgeSettings({ structured_templates: "oops" }).structured_templates,
    [],
  );
  assert.deepEqual(normalizePurgeSettings({ structured_templates: [] }).structured_templates, []);
  for (const value of [undefined, null, 5, {}, true]) {
    assert.equal(normalizePurgeSettings({ active_template: value }).active_template, "");
  }
});

test("an absent file reads as the defaults", () => {
  const settingsPath = tempSettingsPath();
  assert.deepEqual(readPurgeSettings(settingsPath), defaultPurgeSettings());
});

test("write then read round-trips, and non-purge keys stay untouched", () => {
  const settingsPath = tempSettingsPath();
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ version: 1, autoTitle: true }), "utf8");

  const written = writePurgeSettings(
    {
      enabled: true,
      system_normalize: true,
      dead_zone_rewrite: true,
      synonym_enabled: true,
      reduce_reasoning: true,
      skill_inject: true,
      structured_prompt: true,
      reasoning_floor: "high",
      rewrite_rules: [{ from: "甲", to: "乙" }],
      synonym_pairs: [{ from: "丙", to: "丁" }],
      normalize_strip_prefixes: ["STRIP"],
      skill_dir: "/tmp/skills",
      skill_inject_limit: 64,
      structured_suffix: "先结论",
      structured_templates: [{ name: "preset-a", text: "先结论后细节" }],
      active_template: "preset-a",
      unknown_field: "dropped",
    },
    settingsPath,
  );
  const expected = {
    enabled: true,
    system_normalize: true,
    dead_zone_rewrite: true,
    synonym_enabled: true,
    reduce_reasoning: true,
    skill_inject: true,
    structured_prompt: true,
    reasoning_floor: "high",
    rewrite_rules: [{ from: "甲", to: "乙" }],
    synonym_pairs: [{ from: "丙", to: "丁" }],
    normalize_strip_prefixes: ["STRIP"],
    skill_dir: "/tmp/skills",
    skill_inject_limit: 64,
    structured_suffix: "先结论",
    structured_templates: [{ name: "preset-a", text: "先结论后细节" }],
    active_template: "preset-a",
  };
  assert.deepEqual(written, expected);
  assert.deepEqual(readPurgeSettings(settingsPath), expected);

  const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(stored.purge, expected);
  assert.equal(stored.unknown_field, undefined);
  assert.equal(stored.autoTitle, true);
  assert.equal(stored.version, 1);
});

test("a damaged file or a damaged purge block reads as the defaults", () => {
  const settingsPath = tempSettingsPath();
  mkdirSync(join(settingsPath, ".."), { recursive: true });

  writeFileSync(settingsPath, "{ not json", "utf8");
  assert.deepEqual(readPurgeSettings(settingsPath), defaultPurgeSettings());

  writeFileSync(settingsPath, JSON.stringify([1, 2, 3]), "utf8");
  assert.deepEqual(readPurgeSettings(settingsPath), defaultPurgeSettings());

  writeFileSync(settingsPath, JSON.stringify({ purge: "oops" }), "utf8");
  assert.deepEqual(readPurgeSettings(settingsPath), defaultPurgeSettings());

  writeFileSync(
    settingsPath,
    JSON.stringify({ purge: { enabled: "not-a-bool", skill_inject_limit: -1 } }),
    "utf8",
  );
  const salvaged = readPurgeSettings(settingsPath);
  assert.equal(salvaged.enabled, false);
  assert.equal(salvaged.skill_inject_limit, 16);
});

test("purge-settings survives a directory that does not exist yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-purge-settings-fresh-"));
  const settingsPath = join(dir, "pi-web", "settings.json");
  const written = writePurgeSettings({ enabled: true }, settingsPath);
  assert.equal(written.enabled, true);
  assert.equal(readPurgeSettings(settingsPath).enabled, true);
});