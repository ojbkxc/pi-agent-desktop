import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * AgentTeamCostDialog 的回归守卫（a11y.md P1 + data-tests B-3）。
 *
 * 缺陷原文：组件是 `role="dialog" aria-modal="true"` 却无 Esc、无初始焦点、无 Tab
 * 圈禁、无归还。实测两条后果：
 * 1. 焦点在按钮/body 时 Esc 冒泡到 `hooks/useKeyboardShortcuts.ts` 的全局 abort
 *    → **停掉正在运行的 Agent**；
 * 2. 从 Settings（AgentTeamsSettingRow）打开时 Esc 被 SettingsPanel 的
 *    `listenForPanelEscape` 接住 → **关掉 Settings 而把成本框留在最上层**。
 *
 * 仓库没有 DOM 测试渲染器（见 hooks/useModalDismiss.test.mjs 顶部），所以这里：
 * - SSR 断言结构与语义（role 挂面板、遮罩 presentation、data-autofocus 在取消）；
 * - 源码哨兵钉住「Esc / Tab / 初始焦点 / 归还 / 与 Settings 的嵌套退让」全部走共享
 *   `useModalDismiss`，且 `enabled` 与 open 绑定（关闭后不能残留模态栈）。
 */

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentTeamCostDialog } = await jiti.import("./AgentTeamCostDialog.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);

test("open=false 渲染空；open=true 渲染 dialog 面板与两个按钮", () => {
  const closed = render(React.createElement(AgentTeamCostDialog, {
    open: false, onConfirm: () => {}, onCancel: () => {},
  }));
  assert.equal(closed, "");
  const html = render(React.createElement(AgentTeamCostDialog, {
    open: true, onConfirm: () => {}, onCancel: () => {},
  }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /agent-team-cost-cancel/);
  assert.match(html, /agent-team-cost-confirm/);
  // 遮罩是 presentation；dialog 语义只在面板上（否则读屏器会把遮罩当对话框）。
  assert.match(html, /class="agent-team-cost-backdrop" role="presentation"/);
  assert.doesNotMatch(html, /chat\.agentTeam\.cost\.title/, "不得渲染 i18n 键原文");
});

test("初始焦点落在「取消」上（data-autofocus，安全选项）", () => {
  const html = render(React.createElement(AgentTeamCostDialog, {
    open: true, onConfirm: () => {}, onCancel: () => {},
  }));
  assert.match(html, /class="agent-team-cost-cancel" data-autofocus/, "取消按钮带 data-autofocus");
  // 确认按钮不带（只有取消是安全默认）。
  assert.doesNotMatch(html, /agent-team-cost-confirm[^>]*data-autofocus/);
});

test("源码哨兵：Esc / Tab / 初始焦点 / 归还全部走共享 useModalDismiss，enabled 绑定 open", async () => {
  const source = (await readFile(new URL("./AgentTeamCostDialog.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  // 1) 共享 hook（capture 段 preventDefault + stopPropagation，且只关栈顶）。
  assert.match(source, /import \{ useModalDismiss \} from "@\/hooks\/useModalDismiss"/);
  assert.match(
    source,
    /const panelRef = useModalDismiss<HTMLDivElement>\(\(\) => settle\(false\), open\)/,
    "Esc 等价于 cancel；enabled 必须是 open（关闭后不得残留模态栈）",
  );
  // 2) ref 挂面板，不挂遮罩。
  assert.match(source, /ref=\{panelRef\}\s*\n\s*className="agent-team-cost-dialog"/);
  // 3) 不得再自建 document/window 级 Esc 监听（会和 hook 重复，也容易漏 preventDefault）。
  assert.doesNotMatch(source, /addEventListener\("keydown"/);
  // 4) 遮罩点击只在地面命中时关闭（点击面板内部不误关）。
  assert.match(source, /if \(event\.target === event\.currentTarget\) settle\(false\)/);
});