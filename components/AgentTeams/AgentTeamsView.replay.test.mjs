import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * T7 回放控制条 + 时钟下沉。
 *
 * - useTeamTimeline 的 replayStepMs 是纯函数：倍速 → 帧间隔（非法值退回 1×）；
 * - AgentTeamsReplayBar 用 react-dom/server 真渲染：四档倍速按钮、滑轨、
 *   帧位置与 aria-label 必须是真实文案（不是 i18n 键原文）；
 * - AgentTeamsView 只负责把 timeline 的 speed/seek/step 接上去。
 */

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  interopDefault: true,
});

const { REPLAY_STEP_MS, REPLAY_SPEEDS, replayStepMs, clampReplaySpeed } = await jiti.import(
  "../../hooks/useTeamTimeline.ts",
);
const { AgentTeamsReplayBar } = await jiti.import("./AgentTeamsReplayBar.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const read = async (file) => (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function renderBar(overrides = {}) {
  const props = {
    selectedIndex: 2,
    latestIndex: 9,
    frameAt: "2026-01-01T00:01:05.000Z",
    speed: 1,
    onSpeedChange: () => {},
    onSeek: () => {},
    onStep: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(
    React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(AgentTeamsReplayBar, props)),
  );
}

// ── replayStepMs 纯函数 ────────────────────────────────────────────────────

test("replayStepMs：四档倍速按比例缩放基准帧间隔", () => {
  assert.equal(REPLAY_STEP_MS, 1200, "基准 1× 帧间隔保持 1200ms");
  assert.deepEqual([...REPLAY_SPEEDS], [0.5, 1, 2, 4]);
  assert.equal(replayStepMs(0.5), 2400);
  assert.equal(replayStepMs(1), 1200);
  assert.equal(replayStepMs(2), 600);
  assert.equal(replayStepMs(4), 300);
});

test("replayStepMs：0 / 负数 / NaN / Infinity 退回 1×，绝不产生 0 或无限间隔", () => {
  for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity]) {
    assert.equal(replayStepMs(bad), REPLAY_STEP_MS, `倍速 ${String(bad)} 应退回 1×`);
  }
});

test("clampReplaySpeed：精确命中档位保留，其余按 >1 归 4×、否则 1×", () => {
  assert.equal(clampReplaySpeed(0.5), 0.5);
  assert.equal(clampReplaySpeed(2), 2);
  assert.equal(clampReplaySpeed(3), 4);
  assert.equal(clampReplaySpeed(0.25), 1);
  assert.equal(clampReplaySpeed(NaN), 1);
});

// ── 渲染断言 ──────────────────────────────────────────────────────────────

test("回放控制条：四档倍速按钮 + 当前档 aria-pressed", () => {
  const html = renderBar({ speed: 2 });
  for (const speed of REPLAY_SPEEDS) {
    assert.match(html, new RegExp(`data-speed="${speed}"`), `缺少 ${speed}× 按钮`);
    assert.match(html, new RegExp(`>${speed}×<`), `按钮文案必须是 ${speed}×`);
  }
  // 只有当前档是 pressed。
  assert.match(html, /data-speed="2" aria-pressed="true"/);
  assert.match(html, /data-speed="1" aria-pressed="false"/);
  assert.match(html, /data-speed="0.5" aria-pressed="false"/);
  assert.match(html, /data-speed="4" aria-pressed="false"/);
});

test("回放控制条：滑轨 input[type=range] 带边界、当前值与真实 aria-label", () => {
  const html = renderBar({ selectedIndex: 4, latestIndex: 9 });
  assert.match(html, /<input[^>]*type="range"/);
  assert.match(html, /data-testid="agent-teams-replay-range"/);
  assert.match(html, /min="0"/);
  assert.match(html, /max="9"/);
  assert.match(html, /value="4"/);
  // 真渲染走 en 语言包：必须是可读文案，不是 teams.replay.* 键原文。
  assert.match(html, /aria-label="Seek timeline"/);
  assert.doesNotMatch(html, /teams\.replay\./);
});

test("回放控制条：分组 aria-label 用真实文案，位置显示「当前帧 / 总帧」与帧时间", () => {
  const html = renderBar({ selectedIndex: 2, latestIndex: 9 });
  assert.match(html, /role="group" aria-label="Timeline"/);
  assert.match(html, /aria-label="Speed"/);
  assert.match(html, /Frame 3 of 10/, "位置文案 = selectedIndex+1 / latestIndex+1");
  const time = new Date(Date.parse("2026-01-01T00:01:05.000Z")).toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  assert.ok(html.includes(time), `帧时间应显示 ${time}`);
});

test("回放控制条：只有一格历史时滑轨与倍速禁用", () => {
  const html = renderBar({ selectedIndex: 0, latestIndex: 0 });
  assert.match(html, /data-testid="agent-teams-replay-range"[^>]*disabled/);
  assert.match(html, /data-speed="1" aria-pressed="true" disabled/);
});

// ── 视图接线 ──────────────────────────────────────────────────────────────

test("AgentTeamsView 挂上回放控制条，并把 timeline 的倍速/seek/step 接线", async () => {
  const view = await read("./AgentTeamsView.tsx");
  assert.match(view, /import \{ AgentTeamsReplayBar \}/);
  assert.match(view, /<AgentTeamsReplayBar\b/);
  assert.match(view, /speed=\{timeline\.speed\}/);
  assert.match(view, /onSpeedChange=\{timeline\.setSpeed\}/);
  assert.match(view, /onSeek=\{timeline\.seek\}/);
  assert.match(view, /onStep=\{\(delta\) => \(delta < 0 \? timeline\.stepBack\(\) : timeline\.stepForward\(\)\)\}/);
  // 回放条只在有历史帧时出现（实时一帧时不该是一条死控件）。
  assert.match(view, /\{snapshot && timeline\.latestIndex > 0 && \(/);
});

test("AgentTeamsView 挂上叶子时钟，根组件不再持有每秒 now", async () => {
  const view = await read("./AgentTeamsView.tsx");
  assert.match(view, /import \{ AgentTeamsLiveClock \}/);
  assert.match(view, /\{timeline\.isLive && \(\s*<AgentTeamsLiveClock\b/);
  assert.match(view, /teamStatus=\{snapshot\.team\.status\}/);
  assert.match(view, /workingCount=\{workingCount\}/);
  assert.doesNotMatch(view, /setNow\(Date\.now\(\)\)/, "根视图不得再驱动秒针");
});
