import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  COMPACTION_LIMITS,
  defaultCompactionPolicy,
  isCompactionModelRef,
  normalizeCompactionPolicy,
  readCompactionPolicy,
  toCompactionModelCandidates,
  validateCompactionPolicyPatch,
  writeCompactionPolicy,
} = await jiti.import("./compaction-settings-api.ts");

function tempSettingsPath() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-compaction-settings-"));
  const path = join(dir, "pi-web", "settings.json");
  mkdirSync(join(dir, "pi-web"));
  return path;
}

test("defaults match the fixed v0.8.2 schema", () => {
  assert.deepEqual(defaultCompactionPolicy(), {
    mode: "balanced",
    keepRecentTokens: 65536,
    compactionModel: "auto",
    preferredModels: [],
  });
  assert.deepEqual(COMPACTION_LIMITS, {
    keepRecentTokens: { min: 16384, max: 262144, default: 65536 },
    preferredModels: { max: 8 },
  });
});

test("an absent or unreadable file reads as the defaults", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "pi-web-compaction-missing-")), "pi-web", "settings.json");
  assert.deepEqual(readCompactionPolicy(missing), defaultCompactionPolicy());

  const path = tempSettingsPath();
  writeFileSync(path, "{not json");
  assert.deepEqual(readCompactionPolicy(path), defaultCompactionPolicy());
});

test("every malformed field falls back on its own, keeping the readable ones", () => {
  assert.deepEqual(normalizeCompactionPolicy({
    mode: "wild",
    keepRecentTokens: 100,
    compactionModel: "cheap",
    preferredModels: ["nope"],
  }), defaultCompactionPolicy());

  assert.deepEqual(normalizeCompactionPolicy({
    mode: "long",
    keepRecentTokens: 262144,
    compactionModel: "preferred",
    preferredModels: ["openrouter/anthropic/claude", "openai/gpt-5"],
  }), {
    mode: "long",
    keepRecentTokens: 262144,
    compactionModel: "preferred",
    preferredModels: ["openrouter/anthropic/claude", "openai/gpt-5"],
  });

  // Out-of-range / wrong-typed values fall back per field, not the whole block.
  assert.deepEqual(normalizeCompactionPolicy({ mode: "native", keepRecentTokens: 65536.5 }), {
    mode: "native",
    keepRecentTokens: 65536,
    compactionModel: "auto",
    preferredModels: [],
  });
  assert.deepEqual(normalizeCompactionPolicy({ preferredModels: Array(9).fill("a/b") }), {
    mode: "balanced",
    keepRecentTokens: 65536,
    compactionModel: "auto",
    preferredModels: [],
  });
});

test("provider/modelId references require a non-empty provider and model id", () => {
  assert.equal(isCompactionModelRef("openai/gpt-5"), true);
  assert.equal(isCompactionModelRef("openrouter/anthropic/claude-4"), true);
  assert.equal(isCompactionModelRef("/gpt-5"), false);
  assert.equal(isCompactionModelRef("openai/"), false);
  assert.equal(isCompactionModelRef("openai"), false);
  assert.equal(isCompactionModelRef("open ai/gpt"), false);
});

test("PUT validation accepts a valid partial patch and trims model refs", () => {
  assert.deepEqual(validateCompactionPolicyPatch({ mode: "long" }), { ok: true, patch: { mode: "long" } });
  assert.deepEqual(validateCompactionPolicyPatch({ compactionModel: "preferred" }), {
    ok: true,
    patch: { compactionModel: "preferred" },
  });
  assert.deepEqual(validateCompactionPolicyPatch({ keepRecentTokens: 16384 }), {
    ok: true,
    patch: { keepRecentTokens: 16384 },
  });
  assert.deepEqual(validateCompactionPolicyPatch({ keepRecentTokens: 262144 }), {
    ok: true,
    patch: { keepRecentTokens: 262144 },
  });
  assert.deepEqual(validateCompactionPolicyPatch({ preferredModels: [" openai/gpt-5 ", "acme/fast"] }), {
    ok: true,
    patch: { preferredModels: ["openai/gpt-5", "acme/fast"] },
  });
  assert.deepEqual(validateCompactionPolicyPatch({ preferredModels: [] }), { ok: true, patch: { preferredModels: [] } });
});

test("PUT validation refuses bad bodies, unknown keys and out-of-range values", () => {
  const message = (body) => {
    const result = validateCompactionPolicyPatch(body);
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(body)}`);
    return result.error;
  };

  assert.match(message(null), /JSON object/);
  assert.match(message(["mode"]), /JSON object/);
  assert.match(message({}), /No compaction settings/);
  assert.match(message({ compact: "balanced" }), /Unknown compaction setting: compact/);
  assert.match(message({ mode: "cheap" }), /mode must be one of balanced, long, native/);
  assert.match(message({ compactionModel: "free" }), /compactionModel must be one of auto, current, preferred/);
  assert.match(message({ keepRecentTokens: 16383 }), /between 16384 and 262144/);
  assert.match(message({ keepRecentTokens: 262145 }), /between 16384 and 262144/);
  assert.match(message({ keepRecentTokens: "65536" }), /between 16384 and 262144/);
  assert.match(message({ keepRecentTokens: 65536.5 }), /between 16384 and 262144/);
  assert.match(message({ preferredModels: "openai/gpt-5" }), /at most 8/);
  assert.match(message({ preferredModels: Array(9).fill("a/b") }), /at most 8/);
  assert.match(message({ preferredModels: ["gpt-5"] }), /at most 8/);
});

test("writing merges atomically: other keys and unknown policy keys survive", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({
    other: 1,
    artifactsPrompt: false,
    compactionPolicy: { mode: "long", someFutureKey: true },
  }));

  const effective = writeCompactionPolicy({ keepRecentTokens: 32768 }, path);
  assert.deepEqual(effective, {
    mode: "long",
    keepRecentTokens: 32768,
    compactionModel: "auto",
    preferredModels: [],
  });

  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.other, 1);
  assert.equal(stored.artifactsPrompt, false);
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.compactionPolicy, {
    mode: "long",
    someFutureKey: true,
    keepRecentTokens: 32768,
  });
  // And the merged value round-trips through the tolerant reader.
  assert.deepEqual(readCompactionPolicy(path), effective);
});

test("writing into a fresh file creates the block without touching anything else", () => {
  const path = tempSettingsPath();
  writeCompactionPolicy({ mode: "native", preferredModels: ["acme/flash"] }, path);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    version: 1,
    compactionPolicy: { mode: "native", preferredModels: ["acme/flash"] },
  });
});

test("candidate mapping de-duplicates, drops virtual routers and marks unconfirmed prices", () => {
  const candidates = toCompactionModelCandidates([
    { provider: "acme", id: "fast", name: "Fast", cost: { input: 0.1, output: 0.2 } },
    { provider: "acme", id: "fast", name: "Fast again", cost: { input: 0.1, output: 0.2 } },
    { provider: "acme", id: "free", name: "Free", cost: { input: 0, output: 0 } },
    { provider: "acme", id: "router", api: "pi-virtual", cost: { input: 0, output: 0 } },
    { provider: "beta", id: "b", name: "Bee", cost: undefined },
  ]);
  assert.deepEqual(candidates, [
    { provider: "acme", modelId: "fast", label: "Fast · acme", priceConfirmed: true },
    { provider: "acme", modelId: "free", label: "Free · acme", priceConfirmed: false },
    { provider: "beta", modelId: "b", label: "Bee · beta", priceConfirmed: false },
  ]);
});
