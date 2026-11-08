import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  COMPACTION_MODEL_EXTENSION_NAME,
  buildCompactionDetails,
  classifyCompactionFailure,
  createCompactionModelExtension,
  estimatePreparationTokens,
  redactCompactionDiagnostic,
} = await jiti.import("./compaction-extension.ts");
const { defaultCompactionPolicy } = await jiti.import("./compaction-policy.ts");

const WINDOW = 1_048_576;
const SECRET_KEY = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const SECRET_HEADER = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload.signature";

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

function preparation(overrides = {}) {
  return {
    firstKeptEntryId: "entry-1",
    messagesToSummarize: [
      { role: "user", content: "do a thing" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 500_000,
    fileOps: {
      read: new Set(["/a.ts", "/b.ts", "/changed.ts"]),
      written: new Set(["/changed.ts"]),
      edited: new Set(["/changed.ts"]),
    },
    settings: { enabled: true, reserveTokens: 65_536, keepRecentTokens: 65_536 },
    ...overrides,
  };
}

function basePolicy(overrides = {}) {
  return { ...defaultCompactionPolicy(), ...overrides };
}

function makeRegistry(models, { authFor = () => ({ ok: true, apiKey: SECRET_KEY }) } = {}) {
  const calls = [];
  return {
    calls,
    getAvailable: () => models,
    async getApiKeyAndHeaders(entry) {
      calls.push(entry);
      return authFor(entry);
    },
  };
}

/** Call the handler exactly the way the extension runner does. */
async function dispatch(extension, { ctx, event }) {
  const handlers = [];
  await extension.factory({ on: (name, handler) => handlers.push([name, handler]) });
  assert.deepEqual(handlers.map(([name]) => name), ["session_before_compact"]);
  return handlers[0][1](event, ctx);
}

function makeHarness({ models, mainModel, policy = basePolicy(), compactFn, authFor, logger, registry } = {}) {
  const warnings = [];
  const compactCalls = [];
  const modelRegistry = registry ?? makeRegistry(models, { authFor });
  const runtime = {
    modelRegistry,
    compactCalls,
  };
  runtime.extension = createCompactionModelExtension({
    modelRegistry,
    readPolicy: () => policy,
    logger: logger ?? { warn: (message) => warnings.push(message) },
    compactFn: compactFn ?? (async (...args) => {
      compactCalls.push(args);
      return {
        summary: "a summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 500_000,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        details: { readFiles: ["/a.ts", "/b.ts"], modifiedFiles: ["/changed.ts"] },
      };
    }),
  });
  runtime.warnings = warnings;
  runtime.mainModel = mainModel;
  runtime.models = models;
  runtime.dispatch = (event = {}) => dispatch(runtime.extension, {
    ctx: { model: mainModel, modelRegistry: modelRegistry.ctxRegistry ?? modelRegistry },
    event: { preparation: preparation(), signal: new AbortController().signal, ...event },
  });
  return runtime;
}

const calledRefs = (harness) => harness.compactCalls.map((args) => `${args[1].provider}/${args[1].id}`);

// ---------------------------------------------------------------------------
// Step 0: main model stays when it is Flash-class
// ---------------------------------------------------------------------------

test("a Flash main model summarizes on itself with no downgrade request", async () => {
  const main = model("API", "deepseek-v4.1-flash", { name: "DeepSeek-V4.1-Flash" });
  const spark = model("API", "spark-x2.6", { name: "Spark-X2.6 限时免费", cost: { input: 0, output: 0 } });
  const harness = makeHarness({ models: [main, spark], mainModel: main });

  const result = await harness.dispatch();

  assert.deepEqual(calledRefs(harness), ["API/deepseek-v4.1-flash"]);
  assert.equal(result.compaction.details.compactionModel.provider, "API");
  assert.equal(result.compaction.details.compactionModel.modelId, "deepseek-v4.1-flash");
  assert.equal(result.compaction.details.fallbackCount, 0);
  assert.equal(result.compaction.details.mode, "auto");
});

test("a zero-priced main model also stays", async () => {
  const main = model("API", "some-model", { cost: { input: 0, output: 0 } });
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const harness = makeHarness({ models: [main, spark], mainModel: main });
  await harness.dispatch();
  assert.deepEqual(calledRefs(harness), ["API/some-model"]);
});

test("an expensive main model goes down the chain instead", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { name: "Spark-X2.6 限时免费", cost: { input: 0, output: 0 } });
  const harness = makeHarness({ models: [main, spark], mainModel: main });

  const result = await harness.dispatch();

  assert.deepEqual(calledRefs(harness), ["API/spark-x2.6"]);
  assert.equal(result.compaction.details.compactionModel.modelId, "spark-x2.6");
});

