import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { fixtureDir } from "../../../scripts/test-platform.mjs";

/**
 * POST/GET /api/autofix + /api/autofix/[id]。
 *
 * 每个用例跑在临时 PI_CODING_AGENT_DIR 上，绝不碰真实 ~/.pi/agent；驱动由
 * PI_WEB_DISABLE_AUTOFIX_DRIVER=1 关掉，避免单测真去建会话/跑 npm test。
 */

const root = await fixtureDir("pi-web-autofix-route-");
const agentDir = join(root, "agent");
const project = join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDriver = process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER = "1";
await mkdir(agentDir, { recursive: true });
await mkdir(project, { recursive: true });
await writeFile(join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousDriver === undefined) delete process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER;
  else process.env.PI_WEB_DISABLE_AUTOFIX_DRIVER = previousDriver;
  await rm(root, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const listRoute = await jiti.import("./route.ts");
const itemRoute = await jiti.import("./[id]/route.ts");
const store = await jiti.import("../../../lib/autofix/store.ts");

function request(path, init = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { host: "localhost", ...init.headers },
  });
}

function postJson(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await rm(join(agentDir, "autofix"), { recursive: true, force: true });
});

test("POST creates a queued task and detects the verify command", async () => {
  const response = await listRoute.POST(postJson("/api/autofix", {
    task: "这个 bug 不修好，CI 过不去",
    cwd: project,
  }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.task.status, "queued");
  assert.equal(body.task.verifyCommand, "npm test");
  assert.equal(body.task.cwd, project);

  const onDisk = JSON.parse(await readFile(join(agentDir, "autofix", "tasks", `${body.task.id}.json`), "utf8"));
  assert.equal(onDisk.task, "这个 bug 不修好，CI 过不去");
});

test("POST accepts an explicit verify command and a round cap", async () => {
  const response = await listRoute.POST(postJson("/api/autofix", {
    task: "fix it",
    cwd: project,
    verifyCommand: "npm run lint",
    maxRounds: "3",
  }));
  const body = await response.json();
  assert.equal(body.task.verifyCommand, "npm run lint");
  assert.equal(body.task.maxRounds, 3);
});

test("POST rejects bad input with an i18n key", async () => {
  const cases = [
    [{ task: "", cwd: project, verifyCommand: "npm test" }, "autofix.error.taskRequired"],
    [{ task: "fix it", cwd: join(root, "missing"), verifyCommand: "npm test" }, "autofix.error.cwdMissing"],
    [{ task: "fix it", cwd: "", verifyCommand: "npm test" }, "autofix.error.cwdRequired"],
    // No explicit command and no package.json script in agentDir -> detection fails.
    [{ task: "fix it", cwd: agentDir }, "autofix.error.verifyRequired"],
    [{ task: "fix it", cwd: project, verifyCommand: "npm test", maxRounds: 99 }, "autofix.error.maxRoundsRange"],
  ];
  for (const [input, key] of cases) {
    const response = await listRoute.POST(postJson("/api/autofix", input));
    assert.equal(response.status, 400, JSON.stringify(input));
    const body = await response.json();
    assert.equal(body.code, "validation");
    assert.equal(body.key, key, JSON.stringify(input));
  }
});

test("POST rejects non-JSON content types", async () => {
  const response = await listRoute.POST(request("/api/autofix", { method: "POST", body: "task=x" }));
  assert.equal(response.status, 415);
});

test("GET lists tasks newest first with a summary", async () => {
  const first = (await (await listRoute.POST(postJson("/api/autofix", { task: "one", cwd: project }))).json()).task;
  const second = (await (await listRoute.POST(postJson("/api/autofix", { task: "two", cwd: project }))).json()).task;
  // Ensure distinct createdAt so the ordering is deterministic.
  store.updateAutofixTask(first.id, (task) => ({ ...task, createdAt: task.createdAt - 10 }), agentDir);

  const body = await (await listRoute.GET()).json();
  assert.deepEqual(body.tasks.map((task) => task.id), [second.id, first.id]);
  assert.equal(body.summary.total, 2);
  assert.equal(body.summary.active, 2);
});

test("[id] GET 404s for unknown ids and invalid ids", async () => {
  const unknown = await itemRoute.GET(request("/api/autofix/x"), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) });
  assert.equal(unknown.status, 404);
  const invalid = await itemRoute.GET(request("/api/autofix/x"), { params: Promise.resolve({ id: "../escape" }) });
  assert.equal(invalid.status, 404);
});

test("[id] stop/resume transitions and delete removes the record", async () => {
  const created = (await (await listRoute.POST(postJson("/api/autofix", { task: "cycle me", cwd: project }))).json()).task;
  const params = { params: Promise.resolve({ id: created.id }) };

  const stopped = await (await itemRoute.POST(postJson(`/api/autofix/${created.id}`, { action: "stop" }), params)).json();
  assert.equal(stopped.task.status, "stopped");
  assert.equal(stopped.task.pid, null);

  const resumed = await (await itemRoute.POST(postJson(`/api/autofix/${created.id}`, { action: "resume" }), params)).json();
  assert.equal(resumed.task.status, "queued");
  assert.equal(resumed.task.round, 0);

  // Stop of a succeeded task is refused.
  store.updateAutofixTask(created.id, (task) => ({ ...task, status: "succeeded" }), agentDir);
  const refused = await itemRoute.POST(postJson(`/api/autofix/${created.id}`, { action: "stop" }), params);
  assert.equal(refused.status, 409);

  const removed = await itemRoute.DELETE(request(`/api/autofix/${created.id}`, { method: "DELETE" }), params);
  assert.equal(removed.status, 200);
  assert.equal(store.getAutofixTask(created.id, agentDir), undefined);
});

test("[id] unknown action is rejected", async () => {
  const created = (await (await listRoute.POST(postJson("/api/autofix", { task: "x", cwd: project }))).json()).task;
  const response = await itemRoute.POST(
    postJson(`/api/autofix/${created.id}`, { action: "explode" }),
    { params: Promise.resolve({ id: created.id }) },
  );
  assert.equal(response.status, 400);
});