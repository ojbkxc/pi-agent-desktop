import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `/goal` 扩展的行为接线：命令 / 工具 / 注入 / 续跑与触顶暂停。
 *
 * 用假 `pi`（记录 registerCommand/registerTool/on/sendUserMessage/appendEntry）与假 ctx
 * 驱动扩展工厂，不碰 SDK、不碰磁盘。状态机本身已由 goal-store.test.mjs 锁死，这里只验接线。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  createGoalExtension,
  buildGoalSection,
  goalStatusLine,
  goalGateMessage,
  GOAL_CONTINUE_PROMPT,
  GOAL_ENTRY_TYPE,
  GOAL_SECTION,
} = await jiti.import("./goal-extension.ts");

const NOW = 1_000_000;

function memStore() {
  const map = new Map();
  return {
    map,
    read: (id) => map.get(id) ?? null,
    write: (state) => { map.set(state.sessionId, state); },
  };
}

function makePi() {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const sent = [];
  const entries = [];
  return {
    commands, tools, handlers, sent, entries,
    registerCommand: (name, options) => commands.set(name, options),
    registerTool: (def) => tools.set(def.name, def),
    on: (event, handler) => { handlers.set(event, handler); },
    sendUserMessage: (content, options) => sent.push({ content, options }),
    appendEntry: (type, data) => entries.push({ type, data }),
  };
}

function makeCtx({ sessionId = "s-1", pending = false } = {}) {
  const notes = [];
  return {
    notes,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (text, level) => notes.push({ text, level }) },
    hasPendingMessages: () => pending,
  };
}

/** 装好扩展，返回 pi / store / ctx 与一个便捷的 goal 句柄。 */
function setup({ ctx: ctxOpts, ...deps } = {}) {
  const pi = makePi();
  const store = memStore();
  const ctx = makeCtx(ctxOpts);
  createGoalExtension({ now: () => NOW, store, ...deps })(pi);
  return {
    pi, store, ctx,
    async command(args) { return pi.commands.get("goal").handler(args, ctx); },
    async tool(params) { return pi.tools.get("goal_complete").execute("call-1", params, undefined, undefined, ctx); },
    event(name, payload) { return pi.handlers.get(name)(payload, ctx); },
  };
}

// ───────────────────────── 命令 ─────────────────────────

test("/goal <objective> 建目标：状态 active 并落条目", async () => {
  const s = setup();
  await s.command("ship the feature");
  const state = s.store.read("s-1");
  assert.equal(state.status, "active");
  assert.equal(state.objective, "ship the feature");
  assert.equal(s.pi.entries.at(-1).type, GOAL_ENTRY_TYPE, "appendEntry 落自定义条目");
  assert.match(s.ctx.notes.at(-1).text, /Goal set/);
});

test("/goal 再给一个目标 = replaced（计数归零）", async () => {
  const s = setup();
  await s.command("first");
  s.store.write({ ...s.store.read("s-1"), continuations: 5 });
  await s.command("second");
  const state = s.store.read("s-1");
  assert.equal(state.objective, "second");
  assert.equal(state.continuations, 0);
});

test("/goal pause|resume|clear 迁移状态并回执", async () => {
  const s = setup();
  await s.command("x");
  await s.command("pause");
  assert.equal(s.store.read("s-1").status, "paused");
  await s.command("resume");
  assert.equal(s.store.read("s-1").status, "active");
  await s.command("clear");
  assert.equal(s.store.read("s-1").status, "cleared");
  assert.equal(s.ctx.notes.at(-1).text, "Goal cleared.");
});

test("/goal status 回执含目标与进度；无目标时给引导", async () => {
  const s = setup();
  await s.command("");           // 无参数 = status
  assert.match(s.ctx.notes.at(-1).text, /No goal set/);
  await s.command("do the thing");
  await s.command("status");
  assert.match(s.ctx.notes.at(-1).text, /do the thing/);
  assert.match(s.ctx.notes.at(-1).text, /0\/20/);
});

test("/goal pause 在无目标时只警告、不崩", async () => {
  const s = setup();
  await s.command("pause");
  assert.equal(s.ctx.notes.at(-1).level, "warning");
  assert.match(s.ctx.notes.at(-1).text, /No goal to pause/);
});

