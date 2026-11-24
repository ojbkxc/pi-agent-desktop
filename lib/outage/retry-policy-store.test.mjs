import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * 按 provider 的策略落盘与回读（`~/.pi/agent/pi-web/settings.json` 的
 * `modelRetryPolicy` 键）。口径与 `readOutageSettings` 一致：文件坏了退回默认——
 * 错在「按默认跑」代价小，错在「策略丢了」看起来像功能坏了。
 */
const root = mkdtempSync(join(tmpdir(), "pi-web-retry-policy-"));
const settingsPath = join(root, "settings.json");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const store = await jiti.import("./retry-policy-store.ts");

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

test("a missing file reads as the defaults, and writing only adds one key", () => {
  assert.deepEqual(store.readModelRetryPolicySettings(settingsPath), {
    providers: {},
    allMaxWaitHours: store.MODEL_RETRY_POLICY_DEFAULTS.allMaxWaitHours,
  });

  // An unrelated key already in the file must survive a write.
  writeFileSync(settingsPath, JSON.stringify({ version: 1, artifactsPrompt: false }), "utf8");
  store.setProviderModelRetryPolicy("openai", "all", settingsPath);
  const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(stored.artifactsPrompt, false, "other settings keys are left alone");
  assert.deepEqual(stored.modelRetryPolicy.providers, { openai: "all" });
});

test("setting a provider back to `default` removes the entry instead of storing it", () => {
  store.setProviderModelRetryPolicy("openai", "all", settingsPath);
  store.setProviderModelRetryPolicy("anthropic", "transient", settingsPath);
  let settings = store.readModelRetryPolicySettings(settingsPath);
  assert.deepEqual(settings.providers, { openai: "all", anthropic: "transient" });

  store.setProviderModelRetryPolicy("openai", "default", settingsPath);
  settings = store.readModelRetryPolicySettings(settingsPath);
  assert.deepEqual(settings.providers, { anthropic: "transient" }, "the default entry is dropped, not written as `default`");
});

test("effective policy: exact provider, then the wildcard, then the default", () => {
  const settings = {
    providers: { openai: "all", "*": "transient" },
    allMaxWaitHours: 24,
  };
  assert.equal(store.effectiveModelRetryPolicy("openai", settings), "all");
  assert.equal(store.effectiveModelRetryPolicy("anthropic", settings), "transient", "the wildcard covers the rest");
  assert.equal(store.effectiveModelRetryPolicy(null, settings), "transient");
  assert.equal(
    store.effectiveModelRetryPolicy("anthropic", { providers: {}, allMaxWaitHours: 24 }),
    "default",
    "no configuration at all means today's behaviour",
  );
});

test("a corrupted file falls back to the defaults instead of throwing", () => {
  writeFileSync(settingsPath, "{not json", "utf8");
  assert.deepEqual(store.readModelRetryPolicySettings(settingsPath).providers, {});
  // …and a junk shape inside a readable file is normalised, not trusted.
  writeFileSync(settingsPath, JSON.stringify({ modelRetryPolicy: { providers: { openai: "nope" }, allMaxWaitHours: -5 } }), "utf8");
  const settings = store.readModelRetryPolicySettings(settingsPath);
  assert.deepEqual(settings.providers, {}, "unknown policy values are dropped");
  // 默认是 0 = 不限（「几天几夜还在请求」）；坏值也落回这个默认，不会变成「立刻过期」。
  assert.equal(settings.allMaxWaitHours, store.MODEL_RETRY_POLICY_DEFAULTS.allMaxWaitHours);
  assert.equal(settings.allMaxWaitHours, 0, "the default is `no ceiling`");
});

test("an empty provider id is refused", () => {
  assert.throws(() => store.setProviderModelRetryPolicy("   ", "all", settingsPath), /provider id/i);
});