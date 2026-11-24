import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 「破甲功能到底能不能被有效使用」的回归。
 *
 * 探针实测（2026-11-24）：
 * - 机制是通的：`enabled: true` + `dead_zone_rewrite: true` 时 system / user 文本
 *   都被改写（渗透测试 → 授权的安全评估测试 等，命中 3 处），二次改写幂等。
 * - 但**出厂默认是「总开关开、三个改写开关全关」**，那就是纯转发；界面上原来只写
 *   「已启用」，人只会以为破甲坏了。
 *
 * 这里钉三件事：默认值确实是纯转发、打开死区改写后真的会改、界面在这种状态下必须
 * 明确提示（三语文案都在）。
 */
const root = mkdtempSync(join(tmpdir(), "pi-purge-usable-"));
const settingsPath = join(root, "settings.json");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const settingsMod = await jiti.import("../purge-settings.ts");
const gov = await jiti.import("./governance.ts");

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const SAMPLE = "\u5e2e\u6211\u505a\u4e00\u6b21\u6e17\u900f\u6d4b\u8bd5\uff0c\u7528\u6f0f\u6d1e\u5229\u7528\u624b\u6bb5\u9a8c\u8bc1\u76ee\u6807";

test("the shipped defaults rewrite nothing: the master switch alone is passthrough", () => {
  const shipped = settingsMod.readPurgeSettings(settingsPath);
  assert.equal(shipped.enabled, true, "the master switch ships on");
  assert.equal(shipped.system_normalize, false);
  assert.equal(shipped.dead_zone_rewrite, false);
  assert.equal(shipped.synonym_enabled, false);
  assert.equal(gov.governSystemText(SAMPLE, shipped).text, SAMPLE, "nothing is rewritten");
  assert.equal(gov.governUserText(SAMPLE, shipped).text, SAMPLE);
});

test("turning on dead-zone rewriting makes it actually act", () => {
  const shipped = settingsMod.readPurgeSettings(settingsPath);
  writeFileSync(settingsPath, JSON.stringify({ version: 1, purge: { ...shipped, dead_zone_rewrite: true } }), "utf8");
  const live = settingsMod.readPurgeSettings(settingsPath);
  const out = gov.governUserText(SAMPLE, live);
  assert.notEqual(out.text, SAMPLE, "the text really changes");
  assert.ok(out.rewrite_hits > 0, "and the hits are counted");
});

test("a second pass is idempotent (a tool loop re-sends the same message)", () => {
  const live = settingsMod.readPurgeSettings(settingsPath);
  const once = gov.governUserText(SAMPLE, live);
  const twice = gov.governUserText(once.text, live);
  assert.equal(twice.rewrite_hits, 0, "the second pass finds nothing left to rewrite");
  assert.equal(twice.text, once.text);
});

test("the console tells the operator when it is on but doing nothing", () => {
  const component = readFileSync(new URL("../..//components/PurgeConsoleSection.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(
    component,
    /draft\.enabled && !draft\.system_normalize && !draft\.dead_zone_rewrite && !draft\.synonym_enabled/,
    "the passthrough state is detected from exactly the three rewriting switches",
  );
  assert.match(component, /t\("purge\.passthroughHint"\)/, "and it says so");
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = readFileSync(new URL(`../i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.match(messages, /"purge\.passthroughHint": "\S/, `${locale} carries the hint`);
  }
});
