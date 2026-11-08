import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Schema consistency lock.
 *
 * The compaction settings schema deliberately lives in two places:
 * - `lib/compaction-settings-api.ts` — the API/UI contract, which must stay
 *   independently importable and therefore cannot import the runtime module;
 * - `lib/compaction-policy.ts` — the runtime that applies the policy.
 *
 * Both parse the same `compactionPolicy` block out of the same file. If they
 * ever disagree, the settings page would show one policy while a session
 * applied another. This test imports BOTH modules read-only and asserts their
 * constants, defaults, and tolerant-read behaviour are identical. It does not
 * modify either file; it fails the build when a change lands in only one.
 *
 * This file is owned by the threshold/policy task; `compaction-settings-api.ts`
 * is owned by the settings API/UI task.
 */

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const runtime = await jiti.import("./compaction-policy.ts");
const contract = await jiti.import("./compaction-settings-api.ts");

test("both modules export identical schema constants", () => {
  assert.deepEqual([...runtime.COMPACTION_MODES], [...contract.COMPACTION_MODES], "COMPACTION_MODES");
  assert.deepEqual(
    [...runtime.COMPACTION_MODEL_CHOICES],
    [...contract.COMPACTION_MODEL_CHOICES],
    "COMPACTION_MODEL_CHOICES",
  );
  assert.equal(runtime.KEEP_RECENT_TOKENS_DEFAULT, contract.KEEP_RECENT_TOKENS_DEFAULT, "keepRecent default");
  assert.equal(runtime.KEEP_RECENT_TOKENS_MIN, contract.KEEP_RECENT_TOKENS_MIN, "keepRecent min");
  assert.equal(runtime.KEEP_RECENT_TOKENS_MAX, contract.KEEP_RECENT_TOKENS_MAX, "keepRecent max");
  assert.equal(runtime.MAX_PREFERRED_MODELS, contract.MAX_PREFERRED_MODELS, "preferredModels cap");
});

test("both modules produce the same default policy, as independent objects", () => {
  const fromRuntime = runtime.defaultCompactionPolicy();
  const fromContract = contract.defaultCompactionPolicy();
  assert.deepEqual(fromRuntime, fromContract, "default policy output");
  assert.deepEqual(fromRuntime, {
    mode: "balanced",
    keepRecentTokens: 65_536,
    compactionModel: "auto",
    preferredModels: [],
  }, "the plan's documented defaults");
  assert.notEqual(fromRuntime, fromContract, "neither module hands out a shared object");
});

test("both modules expose the same model-ref rule", () => {
  const inputs = [
    "p/m",
    "openrouter/vendor/model",
    "a/",
    "/b",
    "bad",
    "",
    "p/m with space",
    "p/m\t",
    "p/\u0000m",
    `p/${"x".repeat(200)}`,
  ];
  for (const value of inputs) {
    assert.equal(
      runtime.isCompactionModelRef(value),
      contract.isCompactionModelRef(value),
      `isCompactionModelRef(${JSON.stringify(value.slice(0, 20))})`,
    );
  }
});

/**
 * One table drives both modules. Every entry is compared with `deepEqual`, so
 * a field that silently resets differently on one side turns the test red.
 */
const MALFORMED_INPUTS = [
  ["undefined", undefined],
  ["null", null],
  ["a bare string", "balanced"],
  ["an array", []],
  ["an unknown mode", { mode: "turbo" }],
  ["a non-string mode", { mode: 7 }],
  ["an unknown compactionModel", { compactionModel: "cheapest" }],
  ["a non-string compactionModel", { compactionModel: false }],
  ["keepRecent below the minimum", { keepRecentTokens: 1_000 }],
  ["keepRecent above the maximum", { keepRecentTokens: 999_999_999 }],
  ["a fractional keepRecent", { keepRecentTokens: 65_536.5 }],
  ["a string keepRecent", { keepRecentTokens: "65536" }],
  ["a negative keepRecent", { keepRecentTokens: -1 }],
  ["a NaN keepRecent", { keepRecentTokens: Number.NaN }],
  ["an Infinity keepRecent", { keepRecentTokens: Number.POSITIVE_INFINITY }],
  ["preferredModels as a string", { preferredModels: "zenmux/x" }],
  ["9 preferredModels", { preferredModels: Array.from({ length: 9 }, (_, i) => `p/m${i}`) }],
  ["8 preferredModels", { preferredModels: Array.from({ length: 8 }, (_, i) => `p/m${i}`) }],
  ["a non-string preferredModels member", { preferredModels: ["p/m", 7] }],
  ["a malformed preferredModels member", { preferredModels: ["p/m", "bad"] }],
  ["a preferredModels member without a provider", { preferredModels: ["/m"] }],
  ["a preferredModels member without an id", { preferredModels: ["p/"] }],
  ["duplicate preferredModels", { preferredModels: ["p/m", " p/m "] }],
  ["fully valid", { mode: "long", keepRecentTokens: 131_072, compactionModel: "preferred", preferredModels: ["p/m"] }],
];

test("both modules normalize every malformed input identically", () => {
  for (const [label, input] of MALFORMED_INPUTS) {
    assert.deepEqual(
      runtime.normalizeCompactionPolicy(input),
      contract.normalizeCompactionPolicy(input),
      `normalizeCompactionPolicy: ${label}`,
    );
  }
});

test("neither module mutates the input it is given", () => {
  for (const [label, input] of MALFORMED_INPUTS) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) continue;
    const snapshot = structuredClone(input);
    runtime.normalizeCompactionPolicy(input);
    contract.normalizeCompactionPolicy(input);
    assert.deepEqual(input, snapshot, `input preserved: ${label}`);
  }
});