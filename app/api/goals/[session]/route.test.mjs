import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

/**
 * `/api/goals/[session]` 的暂停 / 恢复。
 *
 * 需求：界面要能一键暂停/恢复目标（原来只能去聊天框敲 `/goal pause`）。
 *
 * 边界（这三条决定它能不能安全地按）：
 * 1. 只能切 `active` ↔ `paused`；`completed` / `cleared` 不能被这个端点复活——否则
 *    误点一下，一个已完成的目标重新开始烧钱。
 * 2. 暂停**不重置**轮数与计时：`paused → active` 之后双闸仍按原始 `startedAt` /
 *    `continuations` 算，暂停不能变成免费重置预算。
 * 3. 写盘即生效：`shouldContinueGoal` 的第一条判据就是 `status !== "active" → false`，
 *    所以不需要扩展配合（这条用一个纯函数对照钉住）。
 */
const home = mkdtempSync(join(tmpdir(), "pi-goals-api-"));
// `userHome()` reads PI_AGENT_HOME first (lib/user-home.ts); HOME/USERPROFILE are not
// consulted, so setting them here would leave the test writing the real ~/.pi/agent.
const previousAgentHome = process.env.PI_AGENT_HOME;
process.env.PI_AGENT_HOME = home;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const route = await jiti.import("../../../../app/api/goals/[session]/route.ts");
const store = await jiti.import("../../../../lib/goal/goal-store.ts");

after(() => {
  if (previousAgentHome === undefined) delete process.env.PI_AGENT_HOME;
  else process.env.PI_AGENT_HOME = previousAgentHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

let counter = 0;
function seed(status = "active", overrides = {}) {
  const sessionId = `goal-api-${++counter}`;
  const state = {
    sessionId,
    objective: "ship the thing",
    status,
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    continuations: 3,
    // `isGoalState` requires this one too; without it the file reads back as "no goal".
    maxContinuations: 20,
    elapsedMs: 60_000,
    ...overrides,
  };
  store.writeGoalState(state);
  return state;
}

const headers = { Host: "localhost", "Content-Type": "application/json" };
const patch = (sessionId, body) => route.PATCH(
  new NextRequest(`http://localhost/api/goals/${sessionId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ session: sessionId }) },
);
const get = (sessionId) => route.GET(
  new NextRequest(`http://localhost/api/goals/${sessionId}`, { headers: { Host: "localhost" } }),
  { params: Promise.resolve({ session: sessionId }) },
);

test("GET returns the goal, and null when there is none", async () => {
  const state = seed();
  const response = await get(state.sessionId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).goal.objective, "ship the thing");
  const none = await get("no-such-goal");
  assert.equal((await none.json()).goal, null);
});

test("pause then resume flips the status it writes to disk", async () => {
  const state = seed("active");
  const paused = await patch(state.sessionId, { status: "paused" });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).goal.status, "paused");
  assert.equal(store.readGoalState(state.sessionId)?.status, "paused");

  const resumed = await patch(state.sessionId, { status: "active" });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).goal.status, "active");
});

test("pausing keeps the budget: continuations and startedAt are untouched", async () => {
  const state = seed("active", { continuations: 7 });
  await patch(state.sessionId, { status: "paused" });
  const afterPause = store.readGoalState(state.sessionId);
  assert.equal(afterPause?.continuations, 7, "pausing must not refund continuations");
  assert.equal(afterPause?.startedAt, state.startedAt, "nor restart the clock");
  await patch(state.sessionId, { status: "active" });
  const afterResume = store.readGoalState(state.sessionId);
  assert.equal(afterResume?.continuations, 7, "resuming must not refund either");
  assert.equal(afterResume?.startedAt, state.startedAt);
});

test("a paused goal really stops being continued (the write is the switch)", async () => {
  const state = seed("active");
  assert.equal(store.shouldContinueGoal(store.readGoalState(state.sessionId), Date.now(), false), true);
  await patch(state.sessionId, { status: "paused" });
  assert.equal(
    store.shouldContinueGoal(store.readGoalState(state.sessionId), Date.now(), false),
    false,
    "shouldContinueGoal keys off status, so the disk write is the whole switch",
  );
});

test("terminal goals cannot be resurrected by this endpoint", async () => {
  for (const terminal of ["completed", "cleared"]) {
    const state = seed(terminal);
    const response = await patch(state.sessionId, { status: "active" });
    assert.equal(response.status, 409, terminal);
    assert.equal(store.readGoalState(state.sessionId)?.status, terminal, "left untouched");
  }
});

test("an unknown session is 404 and a bad status is 400", async () => {
  assert.equal((await patch("no-such-goal", { status: "paused" })).status, 404);
  const state = seed();
  assert.equal((await patch(state.sessionId, { status: "running" })).status, 400);
  assert.equal((await patch(state.sessionId, {})).status, 400);
});

test("the write gates hold: wrong content type is 415, cross-origin is 403", async () => {
  const state = seed();
  const wrongType = await route.PATCH(
    new NextRequest(`http://localhost/api/goals/${state.sessionId}`, {
      method: "PATCH",
      headers: { Host: "localhost", "Content-Type": "text/plain" },
      body: "{}",
    }),
    { params: Promise.resolve({ session: state.sessionId }) },
  );
  assert.equal(wrongType.status, 415);

  const crossOrigin = await route.PATCH(
    new NextRequest(`http://localhost/api/goals/${state.sessionId}`, {
      method: "PATCH",
      headers: { ...headers, Origin: "https://evil.example.com" },
      body: JSON.stringify({ status: "paused" }),
    }),
    { params: Promise.resolve({ session: state.sessionId }) },
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(store.readGoalState(state.sessionId)?.status, "active", "nothing was written");
});
