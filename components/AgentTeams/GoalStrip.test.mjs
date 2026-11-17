import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { GoalStrip, formatElapsed } = await jiti.import("./GoalStrip.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

/** 固定采样目标（active + 预算/续跑/时长齐全）。 */
const base = {
  sessionId: "s1",
  objective: "把 README 重写一遍",
  status: "active",
  budget: 20,
  continuations: 2,
  maxContinuations: 20,
  startedAt: 1000,
  elapsedMs: 125000,
  updatedAt: 2000,
};

const render = (goal, props = {}) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(GoalStrip, { goal, ...props })),
);
const text = (html) => html.replace(/<[^>]*>/g, "");

test("无目标 / completed / cleared / 空目标 → 返回空，不占位", () => {
  assert.equal(render(null), "");
  assert.equal(render({ ...base, status: "completed" }), "");
  assert.equal(render({ ...base, status: "cleared" }), "");
  assert.equal(render({ ...base, objective: "   " }), "");
});

test("active 态：标题 + 目标文本（截断带 title）+ 元信息，且不渲染 i18n 键原文", () => {
  const html = render(base);
  assert.ok(html.includes('data-testid="active-goal-strip"'), "strip root");
  assert.ok(text(html).includes("Active goal"), "title");
  assert.ok(text(html).includes("Active"), "active status word");
  assert.ok(text(html).includes(base.objective), "objective rendered");
  assert.ok(html.includes(`title="${base.objective}"`), "objective carries title for truncation hover");
  // 元信息（非 compact）：Budget / Continuations / Elapsed。
  assert.ok(text(html).includes("Budget 20"), "budget meta");
  assert.ok(text(html).includes("Continuations 2"), "continuations meta");
  assert.ok(text(html).includes("2m 05s"), "elapsed meta");
  // 反向断言：绝不把 i18n 键名渲染到界面。
  assert.ok(!html.includes("chat.activeGoal."), "no raw i18n key");
});

test("isRunning=true → Loop running（与 Active 区分）", () => {
  const html = text(render(base, { isRunning: true }));
  assert.ok(html.includes("Loop running"), "running word");
  assert.ok(!html.includes("Active goal") === false || html.includes("Active goal"), "title still shown");
});

test("paused → 状态词 Paused", () => {
  assert.ok(text(render({ ...base, status: "paused" })).includes("Paused"), "paused word");
});

test("compact=true → 隐藏元信息", () => {
  const t = text(render(base, { compact: true }));
  assert.ok(t.includes("Active goal"), "title still shown");
  assert.ok(!t.includes("Budget"), "budget hidden");
  assert.ok(!t.includes("2m 05s"), "elapsed hidden");
});

test("formatElapsed：秒 / 分", () => {
  assert.equal(formatElapsed(42000), "42s");
  assert.equal(formatElapsed(125000), "2m 05s");
  assert.equal(formatElapsed(0), "0s");
});

// ───────────────────────── 定时重复 + 裁判（Alma 形态） ─────────────────────────

test("定时目标：显示「每 2h」；等待空档里给出下次倒计时", () => {
  const now = Date.now();
  const html = text(render({
    ...base,
    status: "active",
    intervalMs: 7_200_000,
    nextRunAt: now + 90_000,
  }));
  assert.ok(html.includes("every 2h"), "间隔展示");
  assert.match(html, /Next \d+m? ?\d*s/, "空档里显示下次倒计时");
});

test("定时目标正在跑：不显示倒计时（没有空档）", () => {
  const now = Date.now();
  const html = text(render({
    ...base,
    status: "active",
    intervalMs: 7_200_000,
    nextRunAt: now + 90_000,
  }, { isRunning: true }));
  assert.ok(html.includes("every 2h"));
  assert.doesNotMatch(html, /Next \d/, "跑起来就不该再报倒计时");
});

test("带条件的目标：裁判结论三态（未判 / 未判定 / 已满足/尚未满足）", () => {
  const pending = text(render({ ...base, condition: "npm test exits 0" }));
  assert.ok(pending.includes("Verifier: checking"), "还没判过");

  const unjudged = text(render({
    ...base,
    condition: "npm test exits 0",
    judge: { satisfied: false, reason: "timeout", evidence: [], unjudged: true, at: 1 },
  }));
  assert.ok(unjudged.includes("not judged this turn"));

  const notYet = text(render({
    ...base,
    condition: "npm test exits 0",
    judge: { satisfied: false, reason: "no output", evidence: [], at: 1 },
  }));
  assert.ok(notYet.includes("not satisfied yet"));

  const satisfied = text(render({
    ...base,
    condition: "npm test exits 0",
    judge: { satisfied: true, reason: "PASS", evidence: ["PASS 12"], at: 1 },
  }));
  assert.ok(satisfied.includes("Verifier: satisfied"));
});

test("没有条件时不显示裁判行（旧口径的 goal 不该多出一行）", () => {
  const html = text(render(base));
  assert.doesNotMatch(html, /Verifier/);
});
