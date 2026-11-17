import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * goal 的三个 Alma 式机制：完成条件裁判、按计划重复、创建参数解析。
 *
 * 全部注入假实现（假 store / 假裁判 / 假时钟 / 假 pi），不碰 SDK、不碰磁盘、不发网络请求。
 */

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  createGoalExtension,
  parseGoalCreateArgs,
  collectJudgeConversation,
  buildGoalSection,
} = await jiti.import("./goal-extension.ts");
const interval = await jiti.import("./goal-interval.ts");
const judgeMod = await jiti.import("./goal-judge.ts");
const types = await jiti.import("./goal-types.ts");

const NOW = 1_000_000;

// ───────────────────────── 间隔解析 ─────────────────────────

test("parseGoalRepeat：5m / 2h / 1d / 1.5h 都能解析，剩余文本进 note", () => {
  assert.deepEqual(interval.parseGoalRepeat("5m"), { intervalMs: 300_000, note: "", invalid: false });
  assert.deepEqual(interval.parseGoalRepeat("2h 不停迭代该项目"), { intervalMs: 7_200_000, note: "不停迭代该项目", invalid: false });
  assert.deepEqual(interval.parseGoalRepeat("1d"), { intervalMs: 86_400_000, note: "", invalid: false });
  assert.equal(interval.parseGoalRepeat("1.5h").intervalMs, 5_400_000);
  assert.equal(interval.parseGoalRepeat("2 H").intervalMs, 7_200_000, "数字与单位之间允许空格、单位大小写不敏感");
});

test("parseGoalRepeat：没有间隔前缀 = 连续续跑（intervalMs 0），不许把正文当间隔", () => {
  for (const text of ["不停迭代该项目", "", "5min", "迭代 3 天后停下"]) {
    const parsed = interval.parseGoalRepeat(text);
    assert.equal(parsed.intervalMs, 0, text);
    assert.equal(parsed.invalid, false, text);
  }
});

test("parseGoalRepeat：越界（<30s / >7d）标 invalid 且不改写原数字", () => {
  const tooFast = interval.parseGoalRepeat("5s");
  assert.equal(tooFast.invalid, true);
  assert.equal(tooFast.intervalMs, 0);
  assert.equal(tooFast.note, "5s");
  const tooSlow = interval.parseGoalRepeat("8d");
  assert.equal(tooSlow.invalid, true);
  assert.equal(interval.parseGoalRepeat("7d").intervalMs, 7 * 24 * 60 * 60 * 1000, "7d 本身合法");
});

test("formatGoalInterval：整单位输出 d/h/m，否则退化到秒", () => {
  assert.equal(interval.formatGoalInterval(86_400_000), "1d");
  assert.equal(interval.formatGoalInterval(7_200_000), "2h");
  assert.equal(interval.formatGoalInterval(300_000), "5m");
  assert.equal(interval.formatGoalInterval(45_000), "45s");
  assert.equal(interval.formatGoalInterval(0), "");
});

test("goalRepeatDue / remaining / exhausted：未到点不续、到点续、7 天窗用尽", () => {
  const state = { intervalMs: 60_000, nextRunAt: NOW + 60_000, startedAt: NOW };
  assert.equal(interval.goalRepeatDue(state, NOW), false);
  assert.equal(interval.goalRepeatRemainingMs(state, NOW), 60_000);
  assert.equal(interval.goalRepeatDue(state, NOW + 60_000), true);
  assert.equal(interval.goalRepeatDue({ intervalMs: 0 }, NOW), true, "无间隔恒可续");
  assert.equal(interval.goalRepeatDue({}, NOW), true, "旧数据无字段恒可续");

  const old = { intervalMs: 86_400_000, startedAt: NOW - 7 * 24 * 60 * 60 * 1000 };
  assert.equal(interval.goalRepeatExhausted(old, NOW), true);
  assert.equal(interval.goalRepeatExhausted({ intervalMs: 0, startedAt: 0 }, NOW), false, "连续续跑不适用 7 天窗");
});

// ───────────────────────── 状态机 ─────────────────────────

test("创建时带 intervalMs 不排 nextRunAt：用户刚点 Start，第一轮应当立即开跑", async () => {
  const s = setup();
  await s.command("做事 --every 2h");
  const state = s.store.read("s-1");
  assert.equal(state.intervalMs, 7_200_000);
  assert.equal(state.nextRunAt, undefined, "新建不等待；间隔只管后续轮次");
});

