/**
 * 「模型 → 预设」查询层的规则：分隔符差异算同一个模型，厂商兜底，不猜空值。
 *
 * 最后一组用真实目录跑，因为纯夹具证明不了「DeepSeek 的预设不会出现在 qwen 的
 * 候选里」——那正是这个解析器唯一有价值的断言。
 */

import assert from "node:assert/strict";
import test from "node:test";

const { normalizeModelId, presetMatchForModel, presetsForModel } = await import("./preset-match.ts");
const { BUILTIN_PRESETS } = await import("./preset-catalog.ts");

test("大小写与分隔符差异是同一个模型", () => {
  assert.equal(normalizeModelId("DeepSeek V4"), "deepseekv4");
  assert.equal(normalizeModelId("deepseek-v4"), "deepseekv4");
  assert.equal(normalizeModelId("deepseek_v4"), "deepseekv4");
  assert.equal(presetMatchForModel({ vendor: "DeepSeek", model: "deepseek v4" }, "deepseek-v4"), "exact");
});

test("一行覆盖多个模型的写法按包含判定", () => {
  const preset = { vendor: "DeepSeek", model: "deepseekv4.1 and v4.1-1017" };
  assert.equal(presetMatchForModel(preset, "deepseek-v4.1"), "exact");
});

test("模型对不上但厂商对得上时退到 vendor", () => {
  assert.equal(presetMatchForModel({ vendor: "DeepSeek", model: "deepseek v3" }, "deepseek-v9-ultra"), "vendor");
});

test("厂商也不同就是不匹配", () => {
  assert.equal(presetMatchForModel({ vendor: "DeepSeek", model: "deepseek v4" }, "qwen3.8-flash"), "mismatch");
});

test("空值不猜，返回 unknown", () => {
  assert.equal(presetMatchForModel({ vendor: "DeepSeek", model: "" }, "deepseek-v4"), "unknown");
  assert.equal(presetMatchForModel({ vendor: "DeepSeek", model: "deepseek v4" }, ""), "unknown");
  assert.equal(presetMatchForModel({ vendor: "DeepSeek", model: "deepseek v4" }, "   "), "unknown");
});

test("exact 排在 vendor 前面，组内保持目录原序", () => {
  const catalog = [
    { vendor: "DeepSeek", model: "deepseek v3" },
    { vendor: "DeepSeek", model: "deepseek v4" },
    { vendor: "DeepSeek", model: "something else" },
  ];
  const hits = presetsForModel(catalog, "deepseek-v4");
  assert.deepEqual(
    hits.map((hit) => [hit.preset.model, hit.match]),
    [
      ["deepseek v4", "exact"],
      ["deepseek v3", "vendor"],
      ["something else", "vendor"],
    ],
  );
});

test("返回新数组，目录不被修改", () => {
  const catalog = Object.freeze([{ vendor: "DeepSeek", model: "deepseek v4" }]);
  const hits = presetsForModel(catalog, "deepseek-v4");
  assert.equal(hits.length, 1);
  assert.notEqual(hits, catalog);
  assert.equal(catalog.length, 1);
});

test("真实目录：DeepSeek 的候选不会把 qwen 预设算成 exact", () => {
  const hits = presetsForModel(BUILTIN_PRESETS, "qwen3.8-flash");
  assert.ok(hits.length > 0, "qwen3.8 应当有候选");
  for (const hit of hits) {
    if (hit.match === "exact") {
      assert.match(
        hit.preset.model.toLowerCase(),
        /qwen/,
        `${hit.preset.id} 被当成 qwen3.8 的精确匹配，但它是 ${hit.preset.model}`,
      );
    }
  }
});

test("真实目录：deepseek-v4 能命中 DeepSeek 的预设", () => {
  const hits = presetsForModel(BUILTIN_PRESETS, "deepseek-v4");
  const models = hits.filter((hit) => hit.match === "exact").map((hit) => hit.preset.model);
  assert.ok(models.length > 0, "deepseek-v4 应当命中至少一个 exact 预设");
  assert.ok(
    models.some((model) => normalizeModelId(model) === "deepseekv4"),
    `期望包含 deepseek v4，实际命中：${models.join(" | ")}`,
  );
});
