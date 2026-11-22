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

/** The TAP summary node's counts, or null when the block has none. */
export function parseTestSummary(output) {
  const number = (label) => {
    const match = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
    return match ? Number(match[1]) : null;
  };
  const tests = number("tests");
  if (tests === null) return null;
  return {
    tests,
    pass: number("pass") ?? 0,
    fail: number("fail") ?? 0,
    cancelled: number("cancelled") ?? 0,
  };
}

/** Failing subtests, as `not ok N - name` lines, for the report. */
export function parseFailures(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => /^not ok \d+ - /.test(line))
    .map((line) => line.replace(/^not ok \d+ - /, "").trim());
}
