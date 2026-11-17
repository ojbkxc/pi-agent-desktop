import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./DirectoryPicker.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("both directory picker layers use the shared modal stack for Escape and Tab", () => {
  // a11y.md P1：Esc 原先绑在 backdrop 的 React onKeyDown 上且不 preventDefault，
  // 焦点在按钮上时会继续冒泡到 window 的全局快捷键，把运行中的 agent 停掉。
  assert.match(source, /import \{ useModalDismiss \} from "@\/hooks\/useModalDismiss"/);
  // 外层目录选择器：ref 挂在面板上（不是遮罩），Busy 时仍占栈顶但不关闭。
  assert.match(source, /const panelRef = useModalDismiss<HTMLDivElement>\(requestCancel\)/);
  assert.match(source, /ref=\{panelRef\}[\s\S]{0,200}className="directory-picker-panel"/);
  // 「新建目录」是叠在上面的第二层模态，只在 createOpen 期间入栈。
  assert.match(source, /const createPanelRef = useModalDismiss<HTMLFormElement>\(closeCreateDialog, createOpen\)/);
  assert.match(source, /ref=\{createPanelRef\}/);
});

test("no raw Escape handler leaks from the backdrop anymore", () => {
  // 旧的泄漏点：backdrop 上的 onKeyDown 只调 onCancel，不阻止冒泡。
  assert.doesNotMatch(source, /onKeyDown=\{\(event\) => \{\s*if \(event\.key === "Escape" && !busy && !isImeComposing\(event\)\) onCancel\(\);/);
  // lib/ime.test.mjs 的哨兵要求保留共享 IME guard：现在只用于路径输入的 Enter
  // （组合中的 Enter 确认候选词，不能触发表单跳转），Esc 由共享模态栈接管。
  assert.match(source, /import \{ isImeComposing \} from "@\/lib\/ime";/);
  assert.match(source, /if \(event\.key === "Enter" && isImeComposing\(event\)\) event\.preventDefault\(\);/);
  // 遮罩不再承载 dialog 语义；面板自己才是 role="dialog" 的焦点容器。
  assert.match(source, /className="directory-picker-backdrop"\s*\n\s*role="presentation"/);
});
