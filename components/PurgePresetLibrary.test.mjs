import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const repoRoot = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8").replace(/\r\n/g, "\n");
const componentSource = read("components/PurgePresetLibrary.tsx");
const consoleSource = read("components/PurgeConsoleSection.tsx");
const cssSource = read("app/native-theme.css");

// Plain-TS imports need no JSX; the component and the i18n provider go through
// one JSX-aware loader so both resolve `@/hooks/useI18n` to the same module (and
// therefore the same React context).
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");

const renderJiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const library = await renderJiti.import("./PurgePresetLibrary.tsx");
const { I18nProvider } = await renderJiti.import("@/hooks/useI18n");

/** First paint: no effect has run, so the library has not fetched anything. */
function renderFirstPaint() {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(library.PurgePresetLibrary),
  ));
  // React escapes text nodes, so compare against decoded markup: a message that
  // contains an apostrophe renders as `&#x27;` and would never match verbatim.
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const BRIEF = {
  id: "zhipu-glm-5-2",
  vendor: "Zhipu AI",
  model: "GLM-5.2",
  title: "GLM-5.2 system prompt",
  tags: ["system", "glm"],
  bytes: 4096,
  sha256: "a".repeat(64),
  preview: "# GLM-5.2\n\nYou are …",
};

const DETAIL = { ...BRIEF, body: "# GLM-5.2\n\nYou are a helpful assistant.\n" };

test("the HTTP contract is declared once: paths, limits and the search debounce", () => {
  assert.equal(library.PRESET_LIST_PATH, "/api/purge/presets");
  assert.equal(library.PRESET_DEFAULT_LIMIT, 50);
  assert.equal(library.PRESET_MAX_LIMIT, 500);
  assert.equal(library.PRESET_PREVIEW_CHARS, 200);
  assert.equal(library.PRESET_SEARCH_DEBOUNCE_MS, 250);
  // The two live targets, in the order the spec lists them.
  assert.deepEqual([...library.PURGE_PRESET_TARGETS], ["structured_template", "skill_file"]);
  // The server's own constants, so the client does not drift from the route.
  assert.match(componentSource, /const PRESET_SEARCH_DEBOUNCE_MS = 250/);
});

test("presetListQuery omits blank filters and clamps the page size", () => {
  assert.equal(library.presetListQuery(), "/api/purge/presets");
  assert.equal(library.presetListQuery({}), "/api/purge/presets");
  assert.equal(library.presetListQuery({ q: "   " }), "/api/purge/presets");
  assert.equal(library.presetListQuery({ q: " glm " }), "/api/purge/presets?q=glm");
  assert.equal(
    library.presetListQuery({ q: "glm 5.2", vendor: "Zhipu AI" }),
    "/api/purge/presets?q=glm+5.2&vendor=Zhipu+AI",
  );
  // A blank vendor is "no filter", not `vendor=`.
  assert.equal(library.presetListQuery({ vendor: "  " }), "/api/purge/presets");
  assert.equal(library.presetListQuery({ limit: 0 }), "/api/purge/presets?limit=1");
  assert.equal(library.presetListQuery({ limit: 9_999 }), "/api/purge/presets?limit=500");
  assert.equal(library.presetListQuery({ limit: 12.6 }), "/api/purge/presets?limit=13");
  assert.equal(library.presetListQuery({ limit: Number.NaN }), "/api/purge/presets");
  assert.equal(library.presetListQuery({ limit: null }), "/api/purge/presets");
});

test("detail and apply paths encode the id", () => {
  assert.equal(library.presetDetailPath("glm-5-2"), "/api/purge/presets/glm-5-2");
  assert.equal(library.presetApplyPath("glm-5-2"), "/api/purge/presets/glm-5-2/apply");
  // A hostile id must not escape into the path: it is a URL segment, always encoded.
  assert.equal(library.presetDetailPath("../etc/passwd"), "/api/purge/presets/..%2Fetc%2Fpasswd");
  assert.equal(library.presetApplyPath("a b"), "/api/purge/presets/a%20b/apply");
});

