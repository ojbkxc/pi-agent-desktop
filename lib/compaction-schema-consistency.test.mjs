import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const modelSelect = await jiti.import("./compaction-model-select.ts");

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

// ---------------------------------------------------------------------------
// Cross-module contract: what a model's `cost` metadata means
// ---------------------------------------------------------------------------

/**
 * `cost` metadata is read by three consumers that ask different questions, and
 * the settings contract's `priceConfirmed === false` is the UNION of every
 * "we cannot vouch for a positive price" case — it is NOT the same predicate as
 * the runtime's "usable as a free candidate".
 *
 * | cost                       | assessCompactionModelPrice | auto candidate chain    | UI priceConfirmed |
 * | -------------------------- | -------------------------- | ----------------------- | ----------------- |
 * | `{input:0,output:0}`       | `free` (confirmed)         | in `confirmed-free`     | `false`           |
 * | `{cacheRead:0.1}`          | `unknown`                  | not offered             | `false`           |
 * | no `cost` field            | `unknown`                  | not offered             | `false`           |
 * | `{input:0.25,output:1.5}`  | `low` (confirmed)          | not offered (not flash) | `true`            |
 *
 * The two questions:
 * - UI (`lib/compaction-settings-api.ts`): "did the user declare a positive
 *   price?" No → warn that the cost is undeclared.
 * - runtime (`lib/compaction-model-select.ts`): "may this be used as a free
 *   candidate?" The plan's rule ("input/output both 0") says yes for a literal
 *   0/0.
 *
 * The SDK writes `{ input: 0, output: 0 }` for a configured model with no
 * `cost` block (provider-composer), so a literal 0/0 means "cost undeclared".
 * Both behaviours are correct, which is why the assertions below pin the
 * CONTAINMENT (every free candidate is also unconfirmed) rather than an
 * equivalence — an equivalence would force one side to adopt the other's
 * semantics. The partial-metadata bucket is the trap: if `undefined` were ever
 * coerced to `0`, that row would silently join the free chain.
 */
const PRICE_BUCKETS = [
  {
    label: "literal 0/0",
    cost: { input: 0, output: 0 },
    priceKind: "free",
    priceConfirmed: true,
    freeCandidate: true,
    uiPriceConfirmed: false,
  },
  {
    label: "partially declared ({cacheRead} only)",
    cost: { cacheRead: 0.1 },
    priceKind: "unknown",
    priceConfirmed: false,
    freeCandidate: false,
    uiPriceConfirmed: false,
  },
  {
    label: "no cost block",
    cost: undefined,
    priceKind: "unknown",
    priceConfirmed: false,
    freeCandidate: false,
    uiPriceConfirmed: false,
  },
  {
    label: "low positive rate",
    cost: { input: 0.25, output: 1.5 },
    priceKind: "low",
    priceConfirmed: true,
    freeCandidate: false,
    uiPriceConfirmed: true,
  },
];

/** A model whose id/name carries no "free"-sounding hint, so only the price decides. */
function pricedModel(cost) {
  return {
    provider: "acme",
    id: "plain-model",
    name: "Plain Model",
    api: "openai-completions",
    type: "chat",
    contextWindow: 200_000,
    ...(cost === undefined ? {} : { cost }),
  };
}

function offeredAsFreeCandidate(model) {
  return modelSelect.selectCompactionModels({
    mainModel: null,
    availableModels: [model],
    choice: "auto",
    requestTokens: 1_000,
  }).some((candidate) => candidate.tier === "confirmed-free");
}

test("cost buckets: each raw metadata shape lands where the table says", () => {
  for (const bucket of PRICE_BUCKETS) {
    const model = pricedModel(bucket.cost);
    const price = modelSelect.assessCompactionModelPrice(model);
    assert.equal(price.kind, bucket.priceKind, `${bucket.label}: price kind`);
    assert.equal(price.confirmed, bucket.priceConfirmed, `${bucket.label}: price confirmed`);
    assert.equal(offeredAsFreeCandidate(model), bucket.freeCandidate, `${bucket.label}: offered free`);
    assert.equal(
      contract.toCompactionModelCandidates([model])[0].priceConfirmed,
      bucket.uiPriceConfirmed,
      `${bucket.label}: UI priceConfirmed`,
    );
  }
});

test("UI `priceConfirmed === false` is a strict SUPERSET of the free-candidate set", () => {
  const rows = PRICE_BUCKETS.map((bucket) => {
    const model = pricedModel(bucket.cost);
    return {
      label: bucket.label,
      offeredFree: offeredAsFreeCandidate(model),
      unconfirmed: contract.toCompactionModelCandidates([model])[0].priceConfirmed === false,
    };
  });

  // Containment: anything the runtime may use for free is also unconfirmed.
  for (const row of rows) {
    if (row.offeredFree) assert.equal(row.unconfirmed, true, `a free candidate must be unconfirmed: ${row.label}`);
  }
  // Strictness: some unconfirmed shapes are NOT free candidates (partial or
  // absent metadata). Without this the test would also pass for an equivalence.
  assert.ok(
    rows.some((row) => row.unconfirmed && !row.offeredFree),
    "unconfirmed is a strict superset, not an equal set",
  );
  // The other direction fails too: a confirmed row is not a free candidate, so
  // neither predicate may be derived from the other.
  assert.ok(
    rows.some((row) => !row.unconfirmed && !row.offeredFree),
    "a confirmed price is not a free candidate",
  );
});

// ---------------------------------------------------------------------------
// Write-side contract: the only writer preserves unknown keys
// ---------------------------------------------------------------------------

/**
 * This is the behaviour that changed when the runtime's duplicate writer was
 * deleted: the single writer (`lib/compaction-settings-api.ts`, used by
 * `app/api/compaction/settings`) keeps unknown keys inside `compactionPolicy`,
 * while the deleted runtime copy dropped them. A future writer that
 * "normalizes" the block would silently delete a field a newer version added —
 * this pins the merge-in-place behaviour.
 */
test("the settings writer keeps unknown keys inside compactionPolicy", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-compaction-schema-"));
  const path = join(dir, "pi-web", "settings.json");
  mkdirSync(join(dir, "pi-web"));
  writeFileSync(path, JSON.stringify({
    artifactsPrompt: false,
    compactionPolicy: { mode: "long", someFutureKey: { nested: 1 } },
  }));

  contract.writeCompactionPolicy({ keepRecentTokens: 131_072 }, path);

  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.compactionPolicy.mode, "long", "known fields merge");
  assert.equal(onDisk.compactionPolicy.keepRecentTokens, 131_072, "the patch lands");
  assert.deepEqual(
    onDisk.compactionPolicy.someFutureKey,
    { nested: 1 },
    "an unknown key inside compactionPolicy survives the write",
  );
  assert.equal(onDisk.artifactsPrompt, false, "sibling keys survive too");
});
