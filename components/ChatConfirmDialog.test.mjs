import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ChatConfirmDialog.tsx", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatConfirmDialog } = await jiti.import("./ChatConfirmDialog.tsx");

// ── 共享模态基建接入（team-lead 口径：迁移到 useModalDismiss，行为等价）────────
test("ChatConfirmDialog 接入 useModalDismiss：不再保留第二套 Esc/Tab 逻辑", () => {
  assert.match(source, /import \{ useModalDismiss \} from "@\/hooks\/useModalDismiss"/, "必须使用共享 hook");
  assert.doesNotMatch(source, /openStackedDialog/, "不再保留第二套 Esc/焦点逻辑");
  assert.doesNotMatch(source, /event\.key !== "Tab"/, "Tab 圈禁交给共享 hook");
  // 危险确认框的初始焦点放在「取消」（useModalDismiss 的 [data-autofocus] 约定）。
  assert.match(source, /data-autofocus/, "取消按钮带 data-autofocus");
});

test("对话框结构保持：命名、复选框、危险按钮与错误仍在", () => {
  const html = renderToStaticMarkup(React.createElement(ChatConfirmDialog, {
    title: "Delete this chat?",
    body: "The conversation is removed for good.",
    checkboxLabel: "Also move the chat's folder to the Trash",
    checkboxDefault: true,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    danger: true,
    error: "boom",
    onCancel() {},
    onConfirm() {},
  }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /Delete this chat\?/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /is-primary is-danger/);
  assert.match(html, /role="alert"[^>]*>boom/);
  assert.match(html, /data-autofocus/);
});
