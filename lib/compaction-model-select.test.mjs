import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  assessCompactionModelPrice,
  compactionModelFitsPreparation,
  compactionModelRef,
  hasFreeNameHint,
  isFlashCompactionModel,
  isHyCompactionModel,
  isVirtualCompactionModel,
  selectCompactionModels,
} = await jiti.import("./compaction-model-select.ts");

const WINDOW = 1_048_576;

function model(provider, id, overrides = {}) {
  return {
    provider,
    id,
    name: overrides.name ?? id,
    api: "anthropic-messages",
    type: "chat",
    cost: overrides.cost ?? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: overrides.contextWindow ?? WINDOW,
    maxTokens: overrides.maxTokens ?? 65_536,
    ...overrides,
  };
}

const free = (cost = { input: 0, output: 0 }) => cost;

function select(overrides = {}) {
  return selectCompactionModels({
    availableModels: [],
    choice: "auto",
    requestTokens: 50_000,
    ...overrides,
  });
}

const refs = (candidates) => candidates.map((candidate) => candidate.ref);

// ---------------------------------------------------------------------------
// Identity predicates
// ---------------------------------------------------------------------------

test("flash matching is case-insensitive across id and display name", () => {
  assert.equal(isFlashCompactionModel({ id: "deepseek-v4.1-flash", name: "DeepSeek" }), true);
  assert.equal(isFlashCompactionModel({ id: "x", name: "GLM-5.3-FLASH" }), true);
  assert.equal(isFlashCompactionModel({ id: "X-FlAsH", name: "X" }), true);
  assert.equal(isFlashCompactionModel({ id: "glm-5.3", name: "GLM-5.3" }), false);
});

test("hy prefix and free-name hints never claim a price by themselves", () => {
  assert.equal(isHyCompactionModel({ id: "hy4free", name: "Hy4" }), true);
  assert.equal(isHyCompactionModel({ id: "HY4std", name: "Hy4" }), true);
  assert.equal(isHyCompactionModel({ id: "hybrid-pro", name: "Hybrid Pro" }), true);
  assert.equal(isHyCompactionModel({ id: "glm-5.3", name: "GLM-5.3" }), false);
  assert.equal(hasFreeNameHint({ id: "hy4free", name: "Hy4" }), true);
  assert.equal(hasFreeNameHint({ id: "spark-x2.6", name: "Spark-X2.6 正式版(限时免费)" }), true);
  assert.equal(hasFreeNameHint({ id: "glm-5.3", name: "GLM-5.3" }), false);
  assert.equal(hasFreeNameHint({ id: "some-free-model", name: "Free" }), true);
});

test("virtual models are recognised by the pi-virtual api", () => {
  assert.equal(isVirtualCompactionModel({ api: "pi-virtual" }), true);
  assert.equal(isVirtualCompactionModel({ api: "openai-completions" }), false);
});

test("price classification distinguishes unknown, free, low and priced", () => {
  assert.equal(assessCompactionModelPrice({}).kind, "unknown");
  assert.equal(assessCompactionModelPrice({ cost: { input: 1 } }).kind, "unknown");
  assert.equal(assessCompactionModelPrice({ cost: { input: 0, output: 0 } }).kind, "free");
  assert.equal(assessCompactionModelPrice({ cost: { input: 0, output: 0 } }).confirmed, true);
  assert.equal(assessCompactionModelPrice({ cost: { input: 0.25, output: 1.5 } }).kind, "low");
  assert.equal(assessCompactionModelPrice({ cost: { input: 3, output: 15 } }).kind, "priced");
  // A wiring layer that knows a zero came from "no cost block" can distrust it.
  const distrusted = assessCompactionModelPrice(
    { id: "spark-x2.6", cost: { input: 0, output: 0 } },
    () => false,
  );
  assert.equal(distrusted.kind, "free");
  assert.equal(distrusted.confirmed, false);
});

test("window fitting reserves output room and rejects unknown windows", () => {
  assert.equal(compactionModelFitsPreparation({ contextWindow: WINDOW, maxTokens: 65_536 }, 50_000), true);
  assert.equal(compactionModelFitsPreparation({ contextWindow: 20_000, maxTokens: 16_384 }, 50_000), false);
  assert.equal(compactionModelFitsPreparation({ contextWindow: 0, maxTokens: 10 }, 1), false);
  assert.equal(compactionModelFitsPreparation({}, 1), false);
  // The reserve is capped at half the window, so a huge maxTokens cannot make
  // every candidate unusable on a large-window comparison.
  assert.equal(compactionModelFitsPreparation({ contextWindow: 30_000, maxTokens: 65_536 }, 10_000), true);
});

test("stable refs use provider + model id", () => {
  assert.equal(compactionModelRef({ provider: "API", id: "spark-x2.6" }), "API/spark-x2.6");
});

// ---------------------------------------------------------------------------
// Step 0 — main model wins when it is already cheap
// ---------------------------------------------------------------------------

