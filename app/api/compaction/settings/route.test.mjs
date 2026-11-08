import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-compaction-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const settingsPath = join(testAgentDir, "pi-web", "settings.json");

function putRequest(body, { contentType = "application/json", origin } = {}) {
  const headers = { "Content-Type": contentType, Host: "localhost" };
  if (origin) headers.Origin = origin;
  return new Request("http://localhost/api/compaction/settings", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET returns the policy, its defaults, limits and candidate list", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.policy, {
    mode: "balanced",
    keepRecentTokens: 65536,
    compactionModel: "auto",
    preferredModels: [],
  });
  assert.deepEqual(body.defaults, body.policy);
  assert.deepEqual(body.limits, {
    keepRecentTokens: { min: 16384, max: 262144, default: 65536 },
    preferredModels: { max: 8 },
  });
  assert.ok(Array.isArray(body.candidates));
  for (const candidate of body.candidates) {
    assert.equal(typeof candidate.provider, "string");
    assert.equal(typeof candidate.modelId, "string");
    assert.equal(typeof candidate.label, "string");
    assert.equal(typeof candidate.priceConfirmed, "boolean");
    assert.equal("apiKey" in candidate, false);
  }
});

test("PUT refuses an untrusted origin and a non-JSON content type", async () => {
  let response = await PUT(putRequest({ mode: "long" }, { origin: "https://evil.example" }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted API request" });

  response = await PUT(putRequest({ mode: "long" }, { contentType: "text/plain" }));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json" });
});

test("PUT refuses a malformed body and every invalid field", async () => {
  let response = await PUT(putRequest("{not json"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON body" });

  const refuses = async (body, pattern) => {
    const result = await PUT(putRequest(body));
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.match((await result.json()).error, pattern);
  };

  await refuses({}, /No compaction settings/);
  await refuses({ mode: "cheap" }, /mode must be one of balanced, long, native/);
  await refuses({ compactionModel: "free" }, /compactionModel must be one of auto, current, preferred/);
  await refuses({ keepRecentTokens: 16383 }, /between 16384 and 262144/);
  await refuses({ keepRecentTokens: 262145 }, /between 16384 and 262144/);
  await refuses({ keepRecentTokens: 65536.5 }, /between 16384 and 262144/);
  await refuses({ preferredModels: ["openai"] }, /at most 8/);
  await refuses({ preferredModels: Array(9).fill("a/b") }, /at most 8/);
  await refuses({ keep_recent: 1 }, /Unknown compaction setting: keep_recent/);
});

test("PUT applies a partial patch, merges atomically and keeps other keys", async () => {
  mkdirSync(join(testAgentDir, "pi-web"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ other: 1, artifactsPrompt: false }));

  let response = await PUT(putRequest({ mode: "long", compactionModel: "preferred" }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).policy, {
    mode: "long",
    keepRecentTokens: 65536,
    compactionModel: "preferred",
    preferredModels: [],
  });

  response = await PUT(putRequest({ preferredModels: ["acme/flash"], keepRecentTokens: 32768 }));
  assert.deepEqual((await response.json()).policy, {
    mode: "long",
    keepRecentTokens: 32768,
    compactionModel: "preferred",
    preferredModels: ["acme/flash"],
  });

  const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(stored.other, 1);
  assert.equal(stored.artifactsPrompt, false);
  assert.deepEqual(stored.compactionPolicy, {
    mode: "long",
    keepRecentTokens: 32768,
    compactionModel: "preferred",
    preferredModels: ["acme/flash"],
  });

  // The next GET reads the same effective policy back.
  const body = await (await GET()).json();
  assert.deepEqual(body.policy, stored.compactionPolicy);
});
