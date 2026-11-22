import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * POST /api/models-config/discover must not turn a saved provider's stored
 * credential into an attacker-chosen Base URL (SSRF + key exfiltration). These
 * cases use a temp agent dir so models.json / auth.json are the only sources.
 */
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-models-config-discover-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function modelList() {
  return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function discover(body) {
  return POST(new Request("http://localhost/api/models-config/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  }));
}

async function seedSavedProvider() {
  await writeFile(join(testAgentDir, "models.json"), JSON.stringify({
    providers: {
      "saved-provider": { baseUrl: "https://saved.test/v1", api: "openai-completions" },
    },
  }, null, 2), "utf8");
  await writeFile(join(testAgentDir, "auth.json"), JSON.stringify({
    "saved-provider": { type: "api_key", key: "sk_auth_secret" },
  }, null, 2), { mode: 0o600 });
}

test("the saved Base URL uses the stored auth.json credential", async (t) => {
  await seedSavedProvider();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return modelList();
  });

  const response = await discover({
    providerName: "saved-provider",
    provider: { baseUrl: "https://saved.test/v1", api: "openai-completions" },
  });

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.models.length, 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://saved.test/v1/models");
  assert.equal(requests[0].headers.get("authorization"), "Bearer sk_auth_secret");
});

test("a different Base URL never spends the stored auth.json credential", async (t) => {
  // Regression: discovery used to authenticate with the stored key and send it
  // to whatever Base URL the request supplied.
  await seedSavedProvider();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return modelList();
  });

  const response = await discover({
    providerName: "saved-provider",
    provider: { baseUrl: "https://evil.test/v1", api: "openai-completions" },
  });

  assert.equal(response.status, 200, "an unauthenticated endpoint still discovers");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://evil.test/v1/models");
  assert.equal(requests[0].headers.get("authorization"), null, "no bearer token");
  assert.equal(requests[0].headers.get("x-api-key"), null, "no anthropic key");
});

test("an unsaved endpoint still sends a key the request typed itself", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return modelList();
  });

  const response = await discover({
    providerName: "brand-new-provider",
    provider: { baseUrl: "https://new.test/v1", api: "openai-completions", apiKey: "sk_typed_literal" },
  });

  assert.equal(response.status, 200);
  assert.equal(requests[0].headers.get("authorization"), "Bearer sk_typed_literal");
});

test("rejects a loopback / private Base URL (SSRF guard)", async () => {
  const response = await discover({
    providerName: "saved-provider",
    provider: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" },
  });
  assert.equal(response.status, 400);
  assert.match(String((await response.json()).error), /local or private/i);
});

test("rejects a non-http(s) Base URL", async () => {
  const response = await discover({
    providerName: "saved-provider",
    provider: { baseUrl: "file:///etc/passwd", api: "openai-completions" },
  });
  assert.equal(response.status, 400);
  assert.match(String((await response.json()).error), /http and https/i);
});

test("a saved loopback provider is allowed (the user's own local endpoint)", async (t) => {
  await writeFile(join(testAgentDir, "models.json"), JSON.stringify({
    providers: { "local-ollama": { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" } },
  }, null, 2), "utf8");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return modelList();
  });

  const response = await discover({
    providerName: "local-ollama",
    provider: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" },
  });

  assert.equal(response.status, 200, "saved local provider is not blocked");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/models");
});

test("an unsaved loopback Base URL is still rejected", async () => {
  const response = await discover({
    providerName: "brand-new-local",
    provider: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" },
  });
  assert.equal(response.status, 400);
  assert.match(String((await response.json()).error), /local or private/i);
});

test("IPv6 / IPv4-mapped 私网：未保存的新 baseUrl 一律 400", async () => {
  for (const baseUrl of [
    "http://[::ffff:127.0.0.1]:11434/v1", // URL normalizes the host to [::ffff:7f00:1]
    "http://[::1]:11434/v1",
    "http://[fe80::1]/v1",
    "http://[fd00::1]/v1",
  ]) {
    const response = await discover({
      providerName: "brand-new-v6",
      provider: { baseUrl, api: "openai-completions" },
    });
    assert.equal(response.status, 400, baseUrl);
    assert.match(String((await response.json()).error), /local or private/i, baseUrl);
  }
});

test("IPv6-mapped 回环：已保存等价 endpoint 时放行", async (t) => {
  const baseUrl = "http://[::ffff:127.0.0.1]:11434/v1";
  await writeFile(join(testAgentDir, "models.json"), JSON.stringify({
    providers: { "local-v6": { baseUrl, api: "openai-completions" } },
  }, null, 2), "utf8");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return modelList();
  });

  const response = await discover({
    providerName: "local-v6",
    provider: { baseUrl, api: "openai-completions" },
  });

  assert.equal(response.status, 200, "saved mapped-loopback endpoint is not blocked");
  assert.equal(requests.length, 1);
});
