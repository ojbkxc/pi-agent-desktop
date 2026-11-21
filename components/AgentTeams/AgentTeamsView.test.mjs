import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * AgentTeamsView 是纯客户端组件（挂载时才 fetch /api/teams，SSR 渲染不出下拉），
 * 所以这里只对源码做接线断言：团队下拉的 value 必须是目录名（id，稳定、可查表），
 * label 必须用 displayName（config.name）——否则中文团队名会显示成一串短横线。
 */
test("团队下拉：value 用目录名，label 用 displayName", async () => {
  const source = await readFile(new URL("./AgentTeamsView.tsx", import.meta.url), "utf8");
  assert.match(source, /options=\{teams\.map\(\(team\) => \(\{ value: team\.name, label: team\.displayName \}\)\)\}/);
  assert.match(source, /displayName: string/, "TeamSummary 必须声明 displayName");
  assert.doesNotMatch(source, /label:\s*team\.name\b/, "label 不得再用目录名");
});

// ── interaction.md P2：整页根节点的 Esc 不能落到全局快捷键（会停掉后台 agent）──
test("根 main 挂载即聚焦，Esc 必须 preventDefault（同 ScheduledView / AutofixView）", async () => {
  const source = (await readFile(new URL("./AgentTeamsView.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  // 根节点确实会在挂载时抢焦点——所以它的按键会被 window 级 Esc 看到。
  assert.match(source, /rootRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  // main 开始标签里必须有 Escape preventDefault。开始标签以 `>` 收尾，而箭头函数里
  // 也有 `=>`——所以用「main 起点 → onKeyDown 之后的下一个换行缩进的 `>`」定界。
  const mainStart = source.indexOf("<main");
  assert.ok(mainStart > 0);
  const keyHandler = source.indexOf('if (event.key === "Escape") event.preventDefault();', mainStart);
  assert.ok(keyHandler > mainStart, "main 上必须有 Escape preventDefault");
  const tagEnd = source.indexOf("\n    >", keyHandler);
  assert.ok(tagEnd > keyHandler, "Escape 处理必须留在 main 的开始标签内");
  assert.ok(source.indexOf("agent-teams-workbench-row", mainStart) > tagEnd, "开始标签在第一个子节点之前闭合");
});

// 同型整页视图（TasksView）由本组一并修复（lead 指派，components/tasks/** 无其他 owner）。
test("TasksView 的 main 同样吞掉 Escape", async () => {
  const source = (await readFile(new URL("../tasks/TasksView.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(source, /if \(event\.key === "Escape"\) event\.preventDefault\(\);/);
});
// SSR 渲染 AgentTeamsView 时 snapshot 为 null（数据靠挂载后 fetch），live 条不会出现；
// 因此把「三态 hint / 已用时长 / 会话时钟」的派生抽成模块级纯函数 deriveLiveIndicator，
// 直接覆盖其边界，再用源码断言钉住 live 条本体的挂载点。

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { deriveLiveIndicator } = await jiti.import("./AgentTeamsView.tsx");

/** 假翻译：只认识三个 hint 键与 following，其余回退键名。 */
function t(key, params) {
  if (key === "teams.live.formingHint") return "FORMING";
  if (key === "teams.live.runningHint") return `RUNNING:${params?.count}`;
  if (key === "teams.live.waitingHint") return "WAITING";
  if (key === "teams.live.following") return "FOLLOWING";
  return key;
}

const clockOf = (ms) => new Date(ms).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

test("C9：live 三态 hint —— forming / running(带人数) / waiting", () => {
  const base = { isLive: true, createdAt: "2026-01-01T00:00:00.000Z", generatedAt: "2026-01-01T00:00:00.000Z", now: Date.parse("2026-01-01T00:00:00.000Z") };
  assert.equal(deriveLiveIndicator({ ...base, teamStatus: "forming", workingCount: 4 }, t, "en").hint, "FORMING");
  assert.equal(deriveLiveIndicator({ ...base, teamStatus: "running", workingCount: 3 }, t, "en").hint, "RUNNING:3");
  // running 但无人运行 → waiting。
  assert.equal(deriveLiveIndicator({ ...base, teamStatus: "running", workingCount: 0 }, t, "en").hint, "WAITING");
  // completed 也走 waiting（只有 forming 是特例）。
  assert.equal(deriveLiveIndicator({ ...base, teamStatus: "completed", workingCount: 0 }, t, "en").hint, "WAITING");
});

test("C9：已用时长随 now 变化（实时跟随）", () => {
  const common = { teamStatus: "running", workingCount: 1, isLive: true, createdAt: "2026-01-01T00:00:00.000Z", generatedAt: "2026-01-01T00:00:00.000Z" };
  const at65 = deriveLiveIndicator({ ...common, now: Date.parse("2026-01-01T00:01:05.000Z") }, t, "en");
  const at125 = deriveLiveIndicator({ ...common, now: Date.parse("2026-01-01T00:02:05.000Z") }, t, "en");
  assert.equal(at65.elapsed, "01:05");
  assert.equal(at125.elapsed, "02:05");
  assert.notEqual(at65.elapsed, at125.elapsed, "now 推进，已用时长必须跟着涨");
});

test("C9：回放时已用时长冻结到当前帧（不随 now 走）", () => {
  const common = { teamStatus: "running", workingCount: 1, isLive: false, createdAt: "2026-01-01T00:00:00.000Z", generatedAt: "2026-01-01T00:01:00.000Z" };
  const a = deriveLiveIndicator({ ...common, now: Date.parse("2026-01-01T09:00:00.000Z") }, t, "en");
  const b = deriveLiveIndicator({ ...common, now: Date.parse("2026-01-01T10:00:00.000Z") }, t, "en");
  assert.equal(a.elapsed, "01:00", "回放用帧时间：createdAt → generatedAt");
  assert.equal(a.elapsed, b.elapsed, "now 不影响回放的已用时长");
});

test("C9：会话时钟 —— 实时跟 now、回放跟帧时间", () => {
  const nowMs = Date.parse("2026-01-01T00:02:05.000Z");
  const common = { teamStatus: "running", workingCount: 1, createdAt: "2026-01-01T00:00:00.000Z", generatedAt: "2026-01-01T00:01:00.000Z", now: nowMs };
  const live = deriveLiveIndicator({ ...common, isLive: true }, t, "en");
  const replay = deriveLiveIndicator({ ...common, isLive: false }, t, "en");
  assert.equal(live.clock, clockOf(nowMs), "实时时钟必须显示当前时间");
  assert.equal(replay.clock, clockOf(Date.parse("2026-01-01T00:01:00.000Z")), "回放时钟必须显示帧时间");
  assert.notEqual(live.clock, replay.clock);
});

test("C9：createdAt 不可解析时退回帧时间，不产生 NaN", () => {
  const common = { teamStatus: "running", workingCount: 1, isLive: true, createdAt: "", generatedAt: "2026-01-01T00:01:00.000Z", now: Date.parse("2026-01-01T00:02:00.000Z") };
  const { elapsed } = deriveLiveIndicator(common, t, "en");
  assert.equal(elapsed, "01:00");
  assert.doesNotMatch(elapsed, /NaN/);
});

test("C9：live 条挂载在叶子时钟组件里，且用派生结果渲染 hint/时长/时钟", async () => {
  const view = await readFile(new URL("./AgentTeamsView.tsx", import.meta.url), "utf8");
  // T7 时钟下沉：视图只在实时跟随时挂载叶子组件，秒级 now 不再进根 state。
  assert.match(view, /\{timeline\.isLive && \(\s*<AgentTeamsLiveClock\b/);
  assert.doesNotMatch(view, /const \[now, setNow\]/, "每秒 now 不得留在视图根 state");
  assert.doesNotMatch(view, /setInterval\(\(\) => setNow/, "秒针定时器不得留在视图根");
  const clock = await readFile(new URL("./AgentTeamsLiveClock.tsx", import.meta.url), "utf8");
  assert.match(clock, /data-testid="agent-teams-live-controls"/, "live 条必须有稳定的 testid");
  assert.match(clock, /data-testid="agent-teams-live-controls"[\s\S]*?teams\.live\.following/, "following 徽标在条内");
  assert.match(clock, /liveIndicator\.hint/);
  assert.match(clock, /liveIndicator\.elapsed/);
  assert.match(clock, /liveIndicator\.clock/);
  // 只在实时跟随时出现：回放/非实时由上层不挂载该叶子。
  assert.match(clock, /agent-teams-live-hint/);
});
