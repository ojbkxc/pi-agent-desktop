import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 无 DOM 渲染器（仓库没有 jsdom / testing-library，也不为一条测试引入依赖），
// AppShell 首屏还依赖路由、会话请求与 SSE，静态渲染到不了顶栏浮层与快捷键帮助
// 的 portal —— 与 AppShell.top-panel.test.mjs 同样的理由。
//
// 这里钉住两处「键盘层级」接线形状；行为语义分别由监听两侧直接覆盖：
// - 全局 Esc 的 defaultPrevented 契约：hooks/useKeyboardShortcuts.test.mjs
// - 模态 Tab 圈禁 / 焦点归还：lib/modal-focus.ts 的纯函数单测（hooks/useModalDismiss.test.mjs）
const source = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

// 顶栏下拉（Tools / System prompt / 会话统计）与 More 菜单都挂在 document 冒泡段；
// 全局 Esc 在 window 上以 defaultPrevented 判定「已被更近的层处理」。
// 关闭浮层却不 preventDefault 时，事件继续到 window → globalAbortHandler()，
// 正在流式输出的回答会被一并停掉（interaction.md P1）。
test("顶栏两层浮层的 Esc 通过共用 helper 标记 handled", () => {
  assert.match(
    source,
    /function closeTopLayerOnEscape\(event: KeyboardEvent, close: \(\) => void\): void \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?close\(\);/,
    "顶栏浮层的 Esc handler 必须 preventDefault 后再关闭",
  );
  assert.match(source, /closeTopLayerOnEscape\(event, \(\) => setTopMoreOpen\(false\)\)/);
  assert.match(source, /closeTopLayerOnEscape\(event, \(\) => setActiveTopPanel\(null\)\)/);
  // 回归哨兵：旧的「只改 state、不标 handled」写法不得回来。
  assert.doesNotMatch(source, /if \(event\.key === "Escape" && !isImeComposing\(event\)\) set[A-Za-z]+\(/);
});

// 快捷键帮助原来自带一个「任何 Tab 都 preventDefault 并跳到首/尾」的 capture 监听：
// 当前只有一个关闭按钮看不出问题，加第二个可聚焦元素后 Tab 就无法在两者间移动
// （a11y.md P2）。改接共享模态 hook：Esc（preventDefault + stopPropagation）、
// Tab/Shift+Tab 只在边界回绕、初始焦点进入面板、关闭归还 opener。
test("快捷键帮助接入共享模态 hook，不再自带跳首/尾的 Tab 处理", () => {
  assert.match(source, /import \{ useModalDismiss \} from "@\/hooks\/useModalDismiss";/);
  assert.match(
    source,
    /useModalDismiss<HTMLDivElement>\(\s*\(\) => setShortcutHelpOpen\(false\),\s*shortcutHelpOpen,?\s*\)/,
  );
  // ref 仍挂在对话框面板（不是遮罩）上，hook 靠它做圈禁与初始焦点。
  assert.match(source, /ref=\{shortcutHelpDialogRef\}/);
  assert.doesNotMatch(source, /document\.addEventListener\("keydown", handleKeyDown, true\)/);
  assert.doesNotMatch(source, /const next = event\.shiftKey \? focusable\[focusable\.length - 1\] : focusable\[0\]/);
});