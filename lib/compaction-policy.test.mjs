import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  COMPACTION_MODES,
  COMPACTION_TRIGGER_FLOOR,
  NATIVE_RESERVE_TOKENS,
  compactionThresholdsByMode,
  compactionThresholdsFor,
  computeCompactionThresholds,
  createCompactionSettingsManager,
  defaultCompactionPolicy,
  isCompactionModelRef,
  normalizeCompactionPolicy,
  readCompactionPolicy,
  readExplicitCompactionSettings,
} = await jiti.import("./compaction-policy.ts");

const ONE_M = 1_048_576;
const WINDOW_128K = 131_072;

function policy(overrides = {}) {
  return { ...defaultCompactionPolicy(), ...overrides };
}

/** A real in-memory SettingsManager: no file I/O, no network, the SDK's own resolution order. */
function manager(settings) {
  return SettingsManager.inMemory(settings);
}

/** A chat model carries `contextWindow`; the SDK's declared parameter type does not. */
function model(contextWindow, provider = "zenmux", id = "m") {
  return { provider, id, contextWindow };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("defaults match the plan: balanced, 64K retained, auto model", () => {
  assert.deepEqual(defaultCompactionPolicy(), {
    mode: "balanced",
    keepRecentTokens: 65_536,
    compactionModel: "auto",
    preferredModels: [],
  });
  assert.deepEqual([...COMPACTION_MODES], ["balanced", "long", "native"]);
  const first = defaultCompactionPolicy();
  first.mode = "native";
  assert.equal(defaultCompactionPolicy().mode, "balanced", "a fresh object per call");
});

test("a malformed stored policy falls back field by field", () => {
  assert.deepEqual(normalizeCompactionPolicy(undefined), defaultCompactionPolicy());
  assert.deepEqual(normalizeCompactionPolicy("balanced"), defaultCompactionPolicy());
  assert.deepEqual(normalizeCompactionPolicy([]), defaultCompactionPolicy());
  assert.deepEqual(
    normalizeCompactionPolicy({ mode: "long", keepRecentTokens: 1000, compactionModel: "current" }),
    { mode: "long", keepRecentTokens: 65_536, compactionModel: "current", preferredModels: [] },
  );
  assert.equal(normalizeCompactionPolicy({ mode: "turbo" }).mode, "balanced");
  assert.equal(normalizeCompactionPolicy({ keepRecentTokens: 65_536.5 }).keepRecentTokens, 65_536);
  assert.equal(normalizeCompactionPolicy({ keepRecentTokens: 999_999_999 }).keepRecentTokens, 65_536);
});

test("preferred models are all-or-nothing, like the settings route contract", () => {
  // Same rule as `lib/compaction-settings-api.ts`: one bad entry voids the list,
  // so the settings UI and a running session never disagree.
  assert.deepEqual(
    normalizeCompactionPolicy({ preferredModels: ["zenmux/x", "p/m"] }).preferredModels,
    ["zenmux/x", "p/m"],
  );
  assert.deepEqual(normalizeCompactionPolicy({ preferredModels: [" zenmux/x "] }).preferredModels, ["zenmux/x"]);
  for (const bad of [["bad"], ["a/"], ["/b"], ["p/m with space"], ["p/m", 7]]) {
    assert.deepEqual(normalizeCompactionPolicy({ preferredModels: bad }).preferredModels, [], JSON.stringify(bad));
  }
  assert.deepEqual(
    normalizeCompactionPolicy({ preferredModels: Array.from({ length: 9 }, (_, i) => `p/m${i}`) }).preferredModels,
    [],
    "more than 8 voids the list",
  );
  assert.equal(
    normalizeCompactionPolicy({ preferredModels: Array.from({ length: 8 }, (_, i) => `p/m${i}`) }).preferredModels.length,
    8,
  );
  assert.equal(isCompactionModelRef("openrouter/vendor/model"), true, "inner slashes stay valid");
  assert.equal(isCompactionModelRef("p/m\t"), false);
});

test("the settings file is read tolerantly, ignoring unrelated keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-compaction-"));
  const path = join(dir, "pi-web", "settings.json");
  assert.deepEqual(readCompactionPolicy(path), defaultCompactionPolicy());

  // A hand-authored file with unrelated Pi Web preferences intact. This module
  // is read-only — the writer is lib/compaction-settings-api.ts — so the
  // round trip is asserted by reading back exactly what the file holds.
  mkdirSync(join(dir, "pi-web"));
  writeFileSync(path, JSON.stringify({
    artifactsPrompt: false,
    compactionPolicy: { mode: "long", keepRecentTokens: 131_072, compactionModel: "current" },
  }));
  assert.deepEqual(readCompactionPolicy(path), {
    mode: "long",
    keepRecentTokens: 131_072,
    compactionModel: "current",
    preferredModels: [],
  });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).artifactsPrompt, false, "the file is untouched by reading");
});

