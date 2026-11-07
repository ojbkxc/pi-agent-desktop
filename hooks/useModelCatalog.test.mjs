import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_MODEL_CATALOG,
  buildModelCatalog,
  modelRef,
  parseEnabledInfo,
  parseModelList,
} from "./useModelCatalog.ts";

const MODELS_PAYLOAD = {
  models: { "zenmux/claude-sonnet": "Claude Sonnet" },
  modelList: [
    { id: "claude-sonnet", name: "Claude Sonnet", provider: "zenmux" },
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
    { id: "claude-opus", name: "Claude Opus", provider: "zenmux" },
  ],
  defaultModel: { provider: "zenmux", modelId: "claude-sonnet" },
};

const ENABLED_PAYLOAD = {
  allEnabled: false,
  providers: [
    { id: "zenmux", models: [
      { ref: "zenmux/claude-sonnet", enabled: true },
      { ref: "zenmux/claude-opus", enabled: false },
    ] },
    { id: "openai", models: [{ ref: "openai/gpt-5", enabled: true }] },
  ],
};

test("modelRef uses the provider/modelId form team_create expects", () => {
  assert.equal(modelRef("zenmux", "claude-sonnet"), "zenmux/claude-sonnet");
  assert.equal(modelRef("provider", "nested/model-id"), "provider/nested/model-id");
});

test("parseModelList keeps valid rows, drops malformed ones, falls back to id for a missing name", () => {
  const parsed = parseModelList({
    modelList: [
      { id: "a", name: "Alpha", provider: "p" },
      { id: "b", provider: "p" },              // 缺 name → 用 id
      { id: "", name: "x", provider: "p" },    // 缺 id → 丢
      { name: "y", provider: "p" },            // 缺 id → 丢
      { id: "c", name: "C" },                  // 缺 provider → 丢
      null,
      "nope",
    ],
  });
  assert.deepEqual(parsed, [
    { id: "a", name: "Alpha", provider: "p" },
    { id: "b", name: "b", provider: "p" },
  ]);
  assert.deepEqual(parseModelList(null), []);
  assert.deepEqual(parseModelList({ modelList: "x" }), []);
});

test("parseEnabledInfo reads enabled refs, honours allEnabled, rejects junk", () => {
  const info = parseEnabledInfo(ENABLED_PAYLOAD);
  assert.ok(info);
  assert.equal(info.all, false);
  assert.deepEqual([...info.refs].sort(), ["openai/gpt-5", "zenmux/claude-sonnet"]);

  assert.equal(parseEnabledInfo({ allEnabled: true, providers: [] })?.all, true);
  assert.equal(parseEnabledInfo(null), null);
  assert.equal(parseEnabledInfo({}), null);
  assert.equal(parseEnabledInfo({ providers: "nope" }), null);
});

test("buildModelCatalog merges the two endpoints, groups by provider and counts enabled", () => {
  const catalog = buildModelCatalog(MODELS_PAYLOAD, ENABLED_PAYLOAD);
  assert.equal(catalog.hasEnabledInfo, true);
  assert.equal(catalog.enabledCount, 2);
  assert.deepEqual(catalog.entries.map((entry) => entry.ref), [
    "zenmux/claude-opus",
    "zenmux/claude-sonnet",
    "openai/gpt-5",
  ], "按 name 自然序（Claude Opus 在 Claude Sonnet 前，openai 的 GPT-5 次之）");

  const opus = catalog.entries.find((entry) => entry.ref === "zenmux/claude-opus");
  assert.equal(opus?.enabled, false);
  assert.equal(opus?.name, "Claude Opus");

  assert.deepEqual(catalog.groups.map((group) => group.provider), ["openai", "zenmux"], "provider 自然序");
  const zenmux = catalog.groups.find((group) => group.provider === "zenmux");
  assert.equal(zenmux?.models.length, 2);
  assert.equal(zenmux?.enabledCount, 1);
});

test("buildModelCatalog degrades to all-enabled when the enabled endpoint is unavailable", () => {
  const catalog = buildModelCatalog(MODELS_PAYLOAD, null);
  assert.equal(catalog.hasEnabledInfo, false);
  assert.ok(catalog.entries.every((entry) => entry.enabled), "无启用信息时全部按已启用");
  assert.equal(catalog.enabledCount, catalog.entries.length);
});

test("buildModelCatalog honours allEnabled and returns the empty catalog for no models", () => {
  const all = buildModelCatalog(MODELS_PAYLOAD, { allEnabled: true, providers: [] });
  assert.ok(all.entries.every((entry) => entry.enabled));

  assert.deepEqual(buildModelCatalog({ modelList: [] }, ENABLED_PAYLOAD), {
    ...EMPTY_MODEL_CATALOG,
    hasEnabledInfo: true,
  });
  assert.deepEqual(buildModelCatalog(null, null), EMPTY_MODEL_CATALOG);
});