const cheapMains = {
  "main model id contains flash": model("API", "deepseek-v4.1-flash", { name: "DeepSeek-V4.1-Flash" }),
  "main model display name contains Flash": model("API", "glm-5.3", { name: "GLM-5.3-Flash" }),
  "main model is priced at zero": model("API", "spark-x2.6", { cost: free() }),
  "main model is priced very low": model("API", "cheap-paid", { cost: { input: 0.1, output: 0.4 } }),
};

for (const [label, mainModel] of Object.entries(cheapMains)) {
  test(`auto keeps the main model when ${label}`, () => {
    const candidates = select({
      mainModel,
      availableModels: [
        mainModel,
        model("API", "spark-x2.6", { name: "Spark-X2.6 正式版(限时免费)", cost: free() }),
      ],
    });
    assert.deepEqual(refs(candidates), ["API/" + mainModel.id], "must not search for a cheaper model");
    assert.equal(candidates[0].tier, "main");
  });
}

test("auto keeps an expensive main model listed in preferredModels", () => {
  const main = model("API", "glm-5.3");
  const candidates = select({
    mainModel: main,
    availableModels: [main, model("API", "spark-x2.6", { cost: free() })],
    preferredModels: ["API/glm-5.3"],
  });
  assert.deepEqual(refs(candidates), ["API/glm-5.3"]);
  assert.equal(candidates[0].reason, "main-preferred");
});

test("an expensive main model falls through to the downgrade chain", () => {
  const main = model("API", "glm-5.3");
  const candidates = select({
    mainModel: main,
    availableModels: [main, model("API", "spark-x2.6", { name: "Spark-X2.6 限时免费", cost: free() })],
  });
  assert.deepEqual(refs(candidates), ["API/spark-x2.6"], "main model must not be a chain entry");
});

test("a main model that does not fit the preparation is not kept, even when cheap", () => {
  const main = model("API", "tiny-flash", { contextWindow: 8_192, maxTokens: 2_048 });
  const candidates = select({
    mainModel: main,
    availableModels: [main, model("API", "big-free", { cost: free() })],
    requestTokens: 50_000,
  });
  assert.deepEqual(refs(candidates), ["API/big-free"]);
});

// ---------------------------------------------------------------------------
// choices: current / preferred / auto chain order
// ---------------------------------------------------------------------------

test("choice current keeps only the main model", () => {
  const main = model("API", "glm-5.3");
  const candidates = select({
    mainModel: main,
    availableModels: [main, model("API", "spark-x2.6", { cost: free() })],
    choice: "current",
  });
  assert.deepEqual(refs(candidates), ["API/glm-5.3"]);
});

test("choice preferred follows the user's order and ignores everything else", () => {
  const main = model("API", "glm-5.3");
  const candidates = select({
    mainModel: main,
    availableModels: [
      main,
      model("openai", "gpt-5"),
      model("API", "spark-x2.6", { cost: free() }),
      model("API", "glm-5.3-flash"),
    ],
    choice: "preferred",
    preferredModels: ["openai/gpt-5", "API/spark-x2.6", "API/does-not-exist"],
  });
  assert.deepEqual(refs(candidates), ["openai/gpt-5", "API/spark-x2.6"]);
  assert.ok(candidates.every((candidate) => candidate.tier === "preferred"));
});

test("auto chain order: preferred, confirmed free, flash, unconfirmed name hints", () => {
  const main = model("API", "glm-5.3");
  const available = [
    main,
    model("openai", "gpt-5"),
    model("API", "spark-x2.6", { name: "Spark-X2.6 限时免费", cost: free() }),
    model("API", "hy4free", { name: "Hy4", cost: free() }),
    model("API", "glm-5.3-flash"),
    model("API", "hy4std", { name: "Hy4", cost: null }), // no cost metadata
    model("API", "some-free-model", { name: "free", cost: null }), // no cost metadata
  ];
  const candidates = select({ mainModel: main, availableModels: available, preferredModels: ["openai/gpt-5"] });
  assert.deepEqual(refs(candidates), [
    "openai/gpt-5", // explicit preference first
    "API/spark-x2.6", // spark's limited free tier outranks hy within confirmed free
    "API/hy4free",
    "API/glm-5.3-flash",
    "API/hy4std", // name hint only, unconfirmed
    "API/some-free-model",
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.tier), [
    "preferred",
    "confirmed-free",
    "confirmed-free",
    "flash",
    "unconfirmed",
    "unconfirmed",
  ]);
  // Unconfirmed candidates are the plan's "candidate but marked unconfirmed" case.
  assert.equal(candidates[4].price.kind, "unknown");
  assert.equal(candidates[4].price.confirmed, false);
});

