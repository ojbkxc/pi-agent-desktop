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

// ── C9 Live 指示（对抗验证 M3：此前零断言）──────────────────────────────────
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

test("C9：live 条的挂载点存在，且用派生结果渲染 hint/时长/时钟", async () => {
  const source = await readFile(new URL("./AgentTeamsView.tsx", import.meta.url), "utf8");
  assert.match(source, /data-testid="agent-teams-live-controls"/, "live 条必须有稳定的 testid");
  assert.match(source, /data-testid="agent-teams-live-controls"[\s\S]*?teams\.live\.following/, "following 徽标在条内");
  assert.match(source, /liveIndicator\.hint/);
  assert.match(source, /liveIndicator\.elapsed/);
  assert.match(source, /liveIndicator\.clock/);
  // 只在实时跟随时显示（回放不显示）。
  assert.match(source, /\{timeline\.isLive && liveIndicator && \(/);
});
