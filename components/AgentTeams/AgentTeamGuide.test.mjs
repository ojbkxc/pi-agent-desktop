import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * A9 一次性发现引导组件：渲染 + 回调接线。
 *
 * 无 DOM 环境（无 jsdom / testing-library），沿用仓库约定：先用 react-dom/server 断言
 * 静态标记，再直接调用纯视图 `agentTeamGuideView` 并遍历元素树，取出两个按钮的 onClick
 * 逐个触发，验证它们分别接到 onEnable / onDismiss。
 */

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AgentTeamGuide, agentTeamGuideView } = await jiti.import("./AgentTeamGuide.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);

/** 遍历 React 元素树，收集满足 pred 的节点。 */
function collect(node, pred, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  const children = node.props?.children;
  if (children != null) {
    for (const child of Array.isArray(children) ? children : [children]) collect(child, pred, out);
  }
  return out;
}

test("渲染：标题 / 正文 / 两个按钮与三语文案都在", () => {
  const html = render(React.createElement(AgentTeamGuide, { onEnable() {}, onDismiss() {} }));
  assert.match(html, /data-testid="agent-team-guide"/);
  assert.match(html, /role="note"/);
  assert.match(html, /agent-team-guide-title/);
  assert.match(html, /agent-team-guide-body/);
  assert.match(html, /agent-team-guide-enable/);
  assert.match(html, /agent-team-guide-dismiss/);
  assert.match(html, /Let a team handle this\?/);
  assert.match(html, /Turn it on and the next message is split across an Agent Team\./);
  assert.match(html, /Turn on/);
  assert.match(html, /Got it/);
});

test("点主按钮触发 onEnable；点关闭按钮触发 onDismiss", () => {
  let enabled = 0;
  let dismissed = 0;
  const tree = agentTeamGuideView(
    (key) => key,
    () => { enabled += 1; },
    () => { dismissed += 1; },
  );

  const buttons = collect(tree, (node) => typeof node.type === "string" && node.type === "button");
  const enable = buttons.find((b) => String(b.props.className).includes("agent-team-guide-enable"));
  const dismiss = buttons.find((b) => String(b.props.className).includes("agent-team-guide-dismiss"));

  assert.ok(enable, "存在「开启」主按钮");
  assert.ok(dismiss, "存在「关闭」按钮");
  assert.equal(typeof enable.props.onClick, "function");
  assert.equal(typeof dismiss.props.onClick, "function");

  enable.props.onClick();
  assert.equal(enabled, 1, "主按钮接 onEnable");
  assert.equal(dismissed, 0);

  dismiss.props.onClick();
  assert.equal(dismissed, 1, "关闭按钮接 onDismiss");
  assert.equal(enabled, 1, "两个回调互不串台");
});
