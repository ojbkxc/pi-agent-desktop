/**
 * Unit tests for the preset library's core: preview truncation, search + facets,
 * detail, and the two apply targets.
 *
 * The route tests (`app/api/purge/presets/**`) prove the HTTP wiring against the
 * real catalog; this file proves the rules themselves, including the cases the
 * real catalog cannot produce — an empty catalog, two vendor spellings of the
 * same vendor, a catalog row whose id is not a safe path segment, an unwritable
 * skill directory. That is why every function under test has a `catalog`
 * parameter: the fixtures are small and fully controlled.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_PRESET_LIMIT,
  MAX_PRESET_LIMIT,
  PREVIEW_CHARS,
  PresetNotFoundError,
  applyPreset,
  applyPresetTo,
  getPreset,
  getPresetDetail,
  isPresetApplyTarget,
  listPresetPage,
  listPresets,
  previewOf,
} = await jiti.import("./presets.ts");
const { BUILTIN_PRESETS } = await jiti.import("./preset-catalog.ts");
const { defaultPurgeSettings } = await jiti.import("./types.ts");

const TEMP_DIRS = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** A catalog row with sane defaults; `bytes` follows `body` unless overridden. */
function preset(overrides = {}) {
  const merged = {
    id: "vendor-model",
    vendor: "Vendor",
    model: "model",
    title: "model",
    tags: [],
    sha256: "0".repeat(64),
    body: "BODY",
    ...overrides,
  };
  return {
    ...merged,
    bytes: overrides.bytes ?? Buffer.byteLength(merged.body, "utf8"),
  };
}

/** The full five-field match surface the search promises. */
const SEARCH_CATALOG = [
  preset({ id: "alpha-opus", vendor: "Alpha", model: "opus", title: "opus", tags: ["persona"] }),
  preset({ id: "alpha-sonnet", vendor: "Alpha", model: "sonnet", title: "sonnet", tags: [] }),
  preset({ id: "beta-kimi", vendor: "Beta", model: "kimi", title: "kimi", tags: ["workspace"] }),
  preset({ id: "gamma-glm", vendor: "Gamma", model: "glm", title: "glm", tags: ["policy"] }),
];

function ids(page) {
  return page.items.map((item) => item.id);
}

// ---------------------------------------------------------------------------
// previewOf
// ---------------------------------------------------------------------------

test("previewOf leaves a short body untouched and is a true prefix", () => {
  assert.equal(previewOf(""), "");
  assert.equal(previewOf("short prompt"), "short prompt");
  const exact = "x".repeat(PREVIEW_CHARS);
  assert.equal(previewOf(exact), exact);
  const long = "y".repeat(PREVIEW_CHARS + 1);
  const preview = previewOf(long);
  assert.equal(Array.from(preview).length, PREVIEW_CHARS);
  assert.equal(long.startsWith(preview), true);
  // No ellipsis: the preview is a prefix, so a consumer can align it against the body.
  assert.equal(preview.endsWith("…"), false);
});

test("previewOf truncates by code point, never by UTF-16 unit", () => {
  // Chinese is BMP, but a byte- or unit-based cut still breaks the count contract.
  const chinese = "破甲".repeat(300);
  const preview = previewOf(chinese);
  assert.equal(Array.from(preview).length, PREVIEW_CHARS);
  assert.equal(chinese.startsWith(preview), true);

  // Emoji are surrogate pairs: slicing UTF-16 units would leave a lone high
  // surrogate, which JSON turns into U+FFFD. `Array.from` cannot.
  const emoji = "🙂".repeat(300);
  const emojiPreview = previewOf(emoji);
  assert.equal(Array.from(emojiPreview).length, PREVIEW_CHARS);
  assert.equal(emoji.startsWith(emojiPreview), true);
  assert.equal(emojiPreview.isWellFormed(), true);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emojiPreview), false);
});

// ---------------------------------------------------------------------------
// listPresetPage — search
// ---------------------------------------------------------------------------

