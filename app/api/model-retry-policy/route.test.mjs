import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

/**
 * `/api/model-retry-policy` 的读写闸门。
 *
 * 策略是用户要求的核心能力（每个模型 API 自己选重试策略，含「所有错误持续重试到
 * 成功或停止」）。这个端点写 pi-web 自己的 settings.json，**不动 models.json**——
 * 后者是 pi 的配置格式，多塞字段会被它当成非法 provider 键。
 */
const root = mkdtempSync(join(tmpdir(), "pi-web-retry-api-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET, PUT } = await jiti.import("../../../../app/api/model-retry-policy/route.ts");
const store = await jiti.import("../../../../lib/outage/retry-policy-store.ts");
const { getPiWebSettingsPath } = await jiti.import("../../../../lib/artifact-settings.ts");

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const settingsPath = getPiWebSettingsPath(agentDir);
const headers = { Host: "localhost" };
const get = (query = "") =>
  GET(new NextRequest(`http://localhost/api/model-retry-policy${query}`, { headers }), { params: Promise.resolve({}) });
const put = (body, contentType = "application/json") => {
  const headersWithType = { ...headers };
  if (contentType) headersWithType["Content-Type"] = contentType;
  return PUT(new NextRequest("http://localhost/api/model-retry-policy", {
    method: "PUT", headers: headersWithType, body: JSON.stringify(body),
  }));
};

test("GET without a provider returns the whole table", async () => {
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.policies, ["default", "transient", "all"]);
  assert.deepEqual(body.providers, {});
  assert.equal(body.wildcard, "default");
});

test("PUT sets a policy, GET per-provider reports it, and it reaches settings.json", async () => {
  const response = await put({ provider: "openai", policy: "all" });
  assert.equal(response.status, 200);
  const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(stored.modelRetryPolicy.providers, { openai: "all" });

  const read = await get("?provider=openai");
  assert.equal(read.status, 200);
  assert.equal((await read.json()).policy, "all");
});

test("an unknown policy is refused before anything is written", async () => {
  const response = await put({ provider: "openai", policy: "sometimes" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "policy must be one of default, transient, all");
  assert.deepEqual(store.readModelRetryPolicySettings(settingsPath).providers, { openai: "all" });
});

test("a missing provider id is refused", async () => {
  assert.equal((await put({ policy: "all" })).status, 400);
  assert.equal((await put({ provider: "   ", policy: "all" })).status, 400);
});

test("a non-positive wait is refused", async () => {
  assert.equal((await put({ allMaxWaitHours: 0 })).status, 400);
  assert.equal((await put({ allMaxWaitHours: -1 })).status, 400);
});

test("a non-JSON body is 415 and malformed JSON is 400", async () => {
  const wrongType = await put({ provider: "x", policy: "all" }, "text/plain");
  assert.equal(wrongType.status, 415);
  // The media type must be right for the 400 to be about the JSON, not the header.
  const malformed = await PUT(new NextRequest("http://localhost/api/model-retry-policy", {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{",
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "Invalid JSON body");
});

test("a cross-origin request is refused on both methods", async () => {
  const origin = { Host: "localhost", Origin: "https://evil.example.com" };
  assert.equal((await GET(new NextRequest("http://localhost/api/model-retry-policy", { headers: origin }), { params: Promise.resolve({}) })).status, 403);
  assert.equal((await PUT(new NextRequest("http://localhost/api/model-retry-policy", {
    method: "PUT", headers: origin, body: JSON.stringify({ provider: "x", policy: "all" }),
  }))).status, 403);
});