// ───────────────────────── goal_complete 工具 ─────────────────────────

test("goal_complete：active 目标 → completed，并落条目", async () => {
  const s = setup();
  await s.command("x");
  const result = await s.tool({ summary: "shipped it" });
  assert.equal(s.store.read("s-1").status, "completed");
  assert.match(result.content[0].text, /completed/);
  assert.match(result.content[0].text, /shipped it/);
});

test("goal_complete：无 active 目标 → 提示、不改状态", async () => {
  const s = setup();
  const result = await s.tool({ summary: "nope" });
  assert.match(result.content[0].text, /No active goal/);
  assert.equal(s.store.read("s-1"), null);
});

// ───────────────────────── before_agent_start 注入 ─────────────────────────

test("before_agent_start：active 目标注入 goal 段；无目标不注入", async () => {
  const s = setup();
  const ev1 = { systemPromptOptions: { sections: {} } };
  s.event("before_agent_start", ev1);
  assert.equal(ev1.systemPromptOptions.sections[GOAL_SECTION], undefined, "无目标不注入");

  await s.command("x");
  const ev2 = { systemPromptOptions: { sections: {} } };
  s.event("before_agent_start", ev2);
  assert.equal(ev2.systemPromptOptions.sections[GOAL_SECTION], buildGoalSection(s.store.read("s-1")));
});

// ───────────────────────── agent_settled 续跑 / 触顶 ─────────────────────────

test("agent_settled：active + 无 pending + 未触顶 → 自动续跑一轮", async () => {
  const s = setup();
  await s.command("x");
  s.event("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(s.pi.sent.length, 1, "投递了一次续跑");
  assert.equal(s.pi.sent[0].content, GOAL_CONTINUE_PROMPT);
  assert.equal(s.pi.sent[0].options.deliverAs, "followUp");
  assert.equal(s.store.read("s-1").continuations, 1, "轮数 +1");
});

test("agent_settled：有 pending 用户消息 → 不续、也不暂停", async () => {
  const s = setup({ ctx: { pending: true } });
  await s.command("x");
  s.event("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(s.pi.sent.length, 0);
  assert.equal(s.store.read("s-1").status, "active");
});

test("agent_settled：aborted（用户 Esc）→ 什么都不做", async () => {
  const s = setup();
  await s.command("x");
  s.event("agent_settled", { type: "agent_settled", aborted: true });
  assert.equal(s.pi.sent.length, 0);
  assert.equal(s.store.read("s-1").status, "active");
});

test("agent_settled：轮数触顶 → 不续、转 paused、notify 警告（绝不静默续跑）", async () => {
  const s = setup();
  await s.command("x");
  s.store.write({ ...s.store.read("s-1"), continuations: 20 });
  s.event("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(s.pi.sent.length, 0, "触顶不再投递");
  assert.equal(s.store.read("s-1").status, "paused");
  assert.equal(s.ctx.notes.at(-1).level, "warning");
  assert.match(s.ctx.notes.at(-1).text, /paused/);
});

test("agent_settled：时间触顶 → 不续、转 paused、notify", async () => {
  const s = setup();
  await s.command("x");
  s.store.write({ ...s.store.read("s-1"), startedAt: NOW - 600_000 });
  s.event("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(s.pi.sent.length, 0);
  assert.equal(s.store.read("s-1").status, "paused");
  assert.match(s.ctx.notes.at(-1).text, /minutes/);
});

test("已 completed / cleared 的目标不再续跑", async () => {
  for (const status of ["completed", "cleared"]) {
    const s = setup();
    await s.command("x");
    s.store.write({ ...s.store.read("s-1"), status });
    s.event("agent_settled", { type: "agent_settled", aborted: false });
    assert.equal(s.pi.sent.length, 0, status);
  }
});

// ───────────────────────── 纯文案 ─────────────────────────

test("文案构造：状态行 / 触顶行可读", () => {
  assert.match(goalStatusLine(null), /No goal set/);
  assert.match(goalGateMessage("maxContinuations"), /20-continuation/);
  assert.match(goalGateMessage("maxElapsedMs"), /minutes/);
});