test("search matches id, vendor, model, title and tags, case-insensitively", () => {
  const cases = [
    ["opus", "alpha-opus"], // model + title
    ["ALPHA", "alpha-opus", "alpha-sonnet"], // vendor, upper-cased query
    ["kimi", "beta-kimi"], // model
    ["workspace", "beta-kimi"], // tag
    ["gamma", "gamma-glm"], // vendor
  ];
  for (const [query, ...expected] of cases) {
    const page = listPresetPage(SEARCH_CATALOG, { q: query });
    assert.deepEqual(ids(page).sort(), expected.sort(), `q=${query}`);
    assert.equal(page.total, expected.length, `q=${query} total`);
  }

  // A query is trimmed; a blank one is the whole catalog, not an empty result.
  assert.equal(listPresetPage(SEARCH_CATALOG, { q: "   " }).total, SEARCH_CATALOG.length);
  assert.equal(listPresetPage(SEARCH_CATALOG, { q: "  opus  " }).total, 1);
  // No match is an empty page with empty facets, never an error.
  assert.deepEqual(listPresetPage(SEARCH_CATALOG, { q: "zzz" }), {
    items: [],
    vendors: [],
    total: 0,
  });
});

test("search never reads the prompt body", () => {
  const catalog = [
    preset({ id: "one", vendor: "A", model: "one", title: "one", body: "needle in the body" }),
    preset({ id: "two", vendor: "A", model: "two", title: "two", body: "haystack" }),
  ];
  // A body hit is not a match: the list is metadata search, and indexing 730 KB of
  // prose per keystroke is what this rule exists to prevent.
  assert.deepEqual(ids(listPresetPage(catalog, { q: "needle" })), []);
});

// ---------------------------------------------------------------------------
// listPresetPage — facets and filters
// ---------------------------------------------------------------------------

test("the vendor facet counts query matches and ignores the vendor filter", () => {
  const all = listPresetPage(SEARCH_CATALOG);
  assert.deepEqual(
    all.vendors.map((entry) => [entry.vendor, entry.count]),
    [["Alpha", 2], ["Beta", 1], ["Gamma", 1]],
  );

  const filtered = listPresetPage(SEARCH_CATALOG, { vendor: "Beta" });
  assert.deepEqual(ids(filtered), ["beta-kimi"]);
  assert.equal(filtered.total, 1);
  // The chip row keeps its other choices: narrowing must not delete the way back.
  assert.deepEqual(filtered.vendors, all.vendors);

  // …but a query does narrow the facets, because they describe the search.
  const searched = listPresetPage(SEARCH_CATALOG, { q: "opus" });
  assert.deepEqual(searched.vendors, [{ vendor: "Alpha", count: 1 }]);
});

test("the vendor filter is an exact case-insensitive match, not a substring", () => {
  assert.deepEqual(ids(listPresetPage(SEARCH_CATALOG, { vendor: "alpha" })), [
    "alpha-opus",
    "alpha-sonnet",
  ]);
  assert.deepEqual(ids(listPresetPage(SEARCH_CATALOG, { vendor: "  ALPHA  " })), [
    "alpha-opus",
    "alpha-sonnet",
  ]);
  // "Alp" is a prefix, not the vendor name: a filter is not a search.
  assert.deepEqual(listPresetPage(SEARCH_CATALOG, { vendor: "Alp" }).items, []);
  assert.deepEqual(listPresetPage(SEARCH_CATALOG, { vendor: "nope" }).items, []);
});

test("two spellings of one vendor are one facet, and both filter hits", () => {
  const catalog = [
    preset({ id: "a-one", vendor: "xAI", model: "one" }),
    preset({ id: "b-one", vendor: "xai", model: "two" }),
    preset({ id: "c-one", vendor: "Xiaomi", model: "three" }),
  ];
  const page = listPresetPage(catalog);
  assert.deepEqual(page.vendors, [{ vendor: "xAI", count: 2 }, { vendor: "Xiaomi", count: 1 }]);
  // The filter lower-cases both sides, so either spelling selects both rows.
  assert.deepEqual(ids(listPresetPage(catalog, { vendor: "xai" })), ["a-one", "b-one"]);
});

