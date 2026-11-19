import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 聊天区会话标题条（SessionTitleStrip）。
 *
 * 无 DOM 环境：react-dom/server 静态标记 + I18nProvider(en) 渲染真实文案。
 * 口径与侧栏/顶栏一致：`name || 首条消息 || 未命名`；skill 展开形式的首条消息
 * 折叠回 `/skill:name`；无会话（新会话尚无 id）不渲染、不留空位。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SessionTitleStrip } = await jiti.import("./SessionTitleStrip.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);

const session = (over = {}) => ({ id: "s-1", name: "Fix SSE reconnect", firstMessage: "hello", ...over });

test("有 name：展示标签 + 会话名", () => {
  const html = render(React.createElement(SessionTitleStrip, { session: session() }));
  assert.match(html, /data-testid="session-title-strip"/);
  assert.match(html, /Session title/);
  assert.match(html, /Fix SSE reconnect/);
});

test("无 name：回退到首条消息", () => {
  const html = render(React.createElement(SessionTitleStrip, { session: session({ name: undefined, firstMessage: "改造订单查询页" }) }));
  assert.match(html, /改造订单查询页/);
  assert.doesNotMatch(html, /Untitled session/);
});

test("无 name 无首条消息：未命名兜底，不渲染裸 id", () => {
  const html = render(React.createElement(SessionTitleStrip, { session: session({ name: "  ", firstMessage: "" }) }));
  assert.match(html, /Untitled session/);
  assert.doesNotMatch(html, /s-1/);
});

test("skill 展开形式的首条消息折叠回 /skill 命令", () => {
  const html = render(React.createElement(SessionTitleStrip, {
    session: session({
      name: undefined,
      firstMessage: "<skill name=\"testcase\" location=\"/skills/testcase/SKILL.md\">\nReferences are relative to /skills/testcase.\n\nYou are a testcase writer.\n</skill>\n\n登记新的用例",
    }),
  }));
  assert.match(html, /\/skill:testcase 登记新的用例/);
  assert.doesNotMatch(html, /You are a testcase writer/);
});

test("无会话（新会话尚无 id）不渲染", () => {
  assert.equal(render(React.createElement(SessionTitleStrip, { session: null })), "");
  assert.equal(render(React.createElement(SessionTitleStrip, { session: { id: "" } })), "");
});

test("不得把 i18n 键原文渲染到界面", () => {
  const html = render(React.createElement(SessionTitleStrip, { session: session() }));
  assert.doesNotMatch(html, /chat\.sessionTitle\.label|chat\.untitledSession/);
});