test("flash candidates are ordered by known price, then window, then stable id", () => {
  const main = model("API", "glm-5.3");
  const candidates = select({
    mainModel: main,
    availableModels: [
      main,
      model("API", "flash-b", { cost: { input: 0.5, output: 2 } }),
      model("API", "flash-a", { cost: { input: 0.5, output: 2 } }),
      model("API", "flash-cheap", { cost: { input: 0.1, output: 0.3 } }),
    ],
  });
  assert.deepEqual(refs(candidates), ["API/flash-cheap", "API/flash-a", "API/flash-b"]);
});

test("deduplicates by provider + model id and keeps the first entry", () => {
  const main = model("API", "glm-5.3");
  const duplicate = model("API", "spark-x2.6", { name: "duplicate", cost: free() });
  const candidates = select({
    mainModel: main,
    availableModels: [main, model("API", "spark-x2.6", { name: "first", cost: free() }), duplicate],
  });
  assert.deepEqual(refs(candidates), ["API/spark-x2.6"]);
  assert.equal(candidates[0].model.name, "first");
});

test("excludes virtual, image and classifier entries from the chain", () => {
  const main = model("API", "glm-5.3");
  const candidates = select({
    mainModel: main,
    availableModels: [
      main,
      { provider: "API", id: "router", name: "Router", api: "pi-virtual", type: "chat", cost: free(), contextWindow: WINDOW, maxTokens: 8_192 },
      { provider: "API", id: "image-gen", name: "image", type: "image", cost: free(), contextWindow: WINDOW, maxTokens: 8_192 },
      { provider: "API", id: "classifier-x", name: "classifier", type: "classifier", cost: free(), contextWindow: WINDOW, maxTokens: 8_192 },
    ],
  });
  assert.deepEqual(refs(candidates), []);
});

test("a model without credentials (not in getAvailable) is never a candidate", () => {
  const main = model("API", "glm-5.3");
  const uncredentialed = model("API", "spark-x2.6", { cost: free() });
  const candidates = select({ mainModel: main, availableModels: [main] });
  assert.deepEqual(refs(candidates), []);
  assert.ok(!refs(candidates).includes(compactionModelRef(uncredentialed)));
});

test("preferred entry with no credentials is skipped, not guessed across providers", () => {
  const main = model("API", "glm-5.3");
  const candidates = select({
    mainModel: main,
    availableModels: [main, model("API", "spark-x2.6", { cost: free() })],
    preferredModels: ["openai/gpt-5"],
  });
  assert.deepEqual(refs(candidates), ["API/spark-x2.6"]);
});

test("candidates whose window cannot hold the preparation are skipped", () => {
  const main = model("API", "glm-5.3");
  const small = model("API", "spark-x2.6", { cost: free(), contextWindow: 32_000, maxTokens: 8_192 });
  const candidates = select({ mainModel: main, availableModels: [main, small], requestTokens: 100_000 });
  assert.deepEqual(refs(candidates), []);
});

test("a free 0/0 price respects a distrusting price-doubt injected by the caller", () => {
  const main = model("API", "glm-5.3");
  const zeroPriced = model("API", "mystery-model", { cost: free() });
  const candidates = select({
    mainModel: main,
    availableModels: [main, zeroPriced],
    isZeroPriceTrusted: (entry) => entry.id !== "mystery-model",
  });
  // Still a flash-less, non-name-hint, unconfirmed-price model: not a candidate.
  assert.deepEqual(refs(candidates), []);
});

test("current model is the SDK's fallback, never duplicated at the tail of the chain", () => {
  const main = model("API", "glm-5.3");
  const candidates = select({
    mainModel: main,
    availableModels: [main, model("API", "spark-x2.6", { cost: free() })],
  });
  assert.ok(!refs(candidates).includes("API/glm-5.3"));
  // Exhausting the chain therefore returns undefined and the SDK runs the main model once.
  assert.deepEqual(refs(candidates), ["API/spark-x2.6"]);
});

test("an empty available list yields an empty chain for every choice", () => {
  for (const choice of ["auto", "current", "preferred"]) {
    assert.deepEqual(select({ availableModels: [], choice, mainModel: model("API", "glm-5.3") }), []);
  }
});

test("selection is deterministic across runs and input order", () => {
  const main = model("API", "glm-5.3");
  const a = model("API", "spark-x2.6", { cost: free() });
  const b = model("API", "hy4free", { cost: free() });
  const input = { mainModel: main, availableModels: [main, a, b] };
  const first = refs(select(input));
  const second = refs(select({ ...input, availableModels: [main, b, a] }));
  assert.deepEqual(first, second);
  // Spark's limited free tier outranks `hy*` inside the confirmed-free group.
  assert.deepEqual(first, ["API/spark-x2.6", "API/hy4free"]);
});

test("a virtual main model resolves against the catalog by provider/id", () => {
  const physical = model("API", "glm-5.3");
  const router = { provider: "API", id: "glm-5.3", api: "pi-virtual", type: "chat" };
  const candidates = select({ mainModel: router, availableModels: [physical] });
  // The router is not in `available`; its physical twin is, and it is expensive,
  // so the chain is empty and the SDK native path handles the summary.
  assert.deepEqual(refs(candidates), []);
});