// ---------------------------------------------------------------------------
// listPresetPage — paging
// ---------------------------------------------------------------------------

test("limit falls back to the default for missing, non-finite and non-positive values", () => {
  const catalog = Array.from({ length: 120 }, (_, index) =>
    preset({ id: `p-${String(index).padStart(3, "0")}`, model: `m-${index}` }),
  );
  for (const limit of [undefined, null, 0, -5, Number.NaN, Infinity, -Infinity]) {
    const page = listPresetPage(catalog, { limit });
    assert.equal(page.items.length, DEFAULT_PRESET_LIMIT, `limit=${String(limit)}`);
    assert.equal(page.total, catalog.length);
  }

  assert.equal(listPresetPage(catalog, { limit: 1 }).items.length, 1);
  assert.equal(listPresetPage(catalog, { limit: 2.9 }).items.length, 2);
  assert.equal(
    listPresetPage(catalog, { limit: 10_000 }).items.length,
    Math.min(MAX_PRESET_LIMIT, catalog.length),
  );
  // The cap is a hard ceiling, not a hint: a catalog bigger than it still pages.
  const oversized = Array.from({ length: MAX_PRESET_LIMIT + 25 }, (_, index) =>
    preset({ id: `q-${String(index).padStart(4, "0")}` }),
  );
  assert.equal(listPresetPage(oversized, { limit: 10_000 }).items.length, MAX_PRESET_LIMIT);
  assert.equal(listPresetPage(oversized, { limit: 10_000 }).total, oversized.length);
  // `total` describes the match set, not the page.
  assert.equal(listPresetPage(catalog, { limit: 3 }).total, catalog.length);
});

test("paging is a stable prefix of the catalog order", () => {
  const catalog = Array.from({ length: 60 }, (_, index) =>
    preset({ id: `p-${String(index).padStart(3, "0")}` }),
  );
  const full = listPresetPage(catalog, { limit: MAX_PRESET_LIMIT });
  const first = listPresetPage(catalog, { limit: 5 });
  assert.deepEqual(ids(first), ids(full).slice(0, 5));
  // Never re-sorted: the generator owns (vendor, model, id) order and a second
  // collation here would disagree with it on mixed-case vendor names.
  assert.deepEqual(ids(full), catalog.map((entry) => entry.id));
});

test("list items carry a preview, never the body or its fingerprint", () => {
  const catalog = [preset({ id: "one", body: "z".repeat(PREVIEW_CHARS * 2) })];
  const [item] = listPresetPage(catalog).items;
  assert.deepEqual(Object.keys(item).sort(), [
    "bytes",
    "id",
    "model",
    "preview",
    "tags",
    "title",
    "vendor",
  ]);
  assert.equal(item.preview.length, PREVIEW_CHARS);
  assert.equal(item.bytes, Buffer.byteLength(catalog[0].body, "utf8"));
});

test("an empty catalog pages to an empty result", () => {
  assert.deepEqual(listPresetPage([]), { items: [], vendors: [], total: 0 });
});

test("summary tags are a copy, so a caller cannot corrupt the catalog", () => {
  const catalog = [preset({ id: "one", tags: ["persona", "workspace"] })];
  const [item] = listPresetPage(catalog).items;
  item.tags.push("mutated");
  item.tags.sort();
  assert.deepEqual([...catalog[0].tags], ["persona", "workspace"]);
});

// ---------------------------------------------------------------------------
// getPresetDetail
// ---------------------------------------------------------------------------

