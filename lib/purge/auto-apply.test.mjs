/**
 * 自动套用的规则：开关优先、匹配不猜、正文不改。
 *
 * 最后一组用真实目录跑 —— 纯夹具证明不了「qwen 的模型不会拿到 deepseek 的预设」，
 * 而那正是这个功能唯一的风险点。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// auto-apply.ts 内部按打包器规则写无扩展名导入，node 的 strip-types 解析不了，
// 所以与 extension.test.mjs 一样用 jiti 加载。
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { composeAutoPreset, resolveAutoPreset } = await jiti.import("./auto-apply.ts");
const { BUILTIN_PRESETS } = await jiti.import("./preset-catalog.ts");
const { defaultPurgeSettings } = await jiti.import("./types.ts");

/** 打开总开关与自动套用的设置。 */
function settings(overrides = {}) {
  return { ...defaultPurgeSettings(), enabled: true, auto_preset: true, ...overrides };
}

const CATALOG = [
  { id: "alpha-v4", vendor: "Alpha", model: "alpha v4", body: "ALPHA BODY" },
  { id: "alpha-v3", vendor: "Alpha", model: "alpha v3", body: "ALPHA V3 BODY" },
  { id: "beta-v1", vendor: "Beta", model: "beta v1", body: "BETA BODY" },
];

test("总开关或自动套用关着时什么也不做", () => {
  assert.equal(resolveAutoPreset(CATALOG, { ...settings(), enabled: false }, "alpha-v4"), undefined);
  assert.equal(resolveAutoPreset(CATALOG, { ...settings(), auto_preset: false }, "alpha-v4"), undefined);
  assert.equal(resolveAutoPreset(CATALOG, undefined, "alpha-v4"), undefined);
});

test("同名模型命中 exact，且取目录原序的第一条", () => {
  const hit = resolveAutoPreset(CATALOG, settings(), "Alpha V4");
  assert.equal(hit.match, "exact");
  assert.equal(hit.preset.id, "alpha-v4");
  // 分隔符差异算同一个模型（见 preset-match）。
  assert.equal(resolveAutoPreset(CATALOG, settings(), "alpha_v4").preset.id, "alpha-v4");
});

test("没有同名模型时默认不套，选了 vendor 才退到同厂商", () => {
  assert.equal(resolveAutoPreset(CATALOG, settings(), "alpha-v9"), undefined);
  const hit = resolveAutoPreset(CATALOG, settings({ auto_preset_match: "vendor" }), "alpha-v9");
  assert.equal(hit.match, "vendor");
  assert.equal(hit.preset.id, "alpha-v4", "vendor 兜底也取目录原序第一条");
  // 厂商也对不上就没有。
  assert.equal(resolveAutoPreset(CATALOG, settings({ auto_preset_match: "vendor" }), "gamma-v1"), undefined);
});

test("空模型标识不猜", () => {
  for (const model of [undefined, "", "   "]) {
    assert.equal(resolveAutoPreset(CATALOG, settings(), model), undefined);
    assert.equal(resolveAutoPreset(CATALOG, settings({ auto_preset_match: "vendor" }), model), undefined);
  }
});

test("固定 id 优先于模型匹配，指向不存在的 id 时什么都不套", () => {
  const pinned = resolveAutoPreset(CATALOG, settings({ auto_preset_id: "beta-v1" }), "alpha-v4");
  assert.equal(pinned.match, "manual");
  assert.equal(pinned.preset.id, "beta-v1");

  // 没有模型也能用固定 id。
  assert.equal(resolveAutoPreset(CATALOG, settings({ auto_preset_id: "beta-v1" }), "").preset.id, "beta-v1");
  // 空白 id 等于没填，回到按模型匹配。
  assert.equal(resolveAutoPreset(CATALOG, settings({ auto_preset_id: "   " }), "alpha-v4").match, "exact");
  // 死 id 不拿别的预设顶替。
  assert.equal(resolveAutoPreset(CATALOG, settings({ auto_preset_id: "nope" }), "alpha-v4"), undefined);
});

test("拼接：前插、后附、空正文、已有正文", () => {
  assert.equal(composeAutoPreset("HOST", "BODY", "prepend"), "BODY\n\nHOST");
  assert.equal(composeAutoPreset("HOST", "BODY", "append"), "HOST\n\nBODY");
  // 空正文不改动宿主提示词。
  assert.equal(composeAutoPreset("HOST", "", "prepend"), "HOST");
  assert.equal(composeAutoPreset("HOST", "   \n ", "append"), "HOST");
  // 宿主为空（chat-only 的占位）时只发正文。
  assert.equal(composeAutoPreset("", "BODY", "prepend"), "BODY");
  assert.equal(composeAutoPreset("   ", "BODY", "append"), "BODY");
  // 已经带着这段正文就不重复拼接。
  assert.equal(composeAutoPreset("BODY\n\nHOST", "BODY", "prepend"), "BODY\n\nHOST");
});

test("真实目录：qwen 模型拿不到 deepseek 的预设", () => {
  const hit = resolveAutoPreset(BUILTIN_PRESETS, settings(), "qwen3.8-flash");
  if (hit) {
    assert.match(hit.preset.model.toLowerCase(), /qwen/, `qwen3.8 命中了 ${hit.preset.model}`);
  }
  const deepseek = resolveAutoPreset(BUILTIN_PRESETS, settings(), "deepseek-v4");
  assert.ok(deepseek, "deepseek-v4 应当命中一条预设");
  assert.equal(deepseek.match, "exact");
});
