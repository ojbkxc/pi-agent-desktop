import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-purge-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const { defaultPurgeSettings } = await jiti.import("@/lib/purge/types.ts");

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const settingsPath = join(testAgentDir, "pi-web", "settings.json");

function putRequest(body, { contentType = "application/json", origin, host = "localhost" } = {}) {
  const headers = { "Content-Type": contentType, Host: host };
  if (origin) headers.Origin = origin;
  return new Request("http://localhost/api/purge", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function getRequest({ origin, host = "localhost" } = {}) {
  const headers = { Host: host };
  if (origin) headers.Origin = origin;
  return new Request("http://localhost/api/purge", { headers });
}

test("GET returns the settings, the stats and the runtime block", async () => {
  const response = await GET(getRequest());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);

  const body = await response.json();
  assert.deepEqual(body.settings, defaultPurgeSettings());

  assert.deepEqual(Object.keys(body.stats).sort(), [
    "auto_preset_hits",
    "reasoning_clamps",
    "requests",
    "rewrite_hits",
    "skill_hits",
    "started_at",
    "structured_appends",
    "synonym_hits",
  ]);
  for (const [key, value] of Object.entries(body.stats)) {
    assert.equal(typeof value, "number", `stats.${key} must be a number`);
    assert.ok(Number.isFinite(value), `stats.${key} must be finite`);
  }
  assert.ok(body.stats.started_at > 0);

  assert.equal(body.runtime.pid, process.pid);
  assert.equal(typeof body.runtime.uptime_secs, "number");
  assert.ok(Number.isInteger(body.runtime.uptime_secs));
  assert.ok(body.runtime.uptime_secs >= 0);
});

test("PUT accepts a bare settings object and returns the normalized settings", async () => {
  const response = await PUT(putRequest({
    enabled: true,
    system_normalize: true,
    reasoning_floor: "high",
    rewrite_rules: [{ from: "甲", to: "乙" }],
    skill_inject_limit: 1,
    bogus_key: "dropped",
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.enabled, true);
  assert.equal(body.settings.system_normalize, true);
  assert.equal(body.settings.reasoning_floor, "high");
  assert.deepEqual(body.settings.rewrite_rules, [{ from: "甲", to: "乙" }]);
  // Clamped into PURGE_LIMITS.skill_inject_limit.min.
  assert.equal(body.settings.skill_inject_limit, 16);
  assert.equal("bogus_key" in body.settings, false);

  // Persisted, and visible to the next GET.
  const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(stored.purge.enabled, true);
  assert.equal(JSON.stringify(stored).includes("bogus_key"), false);
  const viaGet = await (await GET(getRequest())).json();
  assert.deepEqual(viaGet.settings, body.settings);
});

test("PUT accepts a wrapped { settings } body", async () => {
  const response = await PUT(putRequest({
    settings: {
      enabled: false,
      synonym_enabled: true,
      synonym_pairs: [{ from: "攻击", to: "测试" }],
      structured_suffix: "",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.enabled, false);
  assert.equal(body.settings.synonym_enabled, true);
  assert.deepEqual(body.settings.synonym_pairs, [{ from: "攻击", to: "测试" }]);
  assert.equal(body.settings.structured_suffix, "");
  // Untouched fields keep their defaults, not the previous request's values.
  assert.deepEqual(body.settings.rewrite_rules, defaultPurgeSettings().rewrite_rules);
});

test("PUT rejects a non-JSON content type with 415", async () => {
  const response = await PUT(putRequest({ enabled: true }, { contentType: "text/plain" }));
  assert.equal(response.status, 415);
});

test("PUT rejects invalid JSON and a non-object body with 400", async () => {
  const bad = await PUT(putRequest("{ not json"));
  assert.equal(bad.status, 400);

  const scalar = await PUT(putRequest(JSON.stringify("nope")));
  assert.equal(scalar.status, 400);
  const scalarBody = await scalar.json();
  assert.equal(typeof scalarBody.error, "string");

  const arrayBody = await PUT(putRequest([1, 2, 3]));
  assert.equal(arrayBody.status, 400);

  const badWrapper = await PUT(putRequest({ settings: "nope" }));
  assert.equal(badWrapper.status, 400);
});

test("PUT refuses a cross-site origin with 403", async () => {
  const response = await PUT(putRequest(
    { enabled: true },
    { origin: "http://evil.example.com" },
  ));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "Untrusted API request");
});

test("GET refuses a cross-site origin with 403", async () => {
  // 读设置也要过同一道门：改写词表与技能目录不该因为端口可达就能被别的源读走。
  const response = await GET(getRequest({ origin: "http://evil.example.com" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Untrusted API request");
});
