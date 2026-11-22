import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * The pinned-sessions and background-jobs write routes must run the same
 * origin/host guard as every other write route (`isApiRequestAllowed`), and the
 * JSON-body route must also reject a non-JSON Content-Type (415). Without the
 * guard they were reachable only through the proxy's Host matcher fallback.
 */

const agentDir = mkdtempSync(join(tmpdir(), "pi-write-guards-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });

const UNTRUSTED_HOST = { Host: "evil.example" };

test("PUT /api/pinned-sessions：不可信来源 → 403", async () => {
  const route = await jiti.import("./pinned-sessions/route.ts");
  const response = await route.PUT(new Request("http://evil.example/api/pinned-sessions", {
    method: "PUT",
    headers: { ...UNTRUSTED_HOST, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", role: "worker" }),
  }));
  assert.equal(response.status, 403);
});

test("DELETE /api/pinned-sessions：不可信来源 → 403", async () => {
  const route = await jiti.import("./pinned-sessions/route.ts");
  const response = await route.DELETE(new Request("http://evil.example/api/pinned-sessions?id=s1", {
    method: "DELETE",
    headers: UNTRUSTED_HOST,
  }));
  assert.equal(response.status, 403);
});

test("PUT /api/pinned-sessions：非 JSON Content-Type → 415", async () => {
  const route = await jiti.import("./pinned-sessions/route.ts");
  const response = await route.PUT(new Request("http://localhost/api/pinned-sessions", {
    method: "PUT",
    headers: { Host: "localhost", "Content-Type": "text/plain" },
    body: "x",
  }));
  assert.equal(response.status, 415);
});

test("POST /api/background-jobs：不可信来源 → 403", async () => {
  const route = await jiti.import("./background-jobs/route.ts");
  const response = await route.POST(new Request("http://evil.example/api/background-jobs?id=job-1", {
    method: "POST",
    headers: UNTRUSTED_HOST,
  }));
  assert.equal(response.status, 403);
});