test("an unreadable settings file reads as the defaults, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-compaction-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, "{not json");
  assert.deepEqual(readCompactionPolicy(path), defaultCompactionPolicy());
});

test("unknown keys inside compactionPolicy are ignored by the reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-compaction-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ compactionPolicy: { mode: "long", futureKey: true } }));
  assert.deepEqual(readCompactionPolicy(path), {
    mode: "long",
    keepRecentTokens: 65_536,
    compactionModel: "auto",
    preferredModels: [],
  });
});

// ---------------------------------------------------------------------------
// Threshold maths (the plan's r2 acceptance numbers)
// ---------------------------------------------------------------------------

test("1M balanced triggers at 524,288 (50%) with a 65,536-token tail", () => {
  const t = computeCompactionThresholds(policy(), ONE_M);
  assert.equal(t.mode, "balanced");
  assert.equal(t.keepRecentTokens, 65_536);
  assert.equal(t.trigger, 524_288);
  assert.equal(t.reserveTokens, ONE_M - 524_288);
  // The SDK compares `contextTokens > window - reserveTokens`, so the reserve
  // must reproduce exactly that trigger.
  assert.equal(ONE_M - t.reserveTokens, 524_288);
});

test("1M long triggers at 838,860 (80%)", () => {
  const t = computeCompactionThresholds(policy({ mode: "long" }), ONE_M);
  assert.equal(t.mode, "long");
  assert.equal(t.trigger, 838_860);
  assert.equal(ONE_M - t.reserveTokens, 838_860);
});

test("128K balanced triggers at 65,536 — the label's 50%, not a quarter", () => {
  // r2 subtracted the kept tail from the tier's share, so this fired at 32,768
  // (25%) with a 32,768-token tail: nothing was left to summarize, the SDK
  // skipped the compaction, and the next turn retriggered. `trigger` is the
  // tier share now, and the tail is capped at half of it.
  const t = computeCompactionThresholds(policy(), WINDOW_128K);
  assert.equal(t.mode, "balanced");
  assert.equal(t.keepRecentTokens, 32_768, "half of the trigger");
  assert.equal(t.trigger, 65_536, "50% of the window");
  assert.ok(t.reserveTokens > 0);
  assert.ok(t.trigger < WINDOW_128K);
  assert.equal(WINDOW_128K - t.reserveTokens, t.trigger);
  assert.equal(t.trigger - t.keepRecentTokens, 32_768, "a full half-trigger of headroom");
});

test("an unknown or non-positive window falls back to native", () => {
  for (const window of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1024.5]) {
    const t = computeCompactionThresholds(policy(), window);
    assert.equal(t.mode, "native", `window=${String(window)}`);
    assert.equal(t.reserveTokens, NATIVE_RESERVE_TOKENS);
  }
});

test("a window at or below the 16K floor stays native", () => {
  for (const window of [8_192, 16_384, 16_385]) {
    const t = computeCompactionThresholds(policy(), window);
    assert.equal(t.mode, "native", `window=${window}`);
    assert.equal(t.reserveTokens, NATIVE_RESERVE_TOKENS);
  }
});

test("a 20K window would compact at 4K with the raw reserve, so it stays native", () => {
  // 20480 × 0.5 = 10240; the tail is capped at half of it (5120), leaving only
  // 5120 of headroom — below the 16384 floor the next turn needs. Native
  // reports the SDK's own trigger without claiming the tier applied.
  const t = computeCompactionThresholds(policy(), 20_480);
  assert.equal(t.mode, "native");
  assert.equal(t.reserveTokens, NATIVE_RESERVE_TOKENS);
  assert.equal(20_480 - t.reserveTokens, 4_096);
});

test("a tier needs half a trigger above the tail, so 65,534 applies and 65,533 falls back", () => {
  // The smallest applied trigger is 32,767: the tail takes 16,383 and
  // `trigger - tail` is exactly the 16,384 floor. floor(65,535 / 2) and
  // floor(65,534 / 2) both reach it; 65,533 lands one token short.
  for (const window of [65_535, 65_534]) {
    const t = computeCompactionThresholds(policy(), window);
    assert.equal(t.mode, "balanced", `window=${window}`);
    assert.equal(t.trigger - t.keepRecentTokens, COMPACTION_TRIGGER_FLOOR, `window=${window}`);
    assert.equal(window - t.reserveTokens, t.trigger, `window=${window}`);
  }
  const below = computeCompactionThresholds(policy(), 65_533);
  assert.equal(below.mode, "native", "one token below the headroom floor");
  assert.equal(below.reserveTokens, NATIVE_RESERVE_TOKENS);
});