test("choice current pins the session model even when it is expensive", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const harness = makeHarness({
    models: [main, spark],
    mainModel: main,
    policy: basePolicy({ compactionModel: "current" }),
  });
  await harness.dispatch();
  assert.deepEqual(calledRefs(harness), ["API/glm-5.3"]);
});

test("choice preferred uses only the explicit list", async () => {
  const main = model("API", "glm-5.3");
  const preferred = model("openai", "gpt-5");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const harness = makeHarness({
    models: [main, preferred, spark],
    mainModel: main,
    policy: basePolicy({ compactionModel: "preferred", preferredModels: ["openai/gpt-5"] }),
  });
  await harness.dispatch();
  assert.deepEqual(calledRefs(harness), ["openai/gpt-5"]);
});

// ---------------------------------------------------------------------------
// Credentials, thinking level and streamFn
// ---------------------------------------------------------------------------

test("compact() is called without the session thinking level or streamFn", async () => {
  const main = model("API", "deepseek-v4.1-flash");
  const harness = makeHarness({ models: [main], mainModel: main });
  await harness.dispatch({ customInstructions: "focus on errors" });

  const [, calledModel, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn] =
    harness.compactCalls[0];
  assert.equal(calledModel.id, "deepseek-v4.1-flash");
  assert.equal(apiKey, SECRET_KEY, "auth comes from getApiKeyAndHeaders for the candidate");
  assert.equal(headers, undefined);
  assert.equal(customInstructions, "focus on errors");
  assert.ok(signal instanceof AbortSignal);
  assert.equal(thinkingLevel, undefined, "no main-session thinking level");
  assert.equal(streamFn, undefined, "no main-model stream function");
});

test("request headers and baseUrl come from the candidate's own auth", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const registry = makeRegistry([main, spark], {
    authFor: (entry) => entry.id === "spark-x2.6"
      ? { ok: true, apiKey: "spark-key", headers: { "x-tenant": "t1", "x-gone": null }, baseUrl: "https://alt.example" }
      : { ok: true, apiKey: "main-key" },
  });
  const harness = makeHarness({ models: [main, spark], mainModel: main, registry });

  await harness.dispatch();

  const [, calledModel, apiKey, headers] = harness.compactCalls[0];
  assert.equal(calledModel.id, "spark-x2.6");
  assert.equal(calledModel.baseUrl, "https://alt.example");
  assert.equal(apiKey, "spark-key");
  assert.deepEqual(headers, { "x-tenant": "t1" }, "null headers are dropped");
});

test("a credential failure skips the candidate without leaking the error text", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const fallback = model("API", "glm-5.3-flash");
  const registry = makeRegistry([main, spark, fallback], {
    authFor: (entry) => entry.id === "spark-x2.6"
      ? { ok: false, error: `No API key found for "spark" (sk_live_${"x".repeat(40)})` }
      : { ok: true, apiKey: SECRET_KEY },
  });
  const harness = makeHarness({ models: [main, spark, fallback], mainModel: main, registry });

  const result = await harness.dispatch();

  assert.deepEqual(calledRefs(harness), ["API/glm-5.3-flash"]);
  assert.equal(result.compaction.details.fallbackCount, 1);
  const logs = harness.warnings.join("\n");
  assert.match(logs, /no-credentials/);
  assert.ok(!logs.includes("sk_live_"), "provider error text is never logged");
  assert.ok(!logs.includes(SECRET_KEY));
});

test("a registry that throws is a skipped candidate, not a crash", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const registry = makeRegistry([main, spark], {
    authFor: (entry) => {
      if (entry.id === "spark-x2.6") throw new Error(`auth exploded ${SECRET_KEY}`);
      return { ok: true, apiKey: SECRET_KEY };
    },
  });
  // main is expensive, so the chain is only spark; it fails and the run ends at the SDK.
  const harness = makeHarness({ models: [main, spark], mainModel: main, registry });
  const result = await harness.dispatch();
  assert.equal(result, undefined);
  assert.match(harness.warnings.join("\n"), /credential-error/);
  assert.ok(!harness.warnings.join("\n").includes(SECRET_KEY));
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

test("an already-aborted signal never issues a request", async () => {
  const main = model("API", "deepseek-v4.1-flash");
  const harness = makeHarness({ models: [main], mainModel: main });
  const controller = new AbortController();
  controller.abort();

  const result = await harness.dispatch({ signal: controller.signal });

  // Cancel, not "undefined": the SDK must not run its native path on an
  // already-aborted signal and issue a doomed request.
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(calledRefs(harness), []);
});

test("an abort during a failed request does not downgrade to the next model", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const flash = model("API", "glm-5.3-flash");
  const controller = new AbortController();
  const harness = makeHarness({
    models: [main, spark, flash],
    mainModel: main,
    compactFn: async () => {
      controller.abort();
      throw new Error("Compaction cancelled");
    },
  });

  const result = await harness.dispatch({ signal: controller.signal });

  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(calledRefs(harness), [], "the injected compactFn does not record; no second call");
  assert.deepEqual(harness.warnings, [], "aborts are not failures");
});

