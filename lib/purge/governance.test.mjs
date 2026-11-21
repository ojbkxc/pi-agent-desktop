import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { governSystemText, governUserText } = await jiti.import("./governance.ts");
const { defaultPurgeSettings } = await jiti.import("./types.ts");

/** The defaults with the master switch on (it is on by default; the helper is explicit for clarity). */
function settings(overrides = {}) {
  return { ...defaultPurgeSettings(), enabled: true, ...overrides };
}

const SKILL_DIRS = [];

function skillRoot() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-purge-skills-"));
  SKILL_DIRS.push(dir);
  return dir;
}

function writeSkill(root, folder, { name, description = "a test skill", body }) {
  const target = join(root, folder);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
  return root;
}

after(() => {
  for (const dir of SKILL_DIRS) rmSync(dir, { recursive: true, force: true });
});

test("enabled=false leaves every text untouched, even with every switch on", () => {
  const text = "[meta] alpha\n\n\n\n  beta  \nHACK attack";
  const off = {
    ...defaultPurgeSettings(),
    // 总闸默认打开，这里的用例测的是「关掉以后一字不动」，所以显式关闭。
    enabled: false,
    system_normalize: true,
    dead_zone_rewrite: true,
    synonym_enabled: true,
    structured_prompt: true,
    skill_inject: true,
    normalize_strip_prefixes: ["[meta] "],
    rewrite_rules: [{ from: "hack", to: "audit" }],
    synonym_pairs: [{ from: "attack", to: "test" }],
    skill_dir: "/definitely/not/a/skill/dir",
  };
  assert.equal(off.enabled, false);

  const system = governSystemText(text, off);
  assert.equal(system.text, text);
  assert.equal(system.rewrite_hits, 0);
  assert.equal(system.synonym_hits, 0);
  assert.equal(system.skill_hits, 0);

  const user = governUserText(text, off);
  assert.equal(user.text, text);
  assert.equal(user.structured, false);
  assert.equal(user.rewrite_hits + user.synonym_hits + user.skill_hits, 0);
});

test("system_normalize collapses blank runs and drops line-trailing whitespace", () => {
  const system = governSystemText("one\n\n\n\ntwo  \nthree\t\n\nfour", settings({
    system_normalize: true,
  }));
  assert.equal(system.text, "one\n\ntwo\nthree\n\nfour");
});

test("system_normalize strips configured leading prefixes and keeps line order", () => {
  const system = governSystemText("[meta] alpha\nkeep me\n[meta] beta", settings({
    system_normalize: true,
    normalize_strip_prefixes: ["[meta] ", ">> "],
  }));
  assert.equal(system.text, "alpha\nkeep me\nbeta");

  const prefixed = governSystemText(">> one\n>> two", settings({
    system_normalize: true,
    normalize_strip_prefixes: [">> "],
  }));
  assert.equal(prefixed.text, "one\ntwo");
});

test("dead_zone_rewrite rewrites literally, ignores case and counts occurrences", () => {
  const system = governSystemText("HACK hack and Hack", settings({
    dead_zone_rewrite: true,
    rewrite_rules: [{ from: "hack", to: "audit" }],
  }));
  assert.equal(system.text, "audit audit and audit");
  assert.equal(system.rewrite_hits, 3);
  assert.equal(system.synonym_hits, 0);
});

test("synonym_enabled is an independent second pass with its own counter", () => {
  const onlySynonym = governUserText("攻击两次攻击", settings({
    dead_zone_rewrite: false,
    synonym_enabled: true,
    synonym_pairs: [{ from: "攻击", to: "测试" }],
  }));
  assert.equal(onlySynonym.text, "测试两次测试");
  assert.equal(onlySynonym.synonym_hits, 2);
  assert.equal(onlySynonym.rewrite_hits, 0);

  const disabledSynonym = governUserText("攻击两次攻击", settings({
    synonym_enabled: false,
    synonym_pairs: [{ from: "攻击", to: "测试" }],
  }));
  assert.equal(disabledSynonym.text, "攻击两次攻击");
  assert.equal(disabledSynonym.synonym_hits, 0);
});

test("a replacement carrying $ is inserted literally", () => {
  const system = governSystemText("cost", settings({
    dead_zone_rewrite: true,
    rewrite_rules: [{ from: "cost", to: "price $& / $1" }],
  }));
  assert.equal(system.text, "price $& / $1");
});