test("clampPresetLimit mirrors the server range", () => {
  const { clampPresetLimit, PRESET_DEFAULT_LIMIT: fallback, PRESET_MAX_LIMIT: max } = library;
  assert.equal(clampPresetLimit(1), 1);
  assert.equal(clampPresetLimit(0), 1);
  assert.equal(clampPresetLimit(-20), 1);
  assert.equal(clampPresetLimit(max), max);
  assert.equal(clampPresetLimit(max + 1), max);
  assert.equal(clampPresetLimit(" 42 "), 42);
  for (const value of [undefined, null, "", "   ", "12abc", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(clampPresetLimit(value), fallback);
  }
});

test("applyPresetBody only ever sends the two documented targets", () => {
  assert.deepEqual(library.applyPresetBody("skill_file"), { target: "skill_file", activate: false });
  assert.deepEqual(library.applyPresetBody("structured_template"), {
    target: "structured_template",
    activate: false,
  });
  // `activate` is a strict boolean, never a truthy string from a form.
  assert.deepEqual(library.applyPresetBody("structured_template", "yes"), {
    target: "structured_template",
    activate: false,
  });
  assert.equal(library.applyPresetBody("structured_template", true).activate, true);
});

test("previewOf splits by code point, so a multi-byte glyph is never cut in half", () => {
  const { previewOf, PRESET_PREVIEW_CHARS: limit } = library;
  // A pure-CJK body would panic a byte-slice implementation; code points are safe.
  const chinese = "破甲".repeat(300);
  const preview = previewOf(chinese);
  assert.equal(Array.from(preview).length, limit + 1, "limit characters plus the ellipsis");
  assert.ok(preview.endsWith("…"));
  assert.equal(preview.startsWith("破甲"), true);

  // Emoji are surrogate pairs: Array.from counts one, `slice` would split them.
  const emoji = "🛡️".repeat(10);
  const cut = previewOf(emoji, 3);
  assert.equal(cut, `${Array.from(emoji).slice(0, 3).join("")}…`);
  assert.equal(cut.includes("\uFFFD"), false);

  // Under the limit the text is returned untouched (no ellipsis, no trim).
  assert.equal(previewOf("short body"), "short body");
  assert.equal(previewOf("  spaced  "), "  spaced  ");
  assert.equal(previewOf("x".repeat(limit)), "x".repeat(limit), "exactly at the limit is not cut");
  assert.equal(previewOf("x".repeat(limit + 1)), `${"x".repeat(limit)}…`);
  // Garbage input reads as the empty preview rather than throwing.
  assert.equal(previewOf(undefined), "");
  assert.equal(previewOf(null), "");
  assert.equal(previewOf("abc", 0), "abc", "a non-positive limit falls back to the default");
});

test("formatPresetBytes is locale-aware and never shows a negative size", () => {
  assert.equal(library.formatPresetBytes(0, "en"), "0 B");
  assert.equal(library.formatPresetBytes(812, "en"), "812 B");
  assert.equal(library.formatPresetBytes(1023, "en"), "1,023 B");
  assert.equal(library.formatPresetBytes(1024, "en"), "1.0 KB");
  assert.equal(library.formatPresetBytes(1434, "en"), "1.4 KB");
  assert.equal(library.formatPresetBytes(-5, "en"), "0 B");
  assert.equal(library.formatPresetBytes(Number.NaN, "en"), "0 B");
  // zh-CN groups by 3 but prints the unit the same way.
  assert.equal(library.formatPresetBytes(1023, "zh-CN"), "1,023 B");
});

test("shortSha keeps eight characters and tolerates junk", () => {
  assert.equal(library.shortSha("abcdef0123456789"), "abcdef01");
  assert.equal(library.shortSha("abc"), "abc");
  assert.equal(library.shortSha(undefined), "");
});

test("asPresetList reads the bare body and the AIGX envelope, and refuses an error", () => {
  const flat = library.asPresetList({ items: [BRIEF], vendors: [{ vendor: "Zhipu AI", count: 1 }], total: 1 });
  assert.deepEqual(flat, { items: [BRIEF], vendors: [{ vendor: "Zhipu AI", count: 1 }], total: 1 });
  // The same payload wrapped the way AIGX answers.
  assert.deepEqual(library.asPresetList({ data: { items: [BRIEF], vendors: [], total: 7 } }), {
    items: [BRIEF],
    vendors: [],
    total: 7,
  });

  // Rows without an id are dropped, the rest are normalized field by field.
  const mixed = library.asPresetList({
    items: [
      BRIEF,
      { title: "no id" },
      null,
      "junk",
      { id: "  " },
      { id: "minimal" },
    ],
    vendors: [{ vendor: "  ", count: 3 }, { vendor: "Only", count: "7" }, "junk"],
    total: "9",
  });
  assert.deepEqual(mixed.items.map((item) => item.id), ["zhipu-glm-5-2", "minimal"]);
  assert.deepEqual(mixed.items[1], {
    id: "minimal",
    vendor: "",
    model: "",
    title: "",
    tags: [],
    bytes: 0,
    sha256: "",
    preview: "",
  });
  assert.deepEqual(mixed.vendors, [{ vendor: "Only", count: 0 }]);
  assert.equal(mixed.total, 2, "a non-number total falls back to the page length");

  // An error envelope is not an empty list: the caller must show "failed", not "no match".
  assert.equal(library.asPresetList(null), null);
  assert.equal(library.asPresetList({}), null);
  assert.equal(library.asPresetList({ error: "boom" }), null);
  assert.equal(library.asPresetList({ items: "nope" }), null);
  assert.equal(library.asPresetList("nope"), null);
  assert.deepEqual(library.asPresetList({ items: [] }), { items: [], vendors: [], total: 0 });
});

test("asPresetDetail keeps the body verbatim and requires an id", () => {
  const parsed = library.asPresetDetail(DETAIL);
  assert.deepEqual(parsed, DETAIL);
  assert.equal(parsed.body.includes("\n\n"), true, "the body is never re-flowed");

  // Leading/trailing whitespace is part of the prompt; it must survive.
  const spaced = library.asPresetDetail({ id: "x", body: "\n\n# heading\n\n" });
  assert.equal(spaced.body, "\n\n# heading\n\n");
  assert.deepEqual(library.asPresetDetail({ data: { id: "y", body: "b" } }), {
    id: "y",
    vendor: "",
    model: "",
    title: "",
    tags: [],
    bytes: 0,
    sha256: "",
    preview: "",
    body: "b",
  });

  assert.equal(library.asPresetDetail({ body: "no id" }), null);
  assert.equal(library.asPresetDetail(null), null);
  assert.equal(library.asPresetDetail("nope"), null);
});

test("asPresetApplyResult reads the server's {result, settings} envelope", () => {
  // The real shape: `apply/route.ts` answers `{ result, settings }`.
  assert.deepEqual(
    library.asPresetApplyResult({
      result: { target: "skill_file", changed: true, path: "/skills/glm/SKILL.md" },
      settings: {},
    }),
    { applied: { target: "skill_file", name: "", path: "/skills/glm/SKILL.md" } },
  );
  // structured_template carries the template name in `template` and no path.
  assert.deepEqual(
    library.asPresetApplyResult({
      result: { target: "structured_template", changed: true, template: "GLM" },
      settings: {},
    }),
    { applied: { target: "structured_template", name: "GLM", path: null } },
  );
  // An empty path reads as null rather than an empty string.
  assert.deepEqual(
    library.asPresetApplyResult({ result: { target: "skill_file", path: "" }, settings: {} }).applied,
    { target: "skill_file", name: "", path: null },
  );
  assert.equal(library.asPresetApplyResult({}), null);
  // The old `{ applied }` envelope must not be treated as success: that mismatch
  // is exactly what made a successful disk write render as a failure.
  assert.equal(library.asPresetApplyResult({ applied: { target: "skill_file", path: "/x" } }), null);
  assert.equal(library.asPresetApplyResult({ result: "nope" }), null);
  assert.equal(library.asPresetApplyResult(null), null);
});

test("upsertPresetTemplate replaces by name, appends otherwise, and never mutates", () => {
  const start = [{ name: "a", text: "one" }];
  assert.deepEqual(library.upsertPresetTemplate(start, "a", "two"), [{ name: "a", text: "two" }]);
  assert.deepEqual(start, [{ name: "a", text: "one" }], "the input array must not be mutated");

  const appended = library.upsertPresetTemplate(start, "b", "three");
  assert.deepEqual(appended, [{ name: "a", text: "one" }, { name: "b", text: "three" }]);
  assert.equal(appended.length, 2);
  assert.equal(start.length, 1);

  // Names are trimmed; a blank name is a no-op copy rather than an empty template.
  assert.deepEqual(library.upsertPresetTemplate([], "  b  ", "x"), [{ name: "b", text: "x" }]);
  assert.deepEqual(library.upsertPresetTemplate(start, "   ", "x"), [{ name: "a", text: "one" }]);

  // Applying the same preset twice is idempotent (the name is the identity).
  const twice = library.upsertPresetTemplate(library.upsertPresetTemplate([], "a", "1"), "a", "1");
  assert.deepEqual(twice, [{ name: "a", text: "1" }]);
});

test("unwrapPayload reads both envelopes and leaves a bare body alone", () => {
  assert.deepEqual(library.unwrapPayload({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(library.unwrapPayload({ a: 1 }), { a: 1 });
  assert.deepEqual(library.unwrapPayload({ data: "scalar" }), { data: "scalar" });
  assert.equal(library.unwrapPayload(null), null);
});

test("first paint renders the compliance notice, the search box and a loading state", () => {
  const html = renderFirstPaint();
  const messages = getLocalePlugin("en").messages;
  assert.match(html, new RegExp(`<h3[^>]*>${messages["purge.presetsHeading"]}</h3>`));
  // 授权边界常驻可见，不是可关闭的 toast。
  assert.ok(html.includes(messages["purge.presetsNotice"]));
  assert.match(html, /settings-preset-notice/);
  assert.match(html, /type="search"/);
  assert.ok(html.includes(`aria-label="${messages["purge.presetsSearchAria"]}"`));
  assert.ok(html.includes(`aria-label="${messages["purge.presetsFilterAria"]}"`));
  // No fetch has answered yet: the list says so instead of claiming "no match".
  assert.ok(html.includes(messages["purge.presetsLoading"]));
  assert.equal(html.includes(messages["purge.presetsEmpty"]), false);
  assert.equal(html.includes("purge-preset-item"), false, "no row before the first answer");
  // The "all vendors" chip is there from the start.
  assert.ok(html.includes(messages["purge.presetsAllVendors"]));
});

test("the panel never auto-saves: it only GETs and POSTs to /apply", () => {
  // Browse/detail are reads; the only write is the skill-file apply.
  assert.match(componentSource, /doFetch\(url, \{ cache: "no-store" \}\)/);
  assert.match(componentSource, /presetDetailPath\(/);
  assert.match(componentSource, /presetApplyPath\(/);
  assert.match(componentSource, /JSON\.stringify\(applyPresetBody\("skill_file"\)\)/);
  // The template action hands the body to the host and never PUTs.
  assert.match(componentSource, /onApplyTemplate\?\.\(full\.title, full\.body\)/);
  assert.equal(/method: "PUT"|method: "PATCH"|method: "DELETE"/.test(componentSource), false);
  // No optimistic write: the host owns the draft, the console owns the save.
  assert.equal(/\/api\/purge"/.test(componentSource), false);
  // The console is what renders it, above the rewrite tables.
  assert.match(consoleSource, /import \{ PurgePresetLibrary, upsertPresetTemplate \} from "\.\/PurgePresetLibrary"/);
  assert.match(consoleSource, /<PurgePresetLibrary\s+[^>]*onApplyTemplate=\{applyPresetTemplate\}/);
  // 控制台只取一次 auto-preset 预览（GET）：默认模型标识与「将套用哪条」来自同一份回答，
// 不再单独请求 active-model；这次读取必须是 GET，不得写成任何写方法。
  assert.match(consoleSource, /fetch\("\/api\/purge\/auto-preset", \{ cache: "no-store" \}\)/);
  assert.equal(/fetch\("\/api\/purge\/active-model"/.test(consoleSource), false);
  assert.match(consoleSource, /upsertPresetTemplate\(draft\.structured_templates, name, text\)/);
});

test("every control is a button or a labelled field, and there are no emoji", () => {
  const html = renderFirstPaint();
  assert.equal(/<select\b|<datalist\b/.test(componentSource), false, "no native select");
  assert.equal(/<div[^>]*onClick=/.test(componentSource), false, "clickable rows must be buttons");
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(componentSource), false, "no emoji");
  // The four testids the spec pins, plus an aria label on the search field.
  for (const id of ["purge-preset-item", "purge-preset-preview", "purge-preset-apply-template", "purge-preset-apply-skill"]) {
    assert.match(componentSource, new RegExp(`data-testid="${id}"`), id);
  }
  assert.match(componentSource, /aria-label=\{t\("purge\.presetsSearchAria"\)\}/);
  // The preview block is the only place a full body is rendered, and it marks loading.
  assert.match(componentSource, /aria-busy=\{detailState === "loading"\}/);
  assert.match(html, /aria-busy="false"/);
});

test("every preset translation key exists in all three language packs", () => {
  const locales = getSupportedLocales();
  assert.deepEqual(locales, ["en", "zh-CN", "zh-TW"]);
  const packs = Object.fromEntries(locales.map((locale) => [locale, getLocalePlugin(locale).messages]));

  const literalKeys = [...componentSource.matchAll(/\bt\("(purge\.[A-Za-z]+)"/g)].map((match) => match[1]);
  const declared = [...library.PURGE_PRESET_MESSAGE_KEYS];
  // Every literal t() key is declared, so a new line of copy cannot skip the list.
  for (const key of literalKeys) {
    assert.ok(declared.includes(key), `${key} is rendered but not declared in PURGE_PRESET_MESSAGE_KEYS`);
  }
  assert.ok(declared.length >= 30, `expected the preset key set, got ${declared.length}`);

  for (const locale of locales) {
    for (const key of declared) {
      assert.equal(typeof packs[locale][key], "string", `${locale} is missing ${key}`);
      assert.ok(packs[locale][key].trim().length > 0, `${locale}.${key} is empty`);
    }
  }

  // Placeholders line up across languages, or interpolation would print `{total}`.
  const placeholders = (message) => [...message.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();
  for (const key of declared) {
    assert.deepEqual(placeholders(packs["zh-CN"][key]), placeholders(packs.en[key]), `zh-CN.${key} placeholders`);
    assert.deepEqual(placeholders(packs["zh-TW"][key]), placeholders(packs.en[key]), `zh-TW.${key} placeholders`);
  }

  // The console's own template block is translated too, not just the library.
  const consoleKeys = [...consoleSource.matchAll(/\bt\("(purge\.presets[A-Za-z]+)"/g)].map((m) => m[1]);
  for (const key of consoleKeys) {
    for (const locale of locales) {
      assert.equal(typeof packs[locale][key], "string", `${locale} is missing ${key} (console)`);
    }
  }
});

test("every preset class has a rule in app/native-theme.css", () => {
  const classes = new Set();
  for (const match of componentSource.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    // Drop `${…}` expressions first: a conditional class is still a static class.
    const value = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const token of value.split(/\s+/)) {
      if (token.startsWith("settings-preset")) classes.add(token);
    }
  }
  assert.ok(classes.size >= 15, `expected the panel's class set, got ${[...classes].join(", ")}`);
  for (const name of classes) {
    assert.match(cssSource, new RegExp(`\\.${name}\\b`), `${name} has no rule in app/native-theme.css`);
  }
  // New rules never add `!important` (scripts/native-theme-important-baseline.test.mjs).
  assert.equal(/settings-preset[^}]*!important/.test(cssSource), false);
});