test("getPresetDetail returns the body verbatim and no fingerprint", () => {
  const body = "# Prompt\n\n正文 with CRLF-free lines\n";
  const catalog = [preset({ id: "one", title: "One", body, bytes: 999 })];
  const detail = getPresetDetail(catalog, "one");
  assert.equal(detail.body, body);
  assert.equal(detail.preview, body);
  // The stored byte count is reported as stored (the catalog test owns verifying it).
  assert.equal(detail.bytes, 999);
  assert.deepEqual(Object.keys(detail).sort(), [
    "body",
    "bytes",
    "id",
    "model",
    "preview",
    "tags",
    "title",
    "vendor",
  ]);
});

test("getPresetDetail is exact on the id and silent on a miss", () => {
  const catalog = [preset({ id: "alpha-opus" })];
  assert.equal(getPresetDetail(catalog, "ALPHA-OPUS"), undefined);
  assert.equal(getPresetDetail(catalog, "alpha"), undefined);
  assert.equal(getPresetDetail(catalog, ""), undefined);
  assert.equal(getPresetDetail(catalog, "../alpha-opus"), undefined);
});

// ---------------------------------------------------------------------------
// Bound wrappers (what the API routes call)
// ---------------------------------------------------------------------------

test("listPresets reads the generated catalog", () => {
  const page = listPresets();
  assert.equal(page.total, BUILTIN_PRESETS.length);
  assert.equal(page.items.length, Math.min(page.total, DEFAULT_PRESET_LIMIT));
  assert.equal(new Set(page.items.map((item) => item.id)).size, page.items.length);

  const byId = new Map(BUILTIN_PRESETS.map((entry) => [entry.id, entry]));
  for (const item of page.items) {
    const entry = byId.get(item.id);
    assert.ok(entry, `${item.id} must come from the catalog`);
    assert.equal(entry.body.startsWith(item.preview), true);
    assert.equal("body" in item, false);
  }
});

test("getPreset resolves a catalog id and nothing else", () => {
  const entry = BUILTIN_PRESETS[0];
  const detail = getPreset(entry.id);
  assert.equal(detail.body, entry.body);
  assert.equal(detail.title, entry.title);
  assert.equal(detail.sha256, undefined);
  assert.equal(getPreset("no-such-preset"), undefined);
  assert.equal(getPreset("../../etc/passwd"), undefined);
});

// ---------------------------------------------------------------------------
// applyPreset — structured_template
// ---------------------------------------------------------------------------

test("structured_template upserts by template name and reports real changes", () => {
  const catalog = [preset({ id: "one", title: "One", body: "PROMPT" })];
  const settings = defaultPurgeSettings();

  const first = applyPresetTo(catalog, settings, "one", "structured_template");
  assert.deepEqual(first, { target: "structured_template", changed: true, template: "One" });
  assert.deepEqual(settings.structured_templates, [{ name: "One", text: "PROMPT" }]);
  // activate defaults to false: applying is not the same decision as selecting.
  assert.equal(settings.active_template, "");

  const again = applyPresetTo(catalog, settings, "one", "structured_template");
  assert.equal(again.changed, false, "a no-op re-apply must say so");
  assert.equal(settings.structured_templates.length, 1, "upsert, not append");

  // Same title, new body: the entry is replaced and the change is reported.
  const renamed = [preset({ id: "one", title: "One", body: "PROMPT v2" })];
  const updated = applyPresetTo(renamed, settings, "one", "structured_template");
  assert.equal(updated.changed, true);
  assert.deepEqual(settings.structured_templates, [{ name: "One", text: "PROMPT v2" }]);
});

test("structured_template keeps unrelated templates and honours activate", () => {
  const catalog = [
    preset({ id: "one", title: "One", body: "P1" }),
    preset({ id: "two", title: "Two", body: "P2" }),
  ];
  const settings = defaultPurgeSettings();
  settings.structured_templates = [{ name: "手写", text: "自己写的" }];
  settings.active_template = "手写";

  applyPresetTo(catalog, settings, "one", "structured_template");
  assert.deepEqual(settings.structured_templates.map((entry) => entry.name), ["手写", "One"]);
  assert.equal(settings.active_template, "手写", "installing a template must not select it");

  const activated = applyPresetTo(catalog, settings, "two", "structured_template", true);
  assert.equal(activated.changed, true);
  assert.equal(settings.active_template, "Two");
  assert.equal(settings.structured_templates.length, 3);

  // Activating the already-active template is not a change.
  const repeat = applyPresetTo(catalog, settings, "two", "structured_template", true);
  assert.equal(repeat.changed, false);
});