test("an abort while the chain is running returns control to the SDK", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const flash = model("API", "glm-5.3-flash");
  const controller = new AbortController();
  const attempts = [];
  const harness = makeHarness({
    models: [main, spark, flash],
    mainModel: main,
    compactFn: async (prep, calledModel) => {
      attempts.push(calledModel.id);
      controller.abort();
      throw new Error("aborted by user");
    },
  });

  const result = await harness.dispatch({ signal: controller.signal });

  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(attempts, ["spark-x2.6"], "only the first candidate ran");
});

// ---------------------------------------------------------------------------
// Failure downgrade chain
// ---------------------------------------------------------------------------

const failureCases = [
  { label: "rate limit", error: () => new Error("429 Too Many Requests"), code: "rate-limited" },
  { label: "network drop", error: () => new Error("fetch failed: ECONNRESET"), code: "network" },
  { label: "length stop", error: () => new Error("Summarization failed: generation hit the token cap and the summary is incomplete"), code: "length-stop" },
  { label: "unknown upstream error", error: () => new Error("upstream 502"), code: "request-failed" },
];

for (const { label, error, code } of failureCases) {
  test(`a ${label} failure moves to the next candidate`, async () => {
    const main = model("API", "glm-5.3");
    const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
    const flash = model("API", "glm-5.3-flash");
    const attempts = [];
    const harness = makeHarness({
      models: [main, spark, flash],
      mainModel: main,
      compactFn: async (prep, calledModel) => {
        attempts.push(`API/${calledModel.id}`);
        if (calledModel.id === "spark-x2.6") throw error();
        return {
          summary: "fallback summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 500_000,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          details: { readFiles: [], modifiedFiles: [] },
        };
      },
    });

    const result = await harness.dispatch();

    assert.deepEqual(attempts, ["API/spark-x2.6", "API/glm-5.3-flash"]);
    assert.equal(result.compaction.summary, "fallback summary");
    assert.equal(result.compaction.details.fallbackCount, 1);
    assert.equal(result.compaction.details.compactionModel.modelId, "glm-5.3-flash");
    assert.match(harness.warnings.join("\n"), new RegExp(code));
  });
}

test("an empty summary is a failure that downgrades", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const flash = model("API", "glm-5.3-flash");
  let call = 0;
  const harness = makeHarness({
    models: [main, spark, flash],
    mainModel: main,
    compactFn: async () => {
      call += 1;
      return call === 1
        ? { summary: "   ", firstKeptEntryId: "entry-1", tokensBefore: 500_000 }
        : { summary: "ok", firstKeptEntryId: "entry-1", tokensBefore: 500_000 };
    },
  });
  const result = await harness.dispatch();
  assert.equal(result.compaction.summary, "ok");
  assert.match(harness.warnings.join("\n"), /empty-summary/);
  assert.equal(result.compaction.details.fallbackCount, 1);
});

test("a malformed result (missing firstKeptEntryId) is a failure that downgrades", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  let call = 0;
  const harness = makeHarness({
    models: [main, spark],
    mainModel: main,
    compactFn: async () => {
      call += 1;
      return call === 1
        ? { summary: "x", firstKeptEntryId: "", tokensBefore: 1 }
        : { summary: "ok", firstKeptEntryId: "entry-1", tokensBefore: 500_000 };
    },
  });
  const result = await harness.dispatch();
  assert.equal(result, undefined, "the second call also runs but the model list has no more");
  assert.match(harness.warnings.join("\n"), /empty-summary/);
});

// ---------------------------------------------------------------------------
// Exhausted chain → SDK native path
// ---------------------------------------------------------------------------