test("goalLimitsFor：定时目标的时间闸放宽到 7 天（否则 1d 间隔第一轮就触顶）", () => {
  const base = { maxContinuations: 20, maxElapsedMs: 600_000 };
  assert.deepEqual(types.goalLimitsFor({}, base), base);
  assert.equal(types.goalLimitsFor({ intervalMs: 1000 }, base).maxElapsedMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(types.goalLimitsFor({ intervalMs: 1000 }, base).maxContinuations, 20, "轮数上限不随间隔变");
});

// ───────────────────────── 裁判 ─────────────────────────

test("parseJudgeVerdict：取第一个平衡大括号块，容忍 ```json 围栏与前后解释", () => {
  const verdict = judgeMod.parseJudgeVerdict(
    "Here you go:\n```json\n{\"satisfied\": true, \"reason\": \"tests pass\", \"evidence\": [\"PASS 12\"]}\n```",
    NOW,
  );
  assert.equal(verdict.satisfied, true);
  assert.equal(verdict.reason, "tests pass");
  assert.deepEqual(verdict.evidence, ["PASS 12"]);
  assert.equal(verdict.at, NOW);
});

test("parseJudgeVerdict：非法输出一律 null（调用方按 unjudged 处理，绝不当成完成）", () => {
  for (const text of ["", "no json here", "{not json}", '{"satisfied":"yes"}', "[1,2,3]"]) {
    assert.equal(judgeMod.parseJudgeVerdict(text, NOW), null, text);
  }
});

test("parseJudgeVerdict：evidence 非数组/混入非字符串时只保留字符串，并封顶 8 条", () => {
  const many = Array.from({ length: 12 }, (_, i) => `e${i}`);
  const verdict = judgeMod.parseJudgeVerdict(
    JSON.stringify({ satisfied: false, reason: "r", evidence: [...many, 42, null] }),
    NOW,
  );
  assert.equal(verdict.evidence.length, 8);
  assert.ok(verdict.evidence.every((item) => typeof item === "string"));
});

test("buildJudgePrompt：含条件与对话尾部，超长按尾部截断（证据在最近几轮）", () => {
  const prompt = judgeMod.buildJudgePrompt({
    condition: "npm test exits 0",
    objective: "make the suite green",
    conversation: "x".repeat(judgeMod.GOAL_JUDGE_CONTEXT_CHARS + 500) + "TAIL",
  });
  assert.match(prompt, /npm test exits 0/);
  assert.match(prompt, /make the suite green/);
  assert.ok(prompt.endsWith("TAIL\n---"), "对话截断取尾部，TAIL 仍在");
  assert.ok(prompt.length < judgeMod.GOAL_JUDGE_CONTEXT_CHARS + 1000, "超长对话被截断");
});

test("judgeGoalCompletion：没有条件时不调模型，直接 unjudged", async () => {
  const verdict = await judgeMod.judgeGoalCompletion({ condition: "  ", objective: "x", conversation: "", now: () => NOW });
  assert.equal(verdict.unjudged, true);
  assert.equal(verdict.satisfied, false);
  assert.equal(verdict.at, NOW);
});

// ───────────────────────── 扩展接线 ─────────────────────────

function memStore() {
  const map = new Map();
  return { map, read: (id) => map.get(id) ?? null, write: (state) => { map.set(state.sessionId, state); } };
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

function makeCtx({ sessionId = "s-1", pending = false, branch = [], cwd = "/proj" } = {}) {
  const notes = [];
  return {
    notes,
    cwd,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: { notify: (text, level) => notes.push({ text, level }) },
    hasPendingMessages: () => pending,
  };
}

function setup({ ctx: ctxOpts, ...deps } = {}) {
  const pi = makePi();
  const store = memStore();
  const ctx = makeCtx(ctxOpts);
  createGoalExtension({ now: () => NOW, store, ...deps })(pi);
  return {
    pi, store, ctx,
    command: (args) => pi.commands.get("goal").handler(args, ctx),
    settle: (payload = { type: "agent_settled", aborted: false }) => pi.handlers.get("agent_settled")(payload, ctx),
  };
}

test("/goal 把测试跑绿 --every 2h --until <条件>：三个字段都落库，cwd 一起存", async () => {
  const s = setup();
  await s.command("把测试跑绿 --every 2h --until npm test exits 0 and lint is clean");
  const state = s.store.read("s-1");
  assert.equal(state.objective, "把测试跑绿");
  assert.equal(state.intervalMs, 7_200_000);
  assert.equal(state.condition, "npm test exits 0 and lint is clean", "--until 吃掉整段剩余（条件带空格）");
  assert.equal(state.cwd, "/proj", "cwd 落库，供调度器复活会话");
});

test("/goal 允许只有条件没有正文（弹窗「持续工作直到满足条件」那一栏）", async () => {
  const s = setup();
  await s.command("--until npm test exits 0");
  const state = s.store.read("s-1");
  assert.equal(state.objective, "npm test exits 0", "只有条件时，条件即目标正文");
  assert.equal(state.condition, "npm test exits 0");
  assert.match(s.ctx.notes.at(-1).text, /Goal set/, "空正文仍建目标（条件即目标）");
});

test("/goal 没有 --until 时条件为空（走旧的 model-self-complete 口径）", async () => {
  const s = setup();
  await s.command("ship it");
  const state = s.store.read("s-1");
  assert.equal(state.condition, undefined);
  assert.equal(state.intervalMs, undefined);
});

test("/goal 非法间隔：明确警告且不建目标", async () => {
  const s = setup();
  await s.command("做事 --every 5s");
  assert.equal(s.store.read("s-1"), null, "非法间隔不落库");
  assert.equal(s.ctx.notes.at(-1).level, "warning");
  assert.match(s.ctx.notes.at(-1).text, /5s/);
});

test("parseGoalCreateArgs：正文在前、flag 在后；flag 顺序可交换；乱写当正文保留", () => {
  assert.deepEqual(parseGoalCreateArgs("fix the flaky test --every 30m"), {
    objective: "fix the flaky test", intervalMs: 1_800_000,
  });
  assert.deepEqual(parseGoalCreateArgs("run the suite --until all tests pass"), {
    objective: "run the suite", condition: "all tests pass",
  });
  assert.deepEqual(parseGoalCreateArgs("run --every 1h --until green"), {
    objective: "run", intervalMs: 3_600_000, condition: "green",
  });
  assert.deepEqual(parseGoalCreateArgs("plain objective"), { objective: "plain objective" });
  assert.equal(parseGoalCreateArgs("x --every 5s").invalidRepeat, "5s");
  assert.deepEqual(parseGoalCreateArgs("x --typo-stuff y"), { objective: "x --typo-stuff y" }, "不认识的 flag 当正文，不静默丢");
});

test("带条件时：裁判说满足 ⇒ 目标转 completed、不续跑", async () => {
  const verdicts = [];
  const s = setup({
    judge: async (input) => {
      verdicts.push(input);
      return { satisfied: true, reason: "tests pass", evidence: ["PASS 12/12"], at: NOW };
    },
  });
  await s.command("把测试跑绿 --until npm test exits 0");
  await s.settle();
  const state = s.store.read("s-1");
  assert.equal(verdicts.length, 1, "跑了一次裁判");
  assert.equal(verdicts[0].condition, "npm test exits 0");
  assert.equal(state.status, "completed");
  assert.equal(state.judge?.satisfied, true);
  assert.equal(s.pi.sent.length, 0, "满足后不再续跑");
  assert.match(s.ctx.notes.at(-1).text, /verifier/);
});

test("带条件时：裁判说未满足 ⇒ 结论落库、照常续跑", async () => {
  const s = setup({
    judge: async () => ({ satisfied: false, reason: "no test output yet", evidence: [], unjudged: false, at: NOW }),
  });
  await s.command("跑绿 --until npm test exits 0");
  await s.settle();
  const state = s.store.read("s-1");
  assert.equal(state.status, "active");
  assert.equal(state.judge?.satisfied, false);
  assert.equal(s.pi.sent.length, 1, "未满足继续续跑");
  assert.equal(state.continuations, 1);
});

test("裁判抛异常 ⇒ 这一轮 unjudged、绝不结束目标、照常续跑", async () => {
  const s = setup({ judge: async () => { throw new Error("judge exploded"); } });
  await s.command("做事 --until condition");
  await s.settle();
  const state = s.store.read("s-1");
  assert.equal(state.status, "active", "裁判失败不能当成完成");
  assert.equal(state.judge?.unjudged, true);
  assert.match(state.judge.reason, /judge exploded/);
  assert.equal(s.pi.sent.length, 1);
});

test("有 pending 用户消息 ⇒ 不跑裁判（用户自己写了下一句，结论会过期）", async () => {
  let called = 0;
  const s = setup({ judge: async () => { called += 1; return { satisfied: false, reason: "", evidence: [], at: NOW }; } });
  await s.command("做事 --until c");
  const ctxPending = makeCtx({ pending: true });
  createGoalExtension({ now: () => NOW, store: s.store, judge: async () => { called += 1; return { satisfied: false, reason: "", evidence: [], at: NOW }; } })(s.pi);
  await s.pi.handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, ctxPending);
  assert.equal(called, 0, "pending 时不花裁判钱");
  assert.equal(s.pi.sent.length, 0, "也不续跑");
});

test("定时目标未到点 ⇒ 不续跑、不跑裁判（等调度器到点）", async () => {
  let judged = 0;
  const s = setup({ judge: async () => { judged += 1; return { satisfied: false, reason: "", evidence: [], at: NOW }; } });
  await s.command("做事 --every 2h --until c");
  s.store.write({ ...s.store.read("s-1"), nextRunAt: NOW + 3_600_000 });
  await s.pi.handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, s.ctx);
  assert.equal(judged, 0, "未到点不花裁判钱");
  assert.equal(s.pi.sent.length, 0, "未到点不续跑");
});

