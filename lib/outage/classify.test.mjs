import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Provider 故障四分类矩阵（docs/agents/fork-provider-outage-resume.md §7）。
 * 词表来自 pi-ai 1.5.0 dist/utils/retry.js（复制件在 classify.ts 里注明行号）。
 */

const jiti = createJiti(import.meta.url);
const { classifyOutageError, classifyRetryAfter } = await jiti.import("./classify.ts");

function kindOf(text, statusCode) {
  return classifyOutageError({ errorText: text, statusCode }).kind;
}

test("outage：5xx / 连接 / DNS / 服务不可用 / 上游错误 / 流中断", () => {
  const cases = [
    "upstream 503 Service Unavailable",
    "connect ECONNREFUSED 127.0.0.1:9",
    "getaddrinfo ENOTFOUND api.example.com",
    "The service is temporarily unavailable",
    "The upstream provider returned an error",
    "stream was interrupted",
    "fetch failed",
    "socket hang up",
    "connection reset before headers",
    "http2 request did not get a response",
  ];
  for (const text of cases) {
    assert.equal(kindOf(text), "outage", text);
    assert.equal(classifyOutageError({ errorText: text }).suspend, true, text);
  }
});

test("transient：429 短限流 / 单次抖动（交回 SDK 的 3 次重试）", () => {
  const cases = [
    "429 Too Many Requests",
    "rate limit exceeded, retry shortly",
    "model is at capacity",
    "overloaded",
    "ResourceExhausted",
  ];
  for (const text of cases) {
    const result = classifyOutageError({ errorText: text });
    assert.equal(result.kind, "transient", text);
    assert.equal(result.suspend, false, text);
  }
});

test("quota：insufficient_quota / quota exceeded / billing / Zhipu 1308 / usage limit", () => {
  const cases = [
    "insufficient_quota",
    "quota exceeded for this billing period",
    "billing hard limit reached",
    '{"code": 1308, "message": "usage limit"}',
    "Monthly usage limit reached",
    "out of budget",
    "FreeUsageLimitError",
  ];
  for (const text of cases) {
    const result = classifyOutageError({ errorText: text });
    assert.equal(result.kind, "quota", text);
    assert.equal(result.suspend, true, text);
  }
});

test("terminal：401/403 鉴权、模型不存在、400 参数错 —— 绝不挂起", () => {
  const cases = [
    "401 Unauthorized",
    "403 Forbidden",
    "invalid api key",
    "Authentication failed for \"openai\"",
    "model not found: gpt-9",
    "Invalid request: messages must not be empty",
    "context_length_exceeded",
  ];
  for (const text of cases) {
    const result = classifyOutageError({ errorText: text });
    assert.equal(result.kind, "terminal", text);
    assert.equal(result.suspend, false, text);
  }
});

test("状态码优先于文本：401/403/404 直接 terminal，429 看文本", () => {
  assert.equal(classifyOutageError({ errorText: "server error", statusCode: 401 }).kind, "terminal");
  assert.equal(classifyOutageError({ errorText: "server error", statusCode: 403 }).kind, "terminal");
  assert.equal(classifyOutageError({ errorText: "server error", statusCode: 404 }).kind, "terminal");
  assert.equal(classifyOutageError({ errorText: "slow down", statusCode: 429 }).kind, "transient");
  assert.equal(classifyOutageError({ errorText: "insufficient_quota", statusCode: 429 }).kind, "quota");
});

test("retry-after 长值归 outage；短值仍 transient", () => {
  assert.equal(classifyRetryAfter(300_000).kind, "outage");
  assert.equal(classifyRetryAfter(300_000).suspend, true);
  assert.equal(classifyRetryAfter(5_000).kind, "transient");
  assert.equal(classifyRetryAfter(5_000).suspend, false);
});

test("空文本 / 未知文本：不挂起（绝不因看不懂而挂起）", () => {
  assert.equal(classifyOutageError({ errorText: "" }).suspend, false);
  assert.equal(classifyOutageError(null).suspend, false);
  assert.equal(classifyOutageError("something entirely unrecognized").suspend, false);
});

test("suspend 仅对 outage / quota 为 true", () => {
  const samples = {
    outage: "upstream 502",
    quota: "quota exceeded",
    transient: "429 too many requests",
    terminal: "401 Unauthorized",
  };
  for (const [kind, text] of Object.entries(samples)) {
    assert.equal(classifyOutageError({ errorText: text }).suspend, kind === "outage" || kind === "quota", text);
  }
});

test("鉴权文案 + 5xx 状态码 ⇒ outage（网关转发的上游挂掉，不是用户凭据问题）", () => {
  assert.equal(classifyOutageError({ errorText: "authentication failed", statusCode: 502 }).kind, "outage");
});