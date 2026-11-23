import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-purge-preview-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { defaultPurgeSettings } = await jiti.import("@/lib/purge/types.ts");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function post(body, { contentType = "application/json", host = "localhost", origin } = {}) {
  const headers = { Host: host };
  if (contentType !== null) headers["Content-Type"] = contentType;
  if (origin) headers.Origin = origin;
  return new Request("http://localhost/api/purge/preview", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("a draft settings object is honoured without saving anything", async () => {
  const settings = {
    ...defaultPurgeSettings(),
    enabled: true,
    dead_zone_rewrite: true,
    rewrite_rules: [{ from: "foo", to: "bar" }],
  };
  const response = await POST(post({ text: "foo and foo", kind: "user", settings }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.output, "bar and bar");
  assert.equal(body.preview.rewrite_hits, 2);
  assert.equal(body.preview.passthrough, false);
});

test("omitting settings falls back to the stored ones (read-only)", async () => {
  // 新 agent dir 里没有设置文件：回落到默认（enabled 默认开）。
  const response = await POST(post({ text: "plain", kind: "user" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.input, "plain");
});

test("every gate answers in order: 403, 415, 400 (JSON), 400 (field)", async () => {
  const denied = await POST(post({ text: "x" }, { host: "evil.example.com", origin: "https://evil.example.com" }));
  assert.equal(denied.status, 403);

  const wrongType = await POST(post({ text: "x" }, { contentType: "text/plain" }));
  assert.equal(wrongType.status, 415);

  const malformed = await POST(post("{"));
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /Unexpected|JSON\.parse|position \d+/i);

  const notAnObject = await POST(post([1, 2, 3]));
  assert.equal(notAnObject.status, 400);

  const missingText = await POST(post({ kind: "user" }));
  assert.equal(missingText.status, 400);
  assert.match((await missingText.json()).error, /text must be a string/);
});

test("an oversized sample is refused instead of processed", async () => {
  const response = await POST(post({ text: "x".repeat(20_001), kind: "user" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /limited to/);
});

test("the answer is never cached", async () => {
  const response = await POST(post({ text: "x", kind: "user" }));
  assert.equal(response.headers.get("cache-control"), "no-store");
});