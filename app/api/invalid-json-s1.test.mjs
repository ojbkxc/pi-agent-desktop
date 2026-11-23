import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * S1 批次回归：**畸形的 JSON 必须是 400，不是 500，也不许回显解析器原文**。
 *
 * 这些路由此前把 `await req.json()` 放在一个 catch 一律 500 的 try 里：客户端发一个
 * `{` 就拿到 500，error 字段还带着 V8 的原话（"Expected property name or '}' in JSON
 * at position 1"）——状态码把责任推给服务器，正文又把实现细节送出去。
 *
 * 修法是统一走 `readJsonBody()`（lib/request-security.ts）。这里逐路由打真 handler：
 * 断言 400 + 无解析器措辞；同时抽查一条合法 JSON 仍能穿过闸门（不是把所有请求都拒了）。
 */
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-s1-json-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

const PARSER_NOISE = /Unexpected|JSON\.parse|position \d+|SyntaxError|Unexpected end of JSON input/i;

/** S1 清单：路由文件 + 导出的写方法。 */
const ROUTES = [
  ["./agent-guide/settings/route.ts", "PUT"],
  ["./artifacts/settings/route.ts", "PUT"],
  ["./artifacts/favorite/route.ts", "PUT"],
  ["./artifacts/file/route.ts", "PUT"],
  ["./chat-downloads/reveal/route.ts", "POST"],
  ["./chat-folder/reveal/route.ts", "POST"],
  ["./session-title/settings/route.ts", "PUT"],
  ["./subagents/settings/route.ts", "PUT"],
  ["./server-settings/route.ts", "PUT"],
  ["./models-config/test/route.ts", "POST"],
  ["./plugins/route.ts", "POST"],
  ["./skills/install/route.ts", "POST"],
  ["./skills/check/route.ts", "POST"],
  ["./skills/search/route.ts", "POST"],
  ["./skills/update/route.ts", "POST"],
  ["./sessions/[id]/chat-access/route.ts", "POST"],
  ["./fast-mode/route.ts", "PUT"],
  ["./public-access/route.ts", "PUT"],
  ["./remote-access/route.ts", "PUT"],
  ["./teams/fallback/route.ts", "PUT"],
];

for (const [file, method] of ROUTES) {
  test(`${file} answers 400 (not 500) for a malformed body`, async () => {
    const handler = (await jiti.import(file))[method];
    assert.equal(typeof handler, "function", `${file} must export ${method}`);

    const response = await handler(new Request(`http://localhost/api/${file}`, {
      method,
      headers: { "Content-Type": "application/json", Host: "localhost" },
      body: "{",
    }), { params: Promise.resolve({ id: "sess-1", team: "demo" }) });
    const text = await response.text();
    assert.equal(response.status, 400, `${file} ${method} answered ${response.status}: ${text}`);
    assert.doesNotMatch(text, PARSER_NOISE, `${file} leaked the parser error: ${text}`);
  });
}

test("the skills routes also gate Content-Type before parsing", async () => {
  for (const [file, method] of [
    ["./skills/check/route.ts", "POST"],
    ["./skills/search/route.ts", "POST"],
    ["./skills/update/route.ts", "POST"],
  ]) {
    const handler = (await jiti.import(file))[method];
    const response = await handler(new Request(`http://localhost/api/${file}`, {
      method,
      headers: { "Content-Type": "text/plain", Host: "localhost" },
      body: "{}",
    }));
    assert.equal(response.status, 415, `${file} must refuse a non-JSON content type`);
  }
});

test("a valid body still reaches field validation (the gate is not a blanket refusal)", async () => {
  const handler = (await jiti.import("./server-settings/route.ts")).PUT;
  const response = await handler(new Request("http://localhost/api/server-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({ serverPort: "not-a-port" }),
  }));
  // 字段不合法 → 400，但绝不是 500，也不是「Invalid JSON body」那种解析层回答。
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.notEqual(body.error, "Invalid JSON body", "the body parsed fine; this is field validation");
});