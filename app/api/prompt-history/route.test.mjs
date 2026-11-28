import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

// getAgentDir() reads PI_CODING_AGENT_DIR; point it at a temp dir so the
// prompt-history.jsonl never touches the real ~/.pi/agent.
const original = process.env.PI_CODING_AGENT_DIR;
const agent = await mkdtemp(join(tmpdir(), "pi-prompt-history-"));
process.env.PI_CODING_AGENT_DIR = agent;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, POST } = await jiti.import("./route.ts");
const { appendPromptHistory, listPromptHistory } = await jiti.import("../../../../lib/prompt-history.ts");
after(async () => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
  await rm(agent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const request = (url, method, body, headers = {}) => new Request(url, {
  method,
  headers: { Host: "localhost", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
  ...(body !== undefined ? { body } : {}),
});

test("POST appends and GET lists entries, newest-first", async () => {
  assert.equal((await POST(request("http://localhost/api/prompt-history", "POST", JSON.stringify({ display: "first", project: agent })))).status, 200);
  assert.equal((await POST(request("http://localhost/api/prompt-history", "POST", JSON.stringify({ display: "second", project: agent })))).status, 200);
  const { entries } = await (await GET(request(`http://localhost/api/prompt-history?project=${encodeURIComponent(agent)}`, "GET"))).json();
  assert.deepEqual(entries.map((e) => e.display), ["second", "first"]);
  assert.ok(typeof entries[0].timestamp === "number");
});

test("GET scopes by project: only matching-project entries return", async () => {
  const otherProject = join(agent, "other-project");
  appendPromptHistory({ display: "other-project prompt", project: otherProject });
  const { entries } = await (await GET(request(`http://localhost/api/prompt-history?project=${encodeURIComponent(agent)}`, "GET"))).json();
  assert.ok(entries.every((e) => e.display !== "other-project prompt"), "other project excluded");
  assert.ok(entries.some((e) => e.display === "first"), "current project kept");
});

test("GET orders current session first, then same-project other sessions", async () => {
  // Two sessions in the same project.
  appendPromptHistory({ display: "session-A older", project: agent, sessionId: "A" });
  appendPromptHistory({ display: "session-B prompt", project: agent, sessionId: "B" });
  appendPromptHistory({ display: "session-A newer", project: agent, sessionId: "A" });
  const { entries } = await (await GET(request(`http://localhost/api/prompt-history?project=${encodeURIComponent(agent)}&sessionId=A&limit=100`, "GET"))).json();
  // Current session (A) entries come first, newest-first; then other sessions.
  const displays = entries.map((e) => e.display);
  const aIdx = displays.indexOf("session-A newer");
  const bIdx = displays.indexOf("session-B prompt");
  assert.ok(aIdx !== -1 && bIdx !== -1);
  assert.ok(aIdx < bIdx, "current session entries precede other-session entries");
  assert.ok(displays.indexOf("session-A older") > aIdx, "current session newest-first");
});

test("GET with sessionOnly returns only the current session", async () => {
  const { entries } = await (await GET(request(`http://localhost/api/prompt-history?project=${encodeURIComponent(agent)}&sessionId=A&sessionOnly=1`, "GET"))).json();
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.sessionId === "A"), "only session A");
});

test("GET with no project and no session fails closed to an empty list", async () => {
  const { entries } = await (await GET(request("http://localhost/api/prompt-history", "GET"))).json();
  assert.deepEqual(entries, []);
});

test("GET with sessionOnly but no sessionId returns an empty list", async () => {
  const { entries } = await (await GET(request("http://localhost/api/prompt-history?sessionOnly=1", "GET"))).json();
  assert.deepEqual(entries, []);
});

test("GET bounds the result by limit", async () => {
  const { entries } = await (await GET(request(`http://localhost/api/prompt-history?project=${encodeURIComponent(agent)}&limit=2`, "GET"))).json();
  assert.equal(entries.length, 2);
});

test("GET rejects an invalid limit", async () => {
  assert.equal((await GET(request("http://localhost/api/prompt-history?limit=abc", "GET"))).status, 400);
});

test("POST rejects empty display, wrong content-type and untrusted origin", async () => {
  assert.equal((await POST(request("http://localhost/api/prompt-history", "POST", JSON.stringify({ display: "   " })))).status, 400);
  assert.equal((await POST(request("http://localhost/api/prompt-history", "POST", JSON.stringify({ display: "x" }), { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(request("http://localhost/api/prompt-history", "POST", JSON.stringify({ display: "x" }), { Origin: "https://untrusted.example" }))).status, 403);
  assert.equal((await POST(request("http://localhost/api/prompt-history", "POST", JSON.stringify({ display: 42 })))).status, 400);
});

test("GET rejects an untrusted origin", async () => {
  assert.equal((await GET(request("http://localhost/api/prompt-history", "GET", undefined, { Origin: "https://untrusted.example", "sec-fetch-site": "cross-site" }))).status, 403);
});

test("partial last line from a crash mid-append is skipped, not fatal", async () => {
  // Simulate a truncated final line (crash mid-append).
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(agent, "prompt-history.jsonl"), '{"display":"cut', "utf8");
  const { entries } = await (await GET(request(`http://localhost/api/prompt-history?project=${encodeURIComponent(agent)}&limit=200`, "GET"))).json();
  assert.ok(entries.every((e) => e.display.length > 0), "no empty/partial entries");
  assert.ok(entries.some((e) => e.display === "second"), "prior entries survive");
});

test("listPromptHistory returns [] when the file does not exist", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "pi-prompt-history-empty-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fresh;
  try {
    assert.deepEqual(listPromptHistory({ project: fresh }), []);
  } finally {
    process.env.PI_CODING_AGENT_DIR = saved;
    await rm(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