test("定时目标已到点 ⇒ 续跑一次并把 nextRunAt 推到下一档", async () => {
  const s = setup();
  await s.command("做事 --every 2h");
  s.store.write({ ...s.store.read("s-1"), intervalMs: 7_200_000, nextRunAt: NOW - 1 });
  await s.pi.handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, s.ctx);
  const state = s.store.read("s-1");
  assert.equal(s.pi.sent.length, 1);
  assert.equal(state.nextRunAt, NOW + 7_200_000, "下一档 = 现在 + 间隔");
});

test("定时目标的 7 天窗用尽 ⇒ 续跑后不排下一档（下一次触顶转 paused）", async () => {
  const s = setup();
  await s.command("做事 --every 1d");
  s.store.write({
    ...s.store.read("s-1"),
    intervalMs: 86_400_000,
    startedAt: NOW - 7 * 24 * 60 * 60 * 1000 + 1000,
    nextRunAt: NOW - 1,
  });
  await s.pi.handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, s.ctx);
  assert.equal(s.store.read("s-1").nextRunAt, undefined, "越过 7 天窗就不再排下一轮");
});

test("collectJudgeConversation：只取 user/assistant 文本，丢掉工具块", () => {
  const ctx = makeCtx({
    branch: [
      { type: "message", message: { role: "user", content: "do X" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ran it" }, { type: "toolCall", id: "t1" }] } },
      { type: "message", message: { role: "toolResult", content: "huge output" } },
    ],
  });
  const text = collectJudgeConversation(ctx, 10_000);
  assert.match(text, /USER: do X/);
  assert.match(text, /AGENT: ran it/);
  assert.doesNotMatch(text, /huge output/, "工具结果不进裁判输入");
});

test("collectJudgeConversation：读不到 branch 时返回空串，不抛", () => {
  const broken = { sessionManager: { getSessionId: () => "s", getBranch: () => { throw new Error("boom"); } } };
  assert.equal(collectJudgeConversation(broken, 1000), "");
});

test("buildGoalSection：有条件时写明由独立模型核对、模型不得自称完成", () => {
  const state = { sessionId: "s", objective: "跑绿", status: "active", continuations: 0, maxContinuations: 20, startedAt: NOW, elapsedMs: 0, updatedAt: NOW, condition: "npm test exits 0" };
  const section = buildGoalSection(state);
  assert.match(section, /separate model/);
  assert.match(section, /npm test exits 0/);
  assert.match(section, /Do not claim completion yourself/);
  assert.doesNotMatch(section, /call the `goal_complete` tool/, "有条件时不再引导模型自己调 goal_complete");
});

test("buildGoalSection：定时目标写明间隔，且说明空档期不追问用户", () => {
  const state = { sessionId: "s", objective: "跑绿", status: "active", continuations: 0, maxContinuations: 20, startedAt: NOW, elapsedMs: 0, updatedAt: NOW, intervalMs: 7_200_000 };
  const section = buildGoalSection(state);
  assert.match(section, /waits about 2h/);
});