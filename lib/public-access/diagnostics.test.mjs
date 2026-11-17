import assert from "node:assert/strict";
import test from "node:test";

const {
  sanitizeDiagnosticText,
  sanitizeDiagnostic,
  recordDiagnostic,
  recentDiagnostics,
  clearDiagnostics,
  diagnosticBuffer,
  withDiagnostic,
  DIAGNOSTIC_BUFFER_MAX,
} = await import("./diagnostics.ts");

const TOKEN = Buffer.from(JSON.stringify({ a: "acct", t: "12345678-1234-1234-1234-123456789012", s: "c2VjcmV0" })).toString("base64");

/** 临时静音 recordDiagnostic 的 console.log（它每写一条都会打一行）。 */
function silenceConsole(fn) {
  const original = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = original; }
}

test("脱敏：tunnel token 字面值、代理 user:pass（含 base64）、eyJ 形态、URL query", () => {
  // tunnel token 字面值整体替换
  const withToken = sanitizeDiagnosticText(`failed to parse ${TOKEN}`, [TOKEN]);
  assert.equal(withToken.includes(TOKEN), false, "token 原文必须消失");
  assert.match(withToken, /\[REDACTED\]/);

  // 代理 URL 的 user:pass 明文与 base64 两种形态都替换
  const proxyUrl = "http://alice:s3cr3t@proxy.example:8080";
  const withProxy = sanitizeDiagnosticText(
    `connect alice:s3cr3t via ${Buffer.from("alice:s3cr3t").toString("base64")} to proxy.example`,
    [proxyUrl],
  );
  assert.equal(withProxy.includes("s3cr3t"), false, "口令明文必须消失");
  assert.equal(withProxy.includes(Buffer.from("alice:s3cr3t").toString("base64")), false, "口令 base64 也必须消失");

  // eyJ 形态（JWT / cloudflared token）一律遮掉
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgHIJKLMNOP";
  const withJwt = sanitizeDiagnosticText(`bearer ${jwt}`, []);
  assert.equal(withJwt.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);

  // URL 的 query / fragment 遮掉，但 host 与 path 保留（便于定位）
  const withQuery = sanitizeDiagnosticText("see https://api.example.com/tunnel?token=abc#frag", []);
  assert.equal(withQuery.includes("token=abc"), false, "query 必须遮掉");
  assert.match(withQuery, /https:\/\/api\.example\.com\/tunnel\?\[REDACTED\]/);
});

test("sanitizeDiagnostic：深度清洗 error 对象与 details，且保留受控机器值", () => {
  const error = new Error(`boom ${TOKEN}`);
  error.code = "ECONNREFUSED";
  const cleaned = sanitizeDiagnostic(
    {
      stage: "proxy_connect",
      outcome: "failed",
      reason: "connect_timeout",
      durationMs: 1234.6,
      error,
      details: { proxyHost: "127.0.0.1", proxyPort: 8080, nested: { secret: TOKEN } },
    },
    [TOKEN],
  );
  assert.equal(JSON.stringify(cleaned).includes(TOKEN), false, "错误与 details 里的 token 都要被清洗");
  assert.equal(cleaned.error.code, "ECONNREFUSED", "机器码保留");
  assert.equal(cleaned.durationMs, 1235, "耗时四舍五入为整数");
  assert.equal(cleaned.stage, "proxy_connect");
  assert.equal(cleaned.details.proxyHost, "127.0.0.1", "host 这类机器值原样保留");
});

test("recordDiagnostic 环形缓冲封顶 DIAGNOSTIC_BUFFER_MAX（40）", () => {
  silenceConsole(() => {
    clearDiagnostics();
    for (let index = 0; index < DIAGNOSTIC_BUFFER_MAX + 10; index += 1) {
      recordDiagnostic({ stage: "preparing", outcome: "started", reason: `n${index}` });
    }
  });
  assert.equal(DIAGNOSTIC_BUFFER_MAX, 40);
  assert.equal(diagnosticBuffer().length, 40, "超过上限就丢最旧的");
  const recent = recentDiagnostics(100);
  assert.equal(recent.length, 40, "缓冲里最多 40 条");
  assert.equal(recent.at(-1).reason, "n49", "最新的在最后");
  assert.equal(recent[0].reason, "n10", "最旧的 10 条被挤掉");
  assert.equal(recentDiagnostics().length, 20, "默认只回最近 20 条（status.diagnostics）");
  assert.equal(recentDiagnostics(5).length, 5, "limit 生效");
});

test("recordDiagnostic 永不抛：坏输入也不影响调用方", () => {
  silenceConsole(() => {
    assert.doesNotThrow(() => recordDiagnostic({ stage: "x", outcome: "started", error: { toString() { throw new Error("nope"); } } }));
  });
});

test("withDiagnostic：started/succeeded、返回值透传、describe 进 details", async () => {
  const events = [];
  const result = await withDiagnostic((event) => events.push(event), { stage: "verifying", attemptId: "11111111-1111-1111-1111-111111111111" }, async () => {
    return { url: "https://x.trycloudflare.com" };
  }, (value) => ({ url: value.url }));
  assert.deepEqual(result, { url: "https://x.trycloudflare.com" }, "返回值原样透传");
  assert.equal(events.length, 2);
  assert.equal(events[0].outcome, "started");
  assert.equal(events[1].outcome, "succeeded");
  assert.equal(events[1].details.url, "https://x.trycloudflare.com");
  assert.equal(typeof events[1].durationMs, "number");
});

test("withDiagnostic：失败记录 failed + reason(code) 并原样抛出", async () => {
  const events = [];
  const thrown = new Error("kaboom");
  thrown.code = "network";
  await assert.rejects(
    withDiagnostic((event) => events.push(event), { stage: "registering" }, async () => { throw thrown; }),
    (error) => {
      assert.equal(error, thrown, "抛出的必须是同一个错误对象（透传）");
      return true;
    },
  );
  assert.equal(events.at(-1).outcome, "failed");
  assert.equal(events.at(-1).reason, "network", "从 error.code 取 reason");
  assert.equal(events.at(-1).error, thrown);
});

test("withDiagnostic：writer 缺省（undefined）时照常执行", async () => {
  assert.equal(await withDiagnostic(undefined, { stage: "preparing" }, async () => 42), 42);
});