test("structured_template tolerates a settings object without a template list", () => {
  const catalog = [preset({ id: "one", title: "One", body: "P" })];
  const settings = { ...defaultPurgeSettings(), structured_templates: undefined };
  applyPresetTo(catalog, settings, "one", "structured_template");
  assert.deepEqual(settings.structured_templates, [{ name: "One", text: "P" }]);
});

test("applying a template never writes to disk", () => {
  const catalog = [preset({ id: "one", title: "One" })];
  const settings = { ...defaultPurgeSettings(), skill_dir: join(tempDir("preset-no-write-"), "skills") };
  applyPresetTo(catalog, settings, "one", "structured_template");
  // No directory, no file: the template target is memory only.
  assert.equal(settings.structured_templates.length, 1);
});

// ---------------------------------------------------------------------------
// applyPreset — skill_file
// ---------------------------------------------------------------------------

test("skill_file writes <skill_dir>/<id>/SKILL.md with frontmatter and verbatim body", () => {
  const skillDir = join(tempDir("preset-skill-"), "skills");
  const body = "# Preset\n\n完整正文——首行、空行、尾行都保持原样。\n";
  const catalog = [
    preset({ id: "alpha-opus", vendor: "Alpha", model: "opus", title: "opus", tags: ["persona"], body }),
  ];
  const settings = { ...defaultPurgeSettings(), skill_dir: skillDir };

  const applied = applyPresetTo(catalog, settings, "alpha-opus", "skill_file");
  assert.equal(applied.target, "skill_file");
  assert.equal(applied.changed, true);
  assert.equal(applied.path, join(skillDir, "alpha-opus", "SKILL.md"));

  const content = readFileSync(applied.path, "utf8");
  assert.equal(content.startsWith("---\n"), true);
  const closing = content.indexOf("\n---", 4);
  const frontmatter = content.slice(4, closing);
  assert.match(frontmatter, /^name: opus$/m);
  assert.match(frontmatter, /^description: .+$/m);
  assert.match(frontmatter, /^keywords: .+$/m);
  assert.equal(content.endsWith(`\n\n${body}`), true, "the body is the file body");

  // The settings are untouched: this target lands on the filesystem.
  assert.deepEqual(settings.structured_templates, []);
  assert.equal(settings.active_template, "");

  // Re-applying identical content is not a change; a stale file is.
  assert.equal(applyPresetTo(catalog, settings, "alpha-opus", "skill_file").changed, false);
  writeFileSync(applied.path, "stale", "utf8");
  assert.equal(applyPresetTo(catalog, settings, "alpha-opus", "skill_file").changed, true);
  assert.equal(readFileSync(applied.path, "utf8"), content);
});

test("skill_file expands a leading ~ in the skill directory", () => {
  const home = tempDir("preset-home-");
  const previous = process.env.PI_AGENT_HOME;
  process.env.PI_AGENT_HOME = home;
  try {
    const catalog = [preset({ id: "one" })];
    const settings = { ...defaultPurgeSettings(), skill_dir: "~/skills" };
    // governance's expandHome uses os.homedir(), so assert the shape rather than the
    // absolute prefix: the file must land under <something>/skills/<id>/SKILL.md.
    const applied = applyPresetTo(catalog, settings, "one", "skill_file");
    assert.equal(applied.path.endsWith(join("skills", "one", "SKILL.md")), true);
    assert.equal(readFileSync(applied.path, "utf8").endsWith("\n\nBODY"), true);
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previous;
  }
});