test("a compaction never leaves the post-compaction context above its own trigger", () => {
  // The r2 loop: trigger == keepRecentEff for every window ≤ 4× the tail, so
  // the next turn immediately exceeded the threshold again. Pin the invariant
  // across the windows real models use, including the tail-capped ones.
  // Windows where both tiers apply (long needs 20% of the window ≥ the floor).
  for (const window of [100_000, WINDOW_128K, 200_000, 262_144, 300_000, 400_000, ONE_M]) {
    for (const mode of ["balanced", "long"]) {
      const t = computeCompactionThresholds(policy({ mode }), window);
      assert.equal(t.mode, mode, `${mode} @${window}`);
      assert.ok(t.trigger > t.keepRecentTokens, `${mode} @${window}: trigger ${t.trigger} vs tail ${t.keepRecentTokens}`);
      assert.ok(
        t.trigger - t.keepRecentTokens >= COMPACTION_TRIGGER_FLOOR,
        `${mode} @${window}: headroom ${t.trigger - t.keepRecentTokens}`,
      );
      assert.ok(t.trigger < window, `${mode} @${window}`);
    }
  }
});

test("native mode ignores the window and reports the SDK's reserve", () => {
  const t = computeCompactionThresholds(policy({ mode: "native" }), ONE_M, undefined, 12_345);
  assert.equal(t.mode, "native");
  assert.equal(t.reserveTokens, 12_345);
  assert.equal(t.trigger, ONE_M - 12_345);
});

test("an explicit keepRecentTokens above the default raises the tail, not the trigger", () => {
  // The trigger is the tier's share of the window; the explicit tail only
  // changes what is kept. A tail larger than half the trigger is still capped.
  const t = computeCompactionThresholds(policy(), ONE_M, 131_072);
  assert.equal(t.keepRecentTokens, 131_072);
  assert.equal(t.trigger, 524_288);
  assert.equal(t.trigger - t.keepRecentTokens, 393_216);
});

test("an explicit keepRecentTokens of 0 is respected, not read as unset", () => {
  const t = computeCompactionThresholds(policy(), ONE_M, 0);
  assert.equal(t.keepRecentTokens, 0);
  assert.equal(t.trigger, 524_288);
});

// ---------------------------------------------------------------------------
// Explicit settings detection and the SettingsManager delegate
// ---------------------------------------------------------------------------

test("explicit pi settings are distinguished from the SDK's defaults", () => {
  assert.deepEqual(readExplicitCompactionSettings(manager({})), {});
  assert.deepEqual(
    readExplicitCompactionSettings(manager({ compaction: { reserveTokens: 40_000 } })),
    { reserveTokens: 40_000 },
  );
  assert.deepEqual(
    readExplicitCompactionSettings(manager({ compaction: { keepRecentTokens: 0 } })),
    { keepRecentTokens: 0 },
    "an explicit zero must survive",
  );
  // Per-model overrides win, as in the SDK's own resolution order.
  assert.deepEqual(
    readExplicitCompactionSettings(
      manager({ compaction: { keepRecentTokens: 65_536, modelOverrides: { "p/m": { keepRecentTokens: 131_072 } } } }),
      { provider: "p", id: "m" },
    ),
    { keepRecentTokens: 131_072 },
  );
  // A different model's override must not leak in.
  assert.deepEqual(
    readExplicitCompactionSettings(
      manager({ compaction: { modelOverrides: { "p/other": { reserveTokens: 1 } } } }),
      { provider: "p", id: "m" },
    ),
    {},
  );
});

test("the wrapper applies the tier and leaves every other manager member alone", () => {
  const base = manager({ theme: "dark", compaction: { enabled: true } });
  const wrapped = createCompactionSettingsManager(base, policy());

  const nativeSettings = base.getCompactionSettings(model(ONE_M));
  assert.equal(nativeSettings.reserveTokens, NATIVE_RESERVE_TOKENS, "the base object is never mutated");
  assert.equal(nativeSettings.keepRecentTokens, 20_000, "the SDK default stays");

  const tiered = wrapped.getCompactionSettings(model(ONE_M));
  assert.equal(tiered.enabled, true);
  assert.equal(tiered.reserveTokens, ONE_M - 524_288);
  assert.equal(tiered.keepRecentTokens, 65_536);

  // Everything else is the base manager's own behaviour.
  assert.equal(wrapped.getTheme(), "dark");
  assert.equal(wrapped.getCompactionEnabled(), true);
  assert.equal(wrapped.getSettings().theme, "dark");
  assert.ok(wrapped instanceof SettingsManager);

  // A write through the wrapper reaches the base manager, like `save()` does.
  wrapped.setCompactionEnabled(false);
  assert.equal(base.getCompactionEnabled(), false);
  assert.equal(wrapped.getCompactionSettings(model(ONE_M)).enabled, false);
});

