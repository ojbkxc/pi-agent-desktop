import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  FallbackSettings,
  ManualNeedsList,
  EnvDisabledNotice,
  manualNeedEntries,
  msToMinutes,
  minutesToMs,
  buildConfigBody,
  clearManualNeedsBody,
} = await jiti.import("./FallbackSettings.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);

test("minutes <-> ms round-trip for the timeout field", () => {
  assert.equal(msToMinutes(600_000), 10);
  assert.equal(minutesToMs(10), 600_000);
  assert.equal(msToMinutes(120_000), 2);
});

test("manualNeedEntries maps and sorts newest first", () => {
  const entries = manualNeedEntries({
    "plan:p1": { at: 5, reason: "投递失败" },
    "ticket:t9": { at: 9, reason: "已达重试上限" },
  });
  assert.deepEqual(entries, [
    { key: "ticket:t9", at: 9, reason: "已达重试上限" },
    { key: "plan:p1", at: 5, reason: "投递失败" },
  ]);
  assert.deepEqual(manualNeedEntries(undefined), []);
});

test("buildConfigBody converts UI minutes back to ms", () => {
  assert.deepEqual(buildConfigBody({ enabled: false, timeoutMinutes: 3, maxFailureRetries: 1 }), {
    enabled: false,
    approvalTimeoutMs: 180_000,
    maxFailureRetries: 1,
  });
  assert.deepEqual(clearManualNeedsBody(["plan:p1"]), { action: "clear-manual-needs", keys: ["plan:p1"] });
});

test("ManualNeedsList renders nothing when there is nothing to show", () => {
  const html = render(React.createElement(ManualNeedsList, { items: [], onClear: () => {} }));
  assert.equal(html, "", "空列表不渲染空壳区块");
});

test("ManualNeedsList lists each item with its reason and a clear button", () => {
  const html = render(React.createElement(ManualNeedsList, {
    items: [
      { key: "ticket:t9", at: 9, reason: "已达重试上限" },
      { key: "plan:p1", at: 5, reason: "投递失败" },
    ],
    onClear: () => {},
  }));
  assert.match(html, /data-testid="fallback-manual-needs"/);
  assert.equal((html.match(/data-key="/g) ?? []).length, 2);
  assert.match(html, /已达重试上限/);
  assert.match(html, /投递失败/);
  assert.equal((html.match(/team-fallback-clear/g) ?? []).length, 2, "逐条清除按钮");
});

test("EnvDisabledNotice says it is disabled by the environment variable", () => {
  const html = render(React.createElement(EnvDisabledNotice));
  assert.match(html, /data-testid="fallback-env-disabled"/);
  assert.match(html, /PI_WEB_DISABLE_TEAMS_FALLBACK/);
});

test("FallbackSettings starts in its loading state (no fetch during SSR)", () => {
  const html = render(React.createElement(FallbackSettings));
  assert.match(html, /scheduled-hint/);
  assert.doesNotMatch(html, /data-testid="fallback-settings"/);
});

test("the initial load effect does not depend on the locale (d5-22)", async () => {
  // deps 含 t 时切语言会重取并用服务端值 setDraft，覆盖未保存的草稿；改口径后
  // 拉取 effect 必须无依赖（mount-only），错误文案延迟到渲染处取。
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./FallbackSettings.tsx", import.meta.url), "utf8");
  const loadEffect = source.slice(source.indexOf('fetch("/api/teams/fallback"'));
  assert.match(loadEffect, /\} catch \(err\) \{[\s\S]*?setLoadError\([\s\S]*?\} finally[\s\S]*?\}, \[\]\);/, "the fetch effect must be mount-only");
  assert.doesNotMatch(loadEffect, /\}, \[t\]\);/, "a [t] dependency would clobber unsaved drafts on locale switch");
  // 渲染处取翻译：错误显示经 displayError（loadError → 翻译键）。
  assert.match(source, /const displayError = loadError !== null \? t\("teams\.fallback\.loadFailed"\) : error;/);
});
