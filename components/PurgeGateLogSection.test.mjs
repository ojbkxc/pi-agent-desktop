import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { PurgeGateLogView, asGateLogData } = await jiti.import("./PurgeGateLogSection.tsx");

function render(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: "en" }, element));
}

const DATA = {
  attribution: {
    byLayer: { "tool-approval": 2, "permission-gate": 0, "project-trust": 1, "mcp-trust": 0, model: 0 },
    byDecision: { allowed: 2, denied: 1 },
  },
  events: [{ at: 1700000000000, layer: "tool-approval", decision: "denied", reason: "rejected" }],
};

test("asGateLogData 拒绝缺字段的形状", () => {
  assert.equal(asGateLogData(null), null);
  assert.equal(asGateLogData("x"), null);
  assert.equal(asGateLogData({}), null);
  assert.equal(asGateLogData({ attribution: {} }), null);
});

test("asGateLogData 归一化缺失的层为 0，并过滤非法事件", () => {
  const parsed = asGateLogData({
    attribution: { byLayer: { "tool-approval": 3 }, byDecision: { allowed: 1, denied: 2 } },
    events: [
      { at: 1, layer: "tool-approval", decision: "allowed" },
      { at: 2, layer: "not-a-gate", decision: "denied" },
      { at: 3, layer: "model", decision: "maybe" },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.attribution.byLayer["tool-approval"], 3);
  assert.equal(parsed.attribution.byLayer["model"], 0);
  assert.equal(parsed.attribution.byDecision.allowed, 1);
  assert.equal(parsed.attribution.byDecision.denied, 2);
  assert.equal(parsed.events.length, 1);
});

test("View 渲染真实文案（不出现键名）与闸门行", () => {
  const html = render(React.createElement(PurgeGateLogView, { data: DATA, failed: false }));
  assert.match(html, /Allowed 2/);
  assert.match(html, /Denied 1/);
  assert.match(html, /tool-approval/);
  assert.match(html, /project-trust/);
  assert.match(html, /denied/);
  assert.doesNotMatch(html, /purge\.gateLog/);
});

test("空事件显示空态", () => {
  const html = render(React.createElement(PurgeGateLogView, {
    data: { ...DATA, events: [] },
    failed: false,
  }));
  assert.match(html, /No gate events yet/);
});

test("失败态显示加载失败文案", () => {
  const html = render(React.createElement(PurgeGateLogView, { data: null, failed: true }));
  assert.match(html, /Could not load the gate log/);
  assert.doesNotMatch(html, /purge\.gateLog/);
});
