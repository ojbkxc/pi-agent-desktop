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
const {
  ApprovalModeIndicator,
  ApprovalModeIndicatorView,
  approvalNeedsConfirmation,
  nextApprovalMode,
} = await jiti.import("./ApprovalModeIndicator.tsx");

function renderWithI18n(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: "en" }, element));
}

test("nextApprovalMode 按 off → dangerous → all → off 循环", () => {
  assert.equal(nextApprovalMode("off"), "dangerous");
  assert.equal(nextApprovalMode("dangerous"), "all");
  assert.equal(nextApprovalMode("all"), "off");
  // 回到 off 后再走一步，确认是真正的循环而不是单次映射。
  assert.equal(nextApprovalMode(nextApprovalMode("all")), "dangerous");
});

test("nextApprovalMode 对未知档位回落到默认的 off", () => {
  assert.equal(nextApprovalMode("nonsense"), "off");
});

test("approvalNeedsConfirmation：只有进入 all 需要确认，off 与 dangerous 静默", () => {
  assert.equal(approvalNeedsConfirmation("all"), true);
  assert.equal(approvalNeedsConfirmation("off"), false);
  assert.equal(approvalNeedsConfirmation("dangerous"), false);
});

test("View 在 mode=all 时渲染真实文案、aria-live 与 aria-label", () => {
  const html = renderWithI18n(
    React.createElement(ApprovalModeIndicatorView, {
      mode: "all",
      label: "All commands",
      ariaLabel: "Change command approval mode",
      updateFailedText: "Could not update the approval mode",
      onClick() {},
    }),
  );

  // 显示的是文案而不是键名。
  assert.match(html, /All commands/);
  assert.doesNotMatch(html, /approval\.mode/);
  // 辅助技术：aria-live 播报 + 按钮 aria-label。
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="Change command approval mode"/);
  assert.match(html, /data-approval-mode="all"/);
});

test("View disabled 时按钮带 disabled 属性且不发请求", () => {
  const html = renderWithI18n(
    React.createElement(ApprovalModeIndicatorView, {
      mode: "off",
      label: "Full access",
      ariaLabel: "Change command approval mode",
      updateFailedText: "Could not update the approval mode",
      disabled: true,
      onClick() {
        throw new Error("disabled 时不得触发点击");
      },
    }),
  );

  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, /data-approval-mode="off"/);
});

test("View 在失败时用 alert 区域呈现失败文案", () => {
  const html = renderWithI18n(
    React.createElement(ApprovalModeIndicatorView, {
      mode: "dangerous",
      label: "Dangerous commands only",
      ariaLabel: "Change command approval mode",
      updateFailedText: "Could not update the approval mode",
      failed: true,
      onClick() {},
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Could not update the approval mode/);
  assert.doesNotMatch(html, /approval\.updateFailed/);
});

test("容器在 SSR 阶段（未取到档位）渲染为只读并走真实 i18n 键", () => {
  const html = renderWithI18n(React.createElement(ApprovalModeIndicator));

  // useEffect 在 SSR 不执行，status 为空 → disabled，绝不发 PUT。
  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, /aria-label="Change command approval mode"/);
  assert.match(html, /aria-live="polite"/);
  // 渲染的是加载文案而不是键名。
  assert.doesNotMatch(html, /approval\.(loading|mode\.|cycleAria|updateFailed)/);
});