test("skill_file fails loudly on an empty or unusable skill directory", () => {
  const catalog = [preset({ id: "one" })];
  assert.throws(
    () => applyPresetTo(catalog, { ...defaultPurgeSettings(), skill_dir: "   " }, "one", "skill_file"),
    /skill_dir is empty/,
  );

  // A regular file where the skill directory should be is the realistic
  // "unwritable" case: creating <file>/<id> fails with ENOTDIR.
  const blocker = join(tempDir("preset-blocker-"), "not-a-dir");
  writeFileSync(blocker, "x", "utf8");
  assert.throws(
    () => applyPresetTo(catalog, { ...defaultPurgeSettings(), skill_dir: blocker }, "one", "skill_file"),
    /ENOTDIR|not a directory|EEXIST/i,
  );
});

test("skill_file refuses an id that is not a safe path segment", () => {
  for (const id of ["../evil", "a/b", "UPPER", "-lead", "trail-", "with space"]) {
    const catalog = [preset({ id })];
    const settings = { ...defaultPurgeSettings(), skill_dir: tempDir("preset-unsafe-") };
    assert.throws(
      () => applyPresetTo(catalog, settings, id, "skill_file"),
      /not a safe path segment/,
      `id ${JSON.stringify(id)} must be rejected`,
    );
  }
  // A template target never touches a path, so the same id is allowed there.
  const settings = defaultPurgeSettings();
  applyPresetTo([preset({ id: "UPPER" })], settings, "UPPER", "structured_template");
  assert.equal(settings.structured_templates.length, 1);
});

// ---------------------------------------------------------------------------
// applyPreset — contract edges
// ---------------------------------------------------------------------------

test("applyPreset throws PresetNotFoundError for an unknown id", () => {
  const settings = defaultPurgeSettings();
  assert.throws(
    () => applyPreset(settings, "no-such-preset", "structured_template"),
    (error) => error instanceof PresetNotFoundError && error.name === "PresetNotFoundError",
  );
  assert.throws(
    () => applyPreset(settings, "../../etc/passwd", "skill_file"),
    PresetNotFoundError,
  );
  assert.deepEqual(settings.structured_templates, []);
});

test("applyPreset writes into the generated catalog's skill directory", () => {
  const skillDir = join(tempDir("preset-bound-"), "skills");
  const entry = BUILTIN_PRESETS[0];
  const settings = { ...defaultPurgeSettings(), skill_dir: skillDir };

  const applied = applyPreset(settings, entry.id, "skill_file");
  assert.equal(applied.path, join(skillDir, entry.id, "SKILL.md"));
  assert.equal(readFileSync(applied.path, "utf8").endsWith(`\n\n${entry.body}`), true);

  applyPreset(settings, entry.id, "structured_template", true);
  assert.equal(settings.active_template, entry.title);
  assert.equal(settings.structured_templates[0].text, entry.body);
});

test("isPresetApplyTarget accepts exactly the two landing points", () => {
  assert.equal(isPresetApplyTarget("structured_template"), true);
  assert.equal(isPresetApplyTarget("skill_file"), true);
  for (const value of ["", "template", "skill", "SKILL_FILE", null, undefined, 1, {}]) {
    assert.equal(isPresetApplyTarget(value), false, `value ${String(value)}`);
  }
});

test("applying never mutates the catalog", () => {
  const catalog = [
    preset({ id: "one", title: "One", tags: ["persona"], body: "P1" }),
    preset({ id: "two", title: "Two", tags: [], body: "P2" }),
  ];
  const before = JSON.stringify(catalog);
  const settings = { ...defaultPurgeSettings(), skill_dir: join(tempDir("preset-pure-"), "s") };
  applyPresetTo(catalog, settings, "one", "structured_template", true);
  applyPresetTo(catalog, settings, "two", "skill_file");
  assert.equal(JSON.stringify(catalog), before);
  assert.equal(catalog[0].body, "P1");
});
