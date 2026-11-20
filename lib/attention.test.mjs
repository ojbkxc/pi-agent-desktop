import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ATTENTION_AUTOFIX_LIMIT,
  ATTENTION_COMPLETED_LIMIT,
  ATTENTION_PREVIEW_MAX,
  ATTENTION_TITLE_MAX,
  attentionItemsForAutofix,
  attentionProjectName,
  attentionTitle,
  buildAttentionSnapshot,
} = await jiti.import("./attention.ts");

const NOW = Date.parse("2026-11-16T12:00:00Z");

const session = (id, modified, extra = {}) => ({
  id,
  path: `/sessions/${id}.jsonl`,
  cwd: "/code/app",
  projectRoot: "/code/app",
  created: modified,
  modified,
  messageCount: 2,
  firstMessage: `prompt ${id}`,
  workspaceKind: "project",
  ...extra,
});

const snapshot = (sessionId, extra = {}) => ({
  sessionId,
  running: true,
  runStartedAt: null,
  activity: null,
  waiting: [],
  lastRun: null,
  ...extra,
});

const ids = (items) => items.map((item) => item.sessionId);

test("awaiting beats completed, longest wait first, and completed is newest-first", () => {
  const sessions = [
    session("old", "2026-10-01T00:00:00Z"),
    session("new", "2026-11-15T00:00:00Z"),
    session("waited-long", "2026-11-01T00:00:00Z"),
    session("waited-short", "2026-11-10T00:00:00Z"),
  ];
  const result = buildAttentionSnapshot({
    sessions,
    awaitingSessionIds: ["waited-short", "waited-long"],
    taskSnapshots: [
      snapshot("waited-long", { runStartedAt: NOW - 60 * 60 * 1000 }),
      snapshot("waited-short", { runStartedAt: NOW - 60 * 1000 }),
    ],
    now: NOW,
  });

  assert.deepEqual(ids(result.awaiting), ["waited-long", "waited-short"], "earliest run start is the longest wait");
  assert.deepEqual(ids(result.completed), ["new", "old"], "awaiting rows never repeat under completed");
  assert.equal(result.generatedAt, NOW);
  for (const item of result.awaiting) assert.equal(item.kind, "awaiting-input");
  for (const item of result.completed) assert.equal(item.kind, "completed");
});

test("subagent, scheduled and transient sessions stay out of the inbox", () => {
  const result = buildAttentionSnapshot({
    sessions: [
      session("main", "2026-11-15T00:00:00Z"),
      session("child", "2026-11-15T00:00:00Z", {
        relation: { kind: "subagent", parentSessionId: "main", profile: "explore", description: "", status: "running" },
      }),
      session("sched", "2026-11-15T00:00:00Z", { relation: { kind: "scheduled", taskId: "t", runId: "r" } }),
      session("draft", "2026-11-15T00:00:00Z", { transient: true }),
    ],
    awaitingSessionIds: ["child", "draft"],
    now: NOW,
  });

  assert.deepEqual(ids(result.completed), ["main"]);
  // An awaiting id that only resolves to an excluded row is not resurrected as a bare row.
  assert.deepEqual(ids(result.awaiting), [], "ineligible rows never enter awaiting");
});

test("an awaiting runtime session with no catalogue row still appears, by id", () => {
  const result = buildAttentionSnapshot({
    sessions: [],
    awaitingSessionIds: ["9f1c2b3d-0000-4000-8000-abcdefabcdef"],
    taskSnapshots: [snapshot("9f1c2b3d-0000-4000-8000-abcdefabcdef", {
      runStartedAt: NOW - 5_000,
      waiting: [{ method: "confirm", prompt: "Delete the folder?" }],
    })],
    now: NOW,
  });

  assert.equal(result.awaiting.length, 1);
  const [item] = result.awaiting;
  assert.equal(item.sessionId, "9f1c2b3d-0000-4000-8000-abcdefabcdef");
  assert.equal(item.workspaceKind, "project");
  assert.equal(item.awaitingSince, NOW - 5_000);
  assert.equal(item.lastMessagePreview, "Delete the folder?");
});

test("awaiting preview is the dialog prompt, whitespace-collapsed and bounded", () => {
  const longPrompt = `Answer   this\n${"x".repeat(500)}`;
  const result = buildAttentionSnapshot({
    sessions: [session("ask", "2026-11-15T00:00:00Z")],
    awaitingSessionIds: ["ask"],
    taskSnapshots: [snapshot("ask", { waiting: [{ method: "select", prompt: longPrompt }] })],
    now: NOW,
  });
  const [item] = result.awaiting;
  assert.ok(item.lastMessagePreview.length <= ATTENTION_PREVIEW_MAX);
  assert.ok(!/\s{2,}|\n/.test(item.lastMessagePreview), "collapsed to a single line");
  assert.ok(item.lastMessagePreview.startsWith("Answer this "));
});