test("an explicit reserveTokens in pi settings wins over the tier", () => {
  const base = manager({ compaction: { reserveTokens: 40_000 } });
  const wrapped = createCompactionSettingsManager(base, policy());
  const settings = wrapped.getCompactionSettings(model(ONE_M));
  assert.equal(settings.reserveTokens, 40_000);
  assert.equal(settings.keepRecentTokens, 20_000, "the whole resolved pair is the SDK's");
});

test("an explicit keepRecentTokens is respected inside a tiered mode", () => {
  const base = manager({ compaction: { keepRecentTokens: 131_072 } });
  const wrapped = createCompactionSettingsManager(base, policy());
  const settings = wrapped.getCompactionSettings(model(ONE_M));
  assert.equal(settings.keepRecentTokens, 131_072);
  assert.equal(settings.reserveTokens, ONE_M - 524_288);
});

test("an explicit keepRecentTokens is still clamped on a small window", () => {
  const base = manager({ compaction: { keepRecentTokens: 131_072 } });
  const wrapped = createCompactionSettingsManager(base, policy());
  const settings = wrapped.getCompactionSettings(model(WINDOW_128K));
  assert.equal(settings.keepRecentTokens, 32_768, "half of the 128K window's trigger");
});

test("native mode returns the base manager itself, untouched", () => {
  const base = manager({});
  assert.equal(createCompactionSettingsManager(base, policy({ mode: "native" })), base);
});

test("an unknown window makes the wrapper defer to the base settings", () => {
  const base = manager({ compaction: {} });
  const wrapped = createCompactionSettingsManager(base, policy());
  assert.deepEqual(wrapped.getCompactionSettings(model(undefined)), base.getCompactionSettings(model(undefined)));
  assert.deepEqual(wrapped.getCompactionSettings(undefined), base.getCompactionSettings(undefined));
});

test("a ≤16K window makes the wrapper defer to the base settings", () => {
  const base = manager({});
  const wrapped = createCompactionSettingsManager(base, policy());
  assert.deepEqual(wrapped.getCompactionSettings(model(16_384)), base.getCompactionSettings(model(16_384)));
});

test("delegated methods keep a stable identity and private fields work", () => {
  const wrapped = createCompactionSettingsManager(manager({}), policy());
  // A fresh bind() per read would make these unequal; t4/session code may hold
  // or compare method references.
  assert.equal(wrapped.getTheme, wrapped.getTheme);
  assert.equal(wrapped.getCompactionSettings, wrapped.getCompactionSettings);
  // Private fields must stay reachable through the proxy target.
  assert.doesNotThrow(() => wrapped.getSettings());
  assert.doesNotThrow(() => wrapped.getCompactionEnabled());
  assert.equal(typeof wrapped.flush(), "object");
});

test("compactionThresholdsFor reports the same numbers the wrapper applies", () => {
  const base = manager({});
  const wrapped = createCompactionSettingsManager(base, policy({ mode: "long" }));
  const settings = wrapped.getCompactionSettings(model(ONE_M));
  const thresholds = compactionThresholdsFor(base, policy({ mode: "long" }), model(ONE_M));
  assert.equal(thresholds.trigger, 838_860);
  assert.equal(ONE_M - settings.reserveTokens, thresholds.trigger);
  assert.equal(thresholds.keepRecentTokens, settings.keepRecentTokens);
});

test("compactionThresholdsByMode reports each tier's real trigger for the settings UI", () => {
  const base = manager({});
  const summary = compactionThresholdsByMode(base, policy(), model(WINDOW_128K));
  assert.deepEqual(summary.balanced, { trigger: 65_536, percent: 50, applied: true });
  assert.deepEqual(summary.long, { trigger: 104_857, percent: (104_857 / WINDOW_128K) * 100, applied: true });
  assert.deepEqual(summary.native, { trigger: WINDOW_128K - NATIVE_RESERVE_TOKENS, percent: ((WINDOW_128K - NATIVE_RESERVE_TOKENS) / WINDOW_128K) * 100, applied: true });

  // A window too small for the tier says so instead of repeating the label.
  const small = compactionThresholdsByMode(base, policy(), model(32_768));
  assert.deepEqual(small.balanced, {
    trigger: 32_768 - NATIVE_RESERVE_TOKENS,
    percent: 50,
    applied: false,
  });

  // An explicit pi reserve wins over every tier, so none of them is applied.
  const explicit = compactionThresholdsByMode(manager({ compaction: { reserveTokens: 40_000 } }), policy(), model(ONE_M));
  assert.equal(explicit.balanced.applied, false);
  assert.equal(explicit.long.applied, false);
  assert.equal(explicit.balanced.trigger, ONE_M - 40_000, "the base reserve's real trigger");
});