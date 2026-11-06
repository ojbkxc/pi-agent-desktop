import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET } = await jiti.import("./route.ts");

const VALID_CATALOG = {
  name: "pi-extensions",
  owner: { name: "ojbkxc" },
  metadata: { description: "cross-end extension catalog", version: "0.1.0" },
  plugins: [
    {
      name: "lsp-mcp",
      source: { source: "github", repo: "ojbkxc/lsp-mcp", ref: "main" },
      description: "LSP extension",
      version: "1.1.0",
      keywords: ["lsp"],
    },
  ],
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(response) {
  globalThis.fetch = async () => response;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

test("GET returns the marketplace header and entries", async () => {
  stubFetch(jsonResponse(VALID_CATALOG));

  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.marketplace, {
    name: "pi-extensions",
    owner: "ojbkxc",
    description: "cross-end extension catalog",
    version: "0.1.0",
  });
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].name, "lsp-mcp");
  assert.equal(body.entries[0].installSource, "git:https://github.com/ojbkxc/lsp-mcp@main");
});

test("GET maps an upstream non-2xx to 502 without echoing the upstream body", async () => {
  stubFetch(jsonResponse("SECRET-UPSTREAM-BODY", { ok: false, status: 500 }));

  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.match(body.error, /HTTP 500/);
  assert.ok(!JSON.stringify(body).includes("SECRET-UPSTREAM-BODY"), "upstream body is not echoed");
});

test("GET maps a timeout to 504", async () => {
  globalThis.fetch = async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  };

  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 504);
  assert.match(body.error, /timed out/i);
});

test("GET maps an invalid catalog to 500 with the reason", async () => {
  stubFetch(jsonResponse({ name: "cat", owner: {}, plugins: [] }));

  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /owner\.name/);
});

test("GET maps a non-JSON upstream body to 500", async () => {
  stubFetch(jsonResponse("<html>nope</html>"));

  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /not valid JSON/);
});