test("every candidate failing returns undefined so the SDK path runs the main model", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const attempts = [];
  const harness = makeHarness({
    models: [main, spark],
    mainModel: main,
    compactFn: async (prep, calledModel) => {
      attempts.push(calledModel.id);
      throw new Error("fetch failed");
    },
  });

  const result = await harness.dispatch();

  assert.equal(result, undefined);
  assert.deepEqual(attempts, ["spark-x2.6"], "the main model is left to the SDK native path");
});

test("no candidates at all returns undefined without a request", async () => {
  const main = model("API", "glm-5.3");
  const harness = makeHarness({ models: [main], mainModel: main });
  const result = await harness.dispatch();
  assert.equal(result, undefined);
  assert.deepEqual(calledRefs(harness), []);
});

test("a candidate whose window cannot hold the preparation is skipped", async () => {
  const main = model("API", "glm-5.3");
  const tiny = model("API", "spark-x2.6", { cost: { input: 0, output: 0 }, contextWindow: 8_192, maxTokens: 2_048 });
  const harness = makeHarness({ models: [main, tiny], mainModel: main });
  const result = await harness.dispatch({
    preparation: preparation({
      messagesToSummarize: [{ role: "user", content: "x".repeat(400_000) }],
    }),
  });
  assert.equal(result, undefined);
  assert.deepEqual(calledRefs(harness), []);
});

// ---------------------------------------------------------------------------
// Result shape: summary/usage/details preserved
// ---------------------------------------------------------------------------

test("a success keeps summary, firstKeptEntryId, tokensBefore and usage", async () => {
  const main = model("API", "deepseek-v4.1-flash");
  const usage = { input: 1234, output: 567, cacheRead: 100, cacheWrite: 0, totalTokens: 1901 };
  const harness = makeHarness({
    models: [main],
    mainModel: main,
    compactFn: async () => ({
      summary: "the summary text",
      firstKeptEntryId: "kept-42",
      tokensBefore: 777_777,
      usage,
      details: { readFiles: ["/r1.ts"], modifiedFiles: ["/m1.ts"] },
    }),
  });

  const result = await harness.dispatch();

  assert.equal(result.compaction.summary, "the summary text");
  assert.equal(result.compaction.firstKeptEntryId, "kept-42");
  assert.equal(result.compaction.tokensBefore, 777_777);
  assert.deepEqual(result.compaction.usage, usage);
});

test("details keep the SDK's readFiles/modifiedFiles and add the extension metadata", async () => {
  const main = model("API", "deepseek-v4.1-flash");
  const harness = makeHarness({
    models: [main],
    mainModel: main,
    compactFn: async () => ({
      summary: "s",
      firstKeptEntryId: "e",
      tokensBefore: 1,
      details: { readFiles: ["/a.ts", "/b.ts"], modifiedFiles: ["/changed.ts"] },
    }),
  });

  const result = await harness.dispatch();

  assert.deepEqual(result.compaction.details.readFiles, ["/a.ts", "/b.ts"]);
  assert.deepEqual(result.compaction.details.modifiedFiles, ["/changed.ts"]);
  assert.deepEqual(result.compaction.details.compactionModel, {
    provider: "API",
    modelId: "deepseek-v4.1-flash",
  });
  assert.equal(result.compaction.details.fallbackCount, 0);
  assert.equal(result.compaction.details.mode, "auto");
});

test("details missing file lists are rebuilt from preparation.fileOps", async () => {
  const main = model("API", "deepseek-v4.1-flash");
  const harness = makeHarness({
    models: [main],
    mainModel: main,
    compactFn: async () => ({ summary: "s", firstKeptEntryId: "e", tokensBefore: 1 }),
  });

  const result = await harness.dispatch();

  assert.deepEqual(result.compaction.details.readFiles, ["/a.ts", "/b.ts"]);
  assert.deepEqual(result.compaction.details.modifiedFiles, ["/changed.ts"]);
});

test("buildCompactionDetails keeps SDK fields and never overwrites the file lists", () => {
  const details = buildCompactionDetails(
    { readFiles: ["/x"], modifiedFiles: ["/y"], extra: "kept" },
    preparation(),
    { compactionModel: { provider: "p", modelId: "m" }, fallbackCount: 3, mode: "auto" },
  );
  assert.deepEqual(details.readFiles, ["/x"]);
  assert.deepEqual(details.modifiedFiles, ["/y"]);
  assert.equal(details.extra, "kept", "other extensions' metadata must survive");
  assert.equal(details.fallbackCount, 3);
});

