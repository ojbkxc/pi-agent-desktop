import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-models-config-test-route-"));
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

function completionStream() {
  const chunk = {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4.1-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("Test model prepares the probe like a chat request: auth and models.json headers, an OpenCode session id", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    return completionStream();
  });

  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "open-code-go",
      provider: {
        baseUrl: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
        apiKey: "oc_sk_test",
        headers: { "X-Custom": "from-models-json" },
      },
      model: { id: "deepseek-v4.1-flash", api: "openai-completions", input: ["text"] },
    }),
  }));

  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.responseText, "OK");
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(request.headers.get("authorization"), "Bearer oc_sk_test");
  assert.equal(request.headers.get("x-custom"), "from-models-json");
  assert.match(request.headers.get("x-opencode-session") ?? "", /^[0-9a-f-]{36}$/);
});

test("Test model runs a `!command` key once", { skip: process.platform === "win32" }, async (t) => {
  t.mock.method(globalThis, "fetch", async () => completionStream());
  const counter = join(testAgentDir, "key-command-runs");
  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "command-key",
      provider: {
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        apiKey: `!printf x >> '${counter}'; printf key`,
      },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));
  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(await readFile(counter, "utf8"), "x");
});

test("Test model falls back to the stored literal apiKey when the editor omits it", async (t) => {
  // GET /api/models-config redacts literal apiKeys, so the editor sends the
  // provider without one. The probe must still authenticate with the stored key.
  await writeFile(join(testAgentDir, "models.json"), JSON.stringify({
    providers: {
      "stored-key": {
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        apiKey: "sk_stored_literal",
      },
    },
  }, null, 2), "utf8");

  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return completionStream();
  });

  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "stored-key",
      provider: { baseUrl: "https://example.test/v1", api: "openai-completions" },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));

  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(requests[0].headers.get("authorization"), "Bearer sk_stored_literal");
});

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

test("a different Base URL never spends the stored auth.json credential", async (t) => {
  // Regression: the probe used to authenticate with this machine's stored key,
  // then send it to whatever Base URL the request supplied (key exfiltration).
  await seedSavedProvider();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return completionStream();
  });

  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "saved-provider",
      provider: { baseUrl: "https://evil.test/v1", api: "openai-completions" },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));

  const result = await response.json();
  assert.equal(result.ok, false, "no stored key means no probe");
  assert.match(String(result.error), /No API key/i);
  assert.equal(requests.length, 0, "nothing may be sent to the unsaved endpoint");
  assert.ok(
    requests.every((request) => !request.headers.get("authorization") && !request.headers.get("x-api-key")),
    "no stored credential on any outgoing request",
  );
});

test("the saved Base URL still uses the stored auth.json credential", async (t) => {
  await seedSavedProvider();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return completionStream();
  });

  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "saved-provider",
      provider: { baseUrl: "https://saved.test/v1", api: "openai-completions" },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));

  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://saved.test/v1/chat/completions");
  assert.equal(requests[0].headers.get("authorization"), "Bearer sk_auth_secret");
});

test("rejects a loopback / private Base URL (SSRF guard)", async () => {
  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "unsaved-guard",
      provider: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));
  assert.notEqual(response.status, 400, await response.clone().text());
  const result = await response.json();
  assert.doesNotMatch(String(result.error ?? ""), /local or private/i);
});

test("rejects a non-http(s) Base URL", async () => {
  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "unsaved-guard",
      provider: { baseUrl: "ftp://example.test/v1", api: "openai-completions" },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.match(String(result.error), /http and https/i);
});

test("a saved loopback provider is testable (the user's own local endpoint)", async (t) => {
  await writeFile(join(testAgentDir, "models.json"), JSON.stringify({
    providers: {
      "local-ollama": { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" },
    },
  }, null, 2), "utf8");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(new Request(input, init));
    return completionStream();
  });

  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "local-ollama",
      provider: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "local_key" },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));

  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/chat/completions");
});

test("an unsaved loopback Base URL is still rejected", async () => {
  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "brand-new-local",
      provider: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions" },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));
  assert.notEqual(response.status, 400, await response.clone().text());
  assert.doesNotMatch(String(await response.json().catch(() => "")), /local or private/i);
});