test("an awaiting row without a snapshot has no preview and sorts by activity", () => {
  const result = buildAttentionSnapshot({
    sessions: [session("ask", "2026-11-15T00:00:00Z")],
    awaitingSessionIds: ["ask"],
    now: NOW,
  });
  const [item] = result.awaiting;
  assert.equal(item.lastMessagePreview, undefined);
  assert.equal(item.awaitingSince, undefined);
  assert.equal(item.updatedAt, Date.parse("2026-11-15T00:00:00Z"));
});

test("chats carry no projectName; projects carry the folder name", () => {
  const result = buildAttentionSnapshot({
    sessions: [
      session("chat", "2026-11-15T00:00:00Z", { cwd: "/home/u/.pi/chats/20260101-000000-abcd", projectRoot: undefined, workspaceKind: "chat" }),
      session("proj", "2026-11-14T00:00:00Z", { projectRoot: "/code/pi-agent-desktop/" }),
    ],
    awaitingSessionIds: [],
    now: NOW,
  });
  const byId = new Map(result.completed.map((item) => [item.sessionId, item]));
  assert.equal(byId.get("chat").workspaceKind, "chat");
  assert.equal(byId.get("chat").projectName, undefined);
  assert.equal(byId.get("proj").workspaceKind, "project");
  assert.equal(byId.get("proj").projectName, "pi-agent-desktop");
});

test("completed is capped at the recent limit while awaiting is not", () => {
  const sessions = Array.from({ length: 30 }, (_, index) => (
    session(`s${index}`, new Date(NOW - index * 60_000).toISOString())
  ));
  const result = buildAttentionSnapshot({
    sessions,
    awaitingSessionIds: ["s29"],
    now: NOW,
  });
  assert.equal(result.completed.length, ATTENTION_COMPLETED_LIMIT);
  assert.deepEqual(ids(result.completed).slice(0, 2), ["s0", "s1"], "newest first");
  assert.ok(!ids(result.completed).includes("s29"), "the awaiting row is not duplicated");
  assert.deepEqual(ids(result.awaiting), ["s29"]);
});

test("empty state is an empty inbox, not a missing field", () => {
  const result = buildAttentionSnapshot({ sessions: [], awaitingSessionIds: [], now: NOW });
  assert.deepEqual(result.awaiting, []);
  assert.deepEqual(result.completed, []);
  assert.equal(result.generatedAt, NOW);
  assert.deepEqual(Object.keys(result).sort(), ["awaiting", "completed", "generatedAt"], "wire shape");
});

test("an unparseable modified still yields a positive updatedAt (the phone drops 0)", () => {
  const result = buildAttentionSnapshot({
    sessions: [
      session("broken", "not-a-date"),
      session("broken-await", "not-a-date"),
    ],
    awaitingSessionIds: ["broken-await"],
    now: NOW,
  });
  assert.ok(result.completed[0].updatedAt > 0);
  assert.ok(result.awaiting[0].updatedAt > 0);
  assert.equal(result.completed[0].updatedAt, NOW);
  assert.equal(result.awaiting[0].updatedAt, NOW);
});

test("contract shape: every item has the pinned keys and kinds", () => {
  const result = buildAttentionSnapshot({
    sessions: [session("a", "2026-11-15T00:00:00Z"), session("b", "2026-11-14T00:00:00Z")],
    awaitingSessionIds: ["a"],
    taskSnapshots: [snapshot("a", { waiting: [{ method: "input", prompt: "Name it" }] })],
    now: NOW,
  });
  for (const item of [...result.awaiting, ...result.completed]) {
    assert.deepEqual(
      Object.keys(item).filter((key) => item[key] !== undefined).sort(),
      Object.keys(item).sort(),
      "no undefined-valued keys leak onto the wire",
    );
    assert.equal(typeof item.sessionId, "string");
    assert.equal(typeof item.title, "string");
    assert.ok(item.workspaceKind === "chat" || item.workspaceKind === "project");
    assert.ok(item.kind === "awaiting-input" || item.kind === "completed");
    assert.equal(typeof item.updatedAt, "number");
  }
});

test("titles collapse whitespace, restore skill commands and never split a surrogate pair", () => {
  assert.equal(
    attentionTitle(session("x", "2026-11-15T00:00:00Z", { name: "  My   session \n name " })),
    "My session name",
  );
  assert.equal(
    attentionTitle(session("x", "2026-11-15T00:00:00Z", { firstMessage: "<skill name=\"pdf\" location=\"/s/pdf/SKILL.md\">\nReferences are relative to /s/pdf/SKILL.md.\n\nDo the thing\n</skill>" })),
    "/skill:pdf",
  );
  const emoji = "😀".repeat(ATTENTION_TITLE_MAX);
  const truncated = attentionTitle(session("x", "2026-11-15T00:00:00Z", { firstMessage: emoji }));
  assert.ok(truncated.length <= ATTENTION_TITLE_MAX);
  assert.ok(!/[\uD800-\uDBFF]$/.test(truncated), "no dangling high surrogate");
  // Nothing at all still yields a stable label rather than an empty row.
  assert.equal(attentionTitle({ ...session("abcdef1234567890", "2026-11-15T00:00:00Z"), name: undefined, firstMessage: "" }), "abcdef123456");
});