test("structured_prompt appends the suffix once and stays idempotent", () => {
  const suffix = "请先给结论";
  const cfg = settings({ structured_prompt: true, structured_suffix: suffix });

  const first = governUserText("怎么做", cfg);
  assert.equal(first.text, `怎么做\n\n${suffix}`);
  assert.equal(first.structured, true);

  const second = governUserText(first.text, cfg);
  assert.equal(second.text, first.text);
  assert.equal(second.structured, false);
  assert.equal(second.text.split(suffix).length, 2);

  const blank = governUserText("怎么做", settings({ structured_prompt: true, structured_suffix: "   " }));
  assert.equal(blank.text, "怎么做");
  assert.equal(blank.structured, false);
});

test("an active template replaces the suffix, and a dangling name falls back", () => {
  const cfg = settings({
    structured_prompt: true,
    structured_suffix: "默认后缀",
    structured_templates: [
      { name: "preset-a", text: "先结论后细节" },
      { name: "preset-b", text: "只用表格回答" },
    ],
    active_template: "preset-b",
  });

  const templated = governUserText("怎么做", cfg);
  assert.equal(templated.text, "怎么做\n\n只用表格回答");
  assert.equal(templated.structured, true);

  // No active template: the free-form suffix is the documented default.
  const noActive = governUserText("怎么做", { ...cfg, active_template: "" });
  assert.equal(noActive.text, "怎么做\n\n默认后缀");

  // A name that no longer exists must not silently disable the append.
  const dangling = governUserText("怎么做", { ...cfg, active_template: "gone" });
  assert.equal(dangling.text, "怎么做\n\n默认后缀");

  // An empty template body appends nothing (same rule as an empty suffix).
  const emptyBody = governUserText("怎么做", {
    ...cfg,
    structured_templates: [{ name: "blank", text: "   " }],
    active_template: "blank",
  });
  assert.equal(emptyBody.text, "怎么做");
  assert.equal(emptyBody.structured, false);
});

test("skill_inject appends the best-matching SKILL.md body", () => {
  const root = skillRoot();
  writeSkill(root, "alpha-widget", { name: "alpha-widget", body: "ALPHA BODY" });
  writeSkill(root, "beta-tool", { name: "beta-tool", body: "BETA BODY" });

  const cfg = settings({ skill_inject: true, skill_dir: root, skill_inject_limit: 1_000 });
  // Case-insensitive on both sides: WIDGET matches `widget`, and two name tokens match.
  const hit = governUserText("please use the WIDGET skill", cfg);
  assert.ok(hit.text.endsWith("ALPHA BODY"), hit.text);
  assert.equal(hit.skill_hits, 1);

  // Only `beta`/`tool` appear here, so the other skill wins.
  const other = governUserText("beta tool please", cfg);
  assert.ok(other.text.endsWith("BETA BODY"), other.text);
  assert.equal(other.skill_hits, 1);

  const miss = governUserText("nothing relevant", cfg);
  assert.equal(miss.text, "nothing relevant");
  assert.equal(miss.skill_hits, 0);
});

test("skill_inject truncates the body to skill_inject_limit characters", () => {
  const root = skillRoot();
  writeSkill(root, "truncator", { name: "truncator", body: "0123456789" });

  const injected = governUserText("run truncator", settings({
    skill_inject: true,
    skill_dir: root,
    skill_inject_limit: 4,
  }));
  assert.equal(injected.text, "run truncator\n\n0123");
  assert.equal(injected.skill_hits, 1);
});

test("skill_inject ignores frontmatter for matching and skips read failures", () => {
  const root = skillRoot();
  writeSkill(root, "gamma", { name: "gamma", description: "zzz-unrelated", body: "GAMMA BODY" });

  // The description is read but never matched: only `name` tokens count.
  const noMatch = governUserText("zzz-unrelated", settings({ skill_inject: true, skill_dir: root }));
  assert.equal(noMatch.text, "zzz-unrelated");

  // A child that is not a directory (no SKILL.md) is skipped, never fatal.
  writeFileSync(join(root, "stray.md"), "not a skill", "utf8");
  const matched = governUserText("gamma", settings({ skill_inject: true, skill_dir: root }));
  assert.ok(matched.text.endsWith("GAMMA BODY"), matched.text);
});

test("a missing skill directory is silence, not an error", () => {
  const missing = join(tmpdir(), "pi-web-purge-no-such-skills-dir");
  const governed = governUserText("hello", settings({ skill_inject: true, skill_dir: missing }));
  assert.equal(governed.text, "hello");
  assert.equal(governed.skill_hits, 0);

  const homeRelative = governUserText("hello", settings({ skill_inject: true, skill_dir: "~/no-such-purge-skills" }));
  assert.equal(homeRelative.text, "hello");
  assert.equal(homeRelative.skill_hits, 0);
});