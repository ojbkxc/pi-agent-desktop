/**
 * The fast-mode verification list, in one place.
 *
 * These are the files that have to pass for the feature to be considered
 * working; `scripts/check-fast-mode.mjs` runs exactly this list so nobody has to
 * remember twelve paths, and `check-fast-mode.test.mjs` keeps the list honest
 * (every entry exists, every entry is a test file).
 */
export const FAST_MODE_CHECK_FILES = [
  // The feature itself.
  "lib/fast-mode/extension.test.mjs",
  "lib/fast-mode/command.test.mjs",
  "lib/fast-mode/integration.test.mjs",
  "app/api/fast-mode/route.test.mjs",
  // Its panel and the shared server round trip it runs on.
  "components/FastModeSettingRow.test.mjs",
  "components/server-setting-machine.test.mjs",
  "components/settings-copy-and-load-race.test.mjs",
  // The wiring guards it must not break.
  "lib/compaction-wiring.test.mjs",
  "components/SettingsPanel.test.mjs",
  "lib/i18n/usage.test.mjs",
  "lib/i18n/registry.test.mjs",
  // Its numbers.
  "scripts/measure-turns.test.mjs",
];

/**
 * 两种汇总行都要认：
 * - TAP（`--test-reporter=tap`，或旧版 node）：`# tests 12`
 * - spec（node ≥22 的默认 reporter）：`ℹ tests 12`（`ℹ` 后面可能跟一个 U+FE0F 变体选择符）
 *
 * 只认 TAP 的那一版在默认 reporter 下永远解析出 null，于是 `check-fast-mode.mjs`
 * 在**测试全绿**的情况下也退 1，`scripts/doc-commands.test.mjs` 跟着红。
 */
const SUMMARY_LINE = /^(?:#|ℹ\uFE0F?)\s*(tests|pass|fail|cancelled)\s+(\d+)\s*$/;

/** The summary counts node printed, or null when the output has none. */
export function parseTestSummary(output) {
  const counts = new Map();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = SUMMARY_LINE.exec(line.trim());
    if (!match) continue;
    // 同一份输出里 TAP 与 spec 不会混用，但重复出现的键以先到的为准。
    if (!counts.has(match[1])) counts.set(match[1], Number(match[2]));
  }
  if (!counts.has("tests")) return null;
  return {
    tests: counts.get("tests"),
    pass: counts.get("pass") ?? 0,
    fail: counts.get("fail") ?? 0,
    cancelled: counts.get("cancelled") ?? 0,
  };
}

/** Trailing `(12.75ms)` / `(2s)` the spec reporter puts after a test name. */
const SPEC_DURATION = /\s+\(\d+(?:\.\d+)?(?:ms|s)\)$/;

/**
 * Failing subtests, for the report. TAP spells them `not ok 2 - name`; spec puts a
 * `✖ name (12ms)` line in the run and repeats the name under "failing tests:",
 * so the same name shows up twice — dedupe instead of double-reporting.
 */
export function parseFailures(output) {
  const names = [];
  const seen = new Set();
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    let name = null;
    const tap = /^not ok \d+ - (.*)$/.exec(line);
    if (tap) name = tap[1];
    else if (line.startsWith("✖ ")) name = line.slice(2);
    if (name === null) continue;
    name = name.replace(SPEC_DURATION, "").trim();
    // `✖ failing tests:` 是那一段的标题，不是一条失败用例。
    if (!name || name.endsWith(":") || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