test("attentionProjectName falls back to cwd and tolerates a bare root", () => {
  assert.equal(attentionProjectName(session("x", "2026-11-15T00:00:00Z", { projectRoot: undefined, cwd: "D:\\GitHub\\pi-agent-desktop" })), "pi-agent-desktop");
  assert.equal(attentionProjectName(session("x", "2026-11-15T00:00:00Z", { projectRoot: "/" })), "/");
});

const autofixTask = (id, sessionId, extra = {}) => ({
  id,
  task: `fix ${id}`,
  cwd: "/code/pi-agent-desktop",
  status: "failed",
  sessionId,
  updatedAt: NOW - 60_000,
  finishedAt: NOW - 60_000,
  ...extra,
});

test("terminal autofix outcomes lead the inbox, active and succeeded tasks stay out", () => {
  const items = attentionItemsForAutofix([
    autofixTask("a", "session-a", { status: "failed", finishedAt: NOW - 120_000, updatedAt: NOW - 120_000 }),
    autofixTask("b", "session-b", { status: "exhausted" }),
    autofixTask("c", "session-c", { status: "stopped" }),
    autofixTask("d", "session-d", { status: "succeeded" }),
    autofixTask("e", "session-e", { status: "running" }),
  ], NOW);

  assert.deepEqual(items.map((item) => item.sessionId), ["session-b", "session-c", "session-a"], "newest first");
  for (const item of items) {
    assert.equal(item.kind, "completed");
    assert.equal(item.workspaceKind, "project");
    assert.equal(item.projectName, "pi-agent-desktop");
  }
  assert.deepEqual(items.map((item) => item.title), ["fix b", "fix c", "fix a"]);
});

test("a task that never started a session is skipped; a reused session keeps the newest outcome", () => {
  const items = attentionItemsForAutofix([
    autofixTask("never", null),
    autofixTask("older", "shared", { finishedAt: NOW - 300_000, updatedAt: NOW - 300_000 }),
    autofixTask("newer", "shared", { finishedAt: NOW - 10_000, updatedAt: NOW - 10_000 }),
  ], NOW);
  assert.deepEqual(items.map((item) => item.sessionId), ["shared"]);
  assert.equal(items[0].title, "fix newer");
  assert.equal(items[0].updatedAt, NOW - 10_000);
});

test("autofix rows lead completed and replace the session's own row", () => {
  const tasks = Array.from({ length: ATTENTION_AUTOFIX_LIMIT }, (_, index) => (
    autofixTask(`t${index}`, `fix-session-${index}`, {
      finishedAt: NOW - index * 1_000,
      updatedAt: NOW - index * 1_000,
    })
  ));
  const result = buildAttentionSnapshot({
    sessions: [
      session("fix-session-0", "2026-11-15T00:00:00Z", { firstMessage: "generic title" }),
      session("main", "2026-11-14T00:00:00Z"),
    ],
    awaitingSessionIds: [],
    autofixTasks: tasks,
    now: NOW,
  });

  assert.equal(result.completed.filter((item) => item.sessionId === "fix-session-0").length, 1, "no duplicate row");
  const first = result.completed.find((item) => item.sessionId === "fix-session-0");
  assert.equal(first.title, "fix t0", "the task statement wins over the session title");
  assert.deepEqual(
    result.completed.slice(0, ATTENTION_AUTOFIX_LIMIT).map((item) => item.sessionId),
    Array.from({ length: ATTENTION_AUTOFIX_LIMIT }, (_, index) => `fix-session-${index}`),
  );
  assert.equal(result.completed[result.completed.length - 1].sessionId, "main", "ordinary sessions follow the autofix rows");
});

test("autofix rows and ordinary sessions share the one completed cap", () => {
  const tasks = Array.from({ length: ATTENTION_AUTOFIX_LIMIT }, (_, index) => (
    autofixTask(`t${index}`, `fix-${index}`, { finishedAt: NOW - index, updatedAt: NOW - index })
  ));
  const sessions = Array.from({ length: 30 }, (_, index) => (
    session(`s${index}`, new Date(NOW - 60_000 - index * 60_000).toISOString())
  ));
  const result = buildAttentionSnapshot({ sessions, awaitingSessionIds: [], autofixTasks: tasks, now: NOW });

  assert.equal(result.completed.length, ATTENTION_COMPLETED_LIMIT);
  assert.equal(result.completed.filter((item) => item.sessionId.startsWith("fix-")).length, ATTENTION_AUTOFIX_LIMIT);
  assert.equal(result.completed[ATTENTION_AUTOFIX_LIMIT].sessionId, "s0", "the newest ordinary session fills the rest");
});

test("an autofix session parked on a dialog stays in awaiting only", () => {
  const result = buildAttentionSnapshot({
    sessions: [],
    awaitingSessionIds: ["fix-session-0"],
    autofixTasks: [autofixTask("t0", "fix-session-0", { status: "stopped" })],
    now: NOW,
  });
  assert.deepEqual(ids(result.awaiting), ["fix-session-0"]);
  assert.deepEqual(ids(result.completed), []);
});

