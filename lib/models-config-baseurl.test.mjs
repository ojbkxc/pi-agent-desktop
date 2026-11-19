import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { normalizeModelsConfigBaseUrls, normalizeProviderBaseUrl } = await jiti.import("./models-config-store.ts");

/**
 * 「Base URL 填不填 /v1 都能用」（2026-11-19 用户要求）。
 *
 * 各 SDK 的期望（node_modules 源码核实）：
 * - anthropic-messages：客户端自己拼 `/v1/messages` → baseUrl 不能带 /v1；
 * - google-generative-ai：`apiVersion: ""` → 必须带 /v1beta；
 * - openai-*：baseUrl 原样 + `/chat/completions` → 需要 /v1。
 * 归一化在写 models.json 时应用，用户粘贴带或不带都能正确工作。
 */

test("openai 类：不带版本段补 /v1", () => {
  assert.equal(normalizeProviderBaseUrl("https://api.example.com", "openai-completions"), "https://api.example.com/v1");
  assert.equal(normalizeProviderBaseUrl("https://api.example.com/", "openai-completions"), "https://api.example.com/v1");
  assert.equal(normalizeProviderBaseUrl("https://api.example.com/openai", "openai-responses"), "https://api.example.com/openai/v1");
});

test("openai 类：已带 /v1 保持不变（不重复补）", () => {
  assert.equal(normalizeProviderBaseUrl("https://api.example.com/v1", "openai-completions"), "https://api.example.com/v1");
  assert.equal(normalizeProviderBaseUrl("https://api.example.com/v1/", "openai-completions"), "https://api.example.com/v1");
});

test("粘贴整条端点：折叠到 API 根再加版本段", () => {
  assert.equal(
    normalizeProviderBaseUrl("https://api.example.com/v1/chat/completions", "openai-completions"),
    "https://api.example.com/v1",
  );
  assert.equal(
    normalizeProviderBaseUrl("https://api.example.com/chat/completions", "openai-completions"),
    "https://api.example.com/v1",
  );
  assert.equal(
    normalizeProviderBaseUrl("https://api.example.com/v1/messages", "anthropic-messages"),
    "https://api.example.com",
  );
});

test("anthropic：剥离结尾 /v1（SDK 自己拼 /v1/messages）", () => {
  assert.equal(normalizeProviderBaseUrl("https://api.example.com/v1", "anthropic-messages"), "https://api.example.com");
  assert.equal(normalizeProviderBaseUrl("https://api.example.com", "anthropic-messages"), "https://api.example.com");
  assert.equal(normalizeProviderBaseUrl("https://api.minimax.io/anthropic", "anthropic-messages"), "https://api.minimax.io/anthropic");
});

test("google：必须带 /v1beta", () => {
  assert.equal(
    normalizeProviderBaseUrl("https://generativelanguage.googleapis.com", "google-generative-ai"),
    "https://generativelanguage.googleapis.com/v1beta",
  );
  assert.equal(
    normalizeProviderBaseUrl("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai"),
    "https://generativelanguage.googleapis.com/v1beta",
  );
});

test("非标准版本路径不动（v4 coding 端点等真实布局）", () => {
  for (const url of [
    "https://api.z.ai/api/coding/paas/v4",
    "https://open.bigmodel.cn/api/coding/paas/v4",
    "https://api.groq.com/openai/v1",
  ]) {
    assert.equal(normalizeProviderBaseUrl(url, "openai-completions"), url, url);
  }
});

test("空值与非 URL 原样返回，不编造端点", () => {
  assert.equal(normalizeProviderBaseUrl("", "openai-completions"), "");
  assert.equal(normalizeProviderBaseUrl("   ", "openai-completions"), "   ");
  assert.equal(normalizeProviderBaseUrl("not a url", "openai-completions"), "not a url");
});

test("normalizeModelsConfigBaseUrls 覆盖 provider 与 per-model 覆盖", () => {
  const config = {
    providers: {
      proxy: { api: "openai-completions", baseUrl: "https://p.example.com", models: [{ id: "m1" }] },
      claude: { api: "anthropic-messages", baseUrl: "https://c.example.com/v1", models: [{ id: "m2" }] },
      multi: {
        api: "openai-completions",
        baseUrl: "https://m.example.com",
        models: [
          { id: "a" },
          { id: "b", api: "anthropic-messages", baseUrl: "https://m.example.com/v1" },
        ],
      },
      builtin: { models: [{ id: "x" }] },
    },
  };
  const out = normalizeModelsConfigBaseUrls(config);
  const providers = out.providers;
  assert.equal(providers.proxy.baseUrl, "https://p.example.com/v1");
  assert.equal(providers.claude.baseUrl, "https://c.example.com");
  const multiModels = providers.multi.models;
  assert.equal(multiModels[0].baseUrl, undefined, "未设置 baseUrl 的模型不得凭空获得一个");
  assert.equal(multiModels[1].baseUrl, "https://m.example.com", "per-model 覆盖按它自己的 api 归一化");
  assert.equal(providers.builtin.baseUrl, undefined, "内置 provider（无 baseUrl）不补");
  // 输入不被修改。
  assert.equal(config.providers.proxy.baseUrl, "https://p.example.com");
});