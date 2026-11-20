import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  AUTOPILOT_DEFAULTS,
  MAX_AUTOPILOT_FIX_ROUNDS,
  readAutopilotSettings,
  writeAutopilotSettings,
  isAutopilotEnabled,
} = await jiti.import("./autopilot.ts");

const dir = await mkdtemp(join(tmpdir(), "pi-web-autopilot-"));
after(async () => { await rm(dir, { recursive: true, force: true }); });
const settingsPath = () => join(dir, `settings-${Math.random().toString(16).slice(2)}.json`);

test("默认：开启，子开关为安全默认值", () => {
  const settings = readAutopilotSettings(settingsPath());
  assert.equal(settings.enabled, true, "无人值守默认开启（用户要求）");
  assert.equal(settings.autoApproveTeamPlans, true);
  assert.equal(settings.autoFixFailedRuns, true);
  assert.equal(settings.maxAutoFixRounds, AUTOPILOT_DEFAULTS.maxAutoFixRounds);
  assert.equal(isAutopilotEnabled(settingsPath()), true);
});

test("写入后读回；部分更新不影响其他字段", () => {
  const path = settingsPath();
  const written = writeAutopilotSettings({ enabled: true, maxAutoFixRounds: 3 }, path);
  assert.equal(written.enabled, true);
  assert.equal(written.maxAutoFixRounds, 3);
  assert.equal(written.autoFixFailedRuns, true, "未传的字段保持默认");

  const partial = writeAutopilotSettings({ autoFixFailedRuns: false }, path);
  assert.equal(partial.enabled, true, "已有值保留");
  assert.equal(partial.autoFixFailedRuns, false);
  assert.equal(readAutopilotSettings(path).enabled, true);
});

test("损坏/非对象设置回落到默认（开启）", async () => {
  const path = settingsPath();
  await writeFile(path, "{not json", "utf8");
  const settings = readAutopilotSettings(path);
  assert.equal(settings.enabled, true);
  assert.equal(settings.autoFixFailedRuns, true);
});

test("maxAutoFixRounds 边界：0 / 超上限 / 非整数拒绝", () => {
  const path = settingsPath();
  for (const bad of [0, -1, MAX_AUTOPILOT_FIX_ROUNDS + 1, 1.5, Number.NaN]) {
    assert.throws(() => writeAutopilotSettings({ maxAutoFixRounds: bad }, path), RangeError, String(bad));
  }
  const ok = writeAutopilotSettings({ maxAutoFixRounds: MAX_AUTOPILOT_FIX_ROUNDS }, path);
  assert.equal(ok.maxAutoFixRounds, MAX_AUTOPILOT_FIX_ROUNDS);
});
