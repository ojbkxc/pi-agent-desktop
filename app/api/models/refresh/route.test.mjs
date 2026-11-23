import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * `/api/models/refresh` 的两条「有意等价」与一条真缺陷（api-guard 审计）：
 *
 * - 裸 POST（无 body）是合法调用：语义就是「现在刷新全部」，不是「解析失败」。
 * - 因此这条端点**不强制** Content-Type：415 会把 curl / 脚本这类无害调用打成失败。
 * - 但**畸形 JSON 必须是 400**：以前它和空 body 共用一个 catch，一个打错的 `{`
 *   会静默触发对全部 provider 的全量网络请求——拼写错误变成一次全量刷新。
 */
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-models-refresh-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  delete process.env.PI_OFFLINE;
});

function post(body, { contentType = "application/json", host = "localhost", origin } = {}) {
  const headers = { Host: host };
  if (contentType) headers["Content-Type"] = contentType;
  if (origin) headers.Origin = origin;
  return new Request("http://localhost/api/models/refresh", {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

test("a bare POST with no body still means every provider (no 415, no 400)", async () => {
  // PI_OFFLINE 让刷新立刻返回 { completed: false, reason: "offline" } —— 断言的是
  // 「请求被接受并走到刷新」，不是网络结果。
  const response = await POST(post(undefined, { contentType: null }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reason, "offline");
});

test("a malformed JSON body is 400, not a silent full refresh", async () => {
  const response = await POST(post("{"));
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text, JSON.stringify({ error: "Invalid JSON body" }));
  assert.doesNotMatch(text, /Unexpected|JSON\.parse|position \d+/i, "the parser's words stay server-side");
});

test("a body with a non-JSON content type is refused once it is not empty", async () => {
  const response = await POST(post("provider=x", { contentType: "text/plain" }));
  assert.equal(response.status, 415);
});

test("a whitespace-only body counts as no body", async () => {
  const response = await POST(post("   \n\t "));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reason, "offline");
});

test("a provider field narrows the refresh; a junk body without one does not crash", async () => {
  const named = await POST(post(JSON.stringify({ provider: "  kimi-coding  " })));
  assert.equal(named.status, 200);
  const junk = await POST(post(JSON.stringify({ nope: 1 })));
  assert.equal(junk.status, 200, "an object without a provider still means every provider");
  const scalar = await POST(post(JSON.stringify(42)));
  assert.equal(scalar.status, 200, "a JSON scalar is a legal body with no provider");
});

test("a cross-origin browser request is refused with 403", async () => {
  const response = await POST(post(JSON.stringify({}), { origin: "https://evil.example.com" }));
  assert.equal(response.status, 403);
});