// ---------------------------------------------------------------------------
// No secret leakage
// ---------------------------------------------------------------------------

test("no diagnostic ever contains an api key, header or long token", async () => {
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const flash = model("API", "glm-5.3-flash");
  const harness = makeHarness({
    models: [main, spark, flash],
    mainModel: main,
    authFor: () => ({ ok: true, apiKey: SECRET_KEY, headers: { authorization: SECRET_HEADER } }),
    compactFn: async () => {
      throw new Error(`request failed: Authorization: ${SECRET_HEADER} api_key=${SECRET_KEY}`);
    },
  });

  await harness.dispatch();

  const logs = harness.warnings.join("\n");
  assert.ok(logs.length > 0);
  assert.ok(!logs.includes(SECRET_KEY), "api key must not appear");
  assert.ok(!logs.includes("secretpayload"), "header token must not appear");
  assert.ok(!/sk-live-[A-Za-z0-9]{8,}/.test(logs));
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(logs));
});

test("redaction strips bearer tokens, api keys and long opaque strings", () => {
  const redacted = redactCompactionDiagnostic(
    `failed Authorization: ${SECRET_HEADER} with sk-live-abcdefghijklmnop and token ${"z".repeat(48)}`,
  );
  assert.ok(!redacted.includes("secretpayload"));
  assert.ok(!redacted.includes("sk-live-abcdefghijklmnop"));
  assert.ok(!redacted.includes("z".repeat(48)));
  assert.ok(redacted.length <= 161);
});

test("classifyCompactionFailure maps abort separately from request errors", () => {
  assert.equal(classifyCompactionFailure(new Error("Compaction cancelled")).code, "aborted");
  // A provider-side "cancelled" response is an upstream failure, not a user abort.
  assert.equal(classifyCompactionFailure(new Error("request cancelled upstream")).code, "request-failed");
  assert.equal(classifyCompactionFailure(Object.assign(new Error("x"), { name: "AbortError" })).code, "aborted");
  assert.equal(classifyCompactionFailure(new Error("429 rate limit")).code, "rate-limited");
  assert.equal(classifyCompactionFailure(new Error("ENOTFOUND api.example")).code, "network");
  assert.equal(classifyCompactionFailure(new Error("hit the token cap")).code, "length-stop");
  assert.equal(classifyCompactionFailure(new Error("mystery")).code, "request-failed");
});

// ---------------------------------------------------------------------------
// Extension surface
// ---------------------------------------------------------------------------

test("the extension is hidden and registers exactly one handler", async () => {
  const extension = createCompactionModelExtension({
    readPolicy: () => basePolicy(),
    logger: { warn() {} },
  });
  assert.equal(extension.name, COMPACTION_MODEL_EXTENSION_NAME);
  assert.equal(extension.hidden, true);
  const handlers = [];
  await extension.factory({ on: (name, handler) => handlers.push([name, handler]) });
  assert.deepEqual(handlers.map(([name]) => name), ["session_before_compact"]);
});

test("the policy is read on every compaction, so a settings change applies without restart", async () => {
  let policy = basePolicy({ compactionModel: "current" });
  const main = model("API", "glm-5.3");
  const spark = model("API", "spark-x2.6", { cost: { input: 0, output: 0 } });
  const calls = [];
  const modelRegistry = makeRegistry([main, spark]);
  const extension = createCompactionModelExtension({
    modelRegistry,
    readPolicy: () => policy,
    logger: { warn() {} },
    compactFn: async (prep, calledModel) => {
      calls.push(calledModel.id);
      return { summary: "s", firstKeptEntryId: "e", tokensBefore: 1 };
    },
  });
  const handlers = [];
  await extension.factory({ on: (name, handler) => handlers.push([name, handler]) });
  const dispatchOnce = () => handlers[0][1](
    { preparation: preparation(), signal: new AbortController().signal },
    { model: main, modelRegistry },
  );

  await dispatchOnce();
  policy = basePolicy();
  await dispatchOnce();

  assert.deepEqual(calls, ["glm-5.3", "spark-x2.6"]);
});

test("estimatePreparationTokens counts messages, prefix, previous summary and overhead", () => {
  const tokens = estimatePreparationTokens(preparation({
    messagesToSummarize: [{ role: "user", content: "x".repeat(4_000) }],
    turnPrefixMessages: [{ role: "user", content: "y".repeat(400) }],
    previousSummary: "z".repeat(400),
  }));
  assert.equal(tokens, 2_224, "1024 overhead + 1000 + 100 + 100");
});