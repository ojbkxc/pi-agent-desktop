import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  TeamLifecycleActions,
  LifecycleOutcomeMessage,
  ReclaimConfirm,
  interpretLifecycleOutcome,
  isLifecycleSettled,
  parseLifecycleResults,
} = await jiti.import("./TeamLifecycleActions.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(
  React.createElement(I18nProvider, { initialLocale: "en" }, element),
);

test("parseLifecycleResults keeps valid rows and drops junk", () => {
  assert.equal(parseLifecycleResults(null).length, 0);
  assert.equal(parseLifecycleResults({ results: "nope" }).length, 0);
  const parsed = parseLifecycleResults({
    results: [{ memberId: "a", name: "impl", status: "stopped" }, null, { status: "failed" }],
  });
  assert.deepEqual(parsed.map((result) => result.memberId), ["a"]);
});

test("interpretLifecycleOutcome: stop success counts stopped and already-stopped", () => {
  const outcome = interpretLifecycleOutcome("stop", {
    ok: true,
    results: [
      { memberId: "a", name: "impl", status: "stopped" },
      { memberId: "b", name: "qa", status: "already-stopped" },
    ],
  });
  assert.equal(outcome.tone, "success");
  assert.equal(outcome.messageKey, "teams.lifecycle.stopDone");
  assert.deepEqual(outcome.params, { count: 1, already: 1 });
});

test("interpretLifecycleOutcome: stop with ok:false is an error, failures carry reasons", () => {
  const outcome = interpretLifecycleOutcome("stop", {
    ok: false,
    reason: "编排失败",
    results: [{ memberId: "a", name: "impl", status: "failed", reason: "会话拒绝" }],
  });
  assert.equal(outcome.tone, "error");
  assert.deepEqual(outcome.failed, [{ name: "impl", reason: "会话拒绝" }]);
});

test("interpretLifecycleOutcome: reclaim is success only when removed===true", () => {
  const done = interpretLifecycleOutcome("reclaim", { ok: true, removed: true, results: [] });
  assert.equal(done.tone, "success");
  assert.equal(done.messageKey, "teams.lifecycle.reclaimDone");
});

test("interpretLifecycleOutcome: reclaim removed:false is a warning, never success", () => {
  const partial = interpretLifecycleOutcome("reclaim", { ok: true, removed: false, reason: "有成员仍在运行", results: [] });
  assert.notEqual(partial.tone, "success", "未删除绝不能显示成功");
  assert.equal(partial.tone, "warning");
  assert.equal(partial.messageKey, "teams.lifecycle.notRemoved");
  assert.equal(partial.params.reason, "有成员仍在运行");

  const noFlag = interpretLifecycleOutcome("reclaim", { ok: true, results: [] });
  assert.equal(noFlag.tone, "warning", "缺 removed 字段同样按未删除处理");
});

test("interpretLifecycleOutcome: malformed payload is an error", () => {
  assert.equal(interpretLifecycleOutcome("stop", null).tone, "error");
});

test("interpretLifecycleOutcome reads the 409-shaped payload (ok:false + error + results)", () => {
  const stop = interpretLifecycleOutcome("stop", {
    ok: false,
    removed: false,
    error: "有成员停止失败，未删除团队目录",
    results: [{ memberId: "a", name: "impl", status: "failed", reason: "会话拒绝" }],
  });
  assert.equal(stop.tone, "error");
  assert.equal(stop.params.message, "有成员停止失败，未删除团队目录");
  assert.deepEqual(stop.failed, [{ name: "impl", reason: "会话拒绝" }]);

  const reclaim = interpretLifecycleOutcome("reclaim", {
    ok: false,
    removed: false,
    error: "有成员停止失败，未删除团队目录",
    results: [],
  });
  assert.equal(reclaim.tone, "warning");
  assert.equal(reclaim.messageKey, "teams.lifecycle.notRemoved");
  assert.equal(reclaim.params.reason, "有成员停止失败，未删除团队目录");
});

test("LifecycleOutcomeMessage marks the tone and lists failed members", () => {
  const html = render(React.createElement(LifecycleOutcomeMessage, {
    outcome: interpretLifecycleOutcome("reclaim", { ok: true, removed: false, reason: "有成员仍在运行", results: [] }),
  }));
  assert.match(html, /data-tone="warning"/);
  assert.doesNotMatch(html, /data-tone="success"/);
  assert.match(html, /有成员仍在运行/);
});

test("ReclaimConfirm carries the display name and member count", () => {
  const html = render(React.createElement(ReclaimConfirm, {
    displayName: "前端重构队",
    memberCount: 5,
    busy: false,
    onConfirm: () => {},
    onCancel: () => {},
  }));
  assert.match(html, /data-testid="reclaim-confirm"/);
  assert.match(html, /前端重构队/);
  assert.match(html, /5/);
  assert.match(html, /team-lifecycle-confirm-danger/);
});

// a11y.md P2：内联确认块不是模态，不能挂 alertdialog（语义与行为不符）。
test("ReclaimConfirm 语义与行为一致：role=group + aria-label，取消按钮初始聚焦，Esc 取消", async () => {
  const html = render(React.createElement(ReclaimConfirm, {
    displayName: "demo",
    memberCount: 2,
    busy: false,
    onConfirm: () => {},
    onCancel: () => {},
  }));
  assert.match(html, /role="group"/, "内联区块用 group");
  assert.doesNotMatch(html, /role="alertdialog"/, "不得声称模态语义");
  assert.match(html, /aria-label=/, "组要有可访问名");
  // 焦点落在「取消」而不是危险按钮；Esc 取消并把事件拦在本地。
  const source = (await import("node:fs/promises")).readFile(new URL("./TeamLifecycleActions.tsx", import.meta.url), "utf8");
  const text = await source;
  assert.match(text, /cancelRef\.current\?\.focus\(\{ preventScroll: true \}\)/, "出现即聚焦取消");
  assert.match(text, /event\.key === "Escape"[\s\S]*event\.stopPropagation\(\)/, "Esc 取消且不冒泡");
  assert.match(text, /onCancel\(\);\s*\n\s*\}\s*\n\s*\}\}/, "Esc 调 onCancel");
});

test("TeamLifecycleActions shows stop and reclaim, no confirm until requested", () => {
  const html = render(React.createElement(TeamLifecycleActions, {
    team: "demo",
    displayName: "前端重构队",
    memberCount: 5,
  }));
  assert.match(html, /team-lifecycle-stop/);
  assert.match(html, /team-lifecycle-reclaim/);
  assert.doesNotMatch(html, /data-testid="reclaim-confirm"/, "回收需先二次确认");
});

// ─────────────────────────────────────────────────────────────────────────────
// 本轮修复：成功判定收紧（200 + ok + removed:false 不算生效）+ 在途 ref 闸。
// ─────────────────────────────────────────────────────────────────────────────

test("isLifecycleSettled：只有 tone=success 才算真的生效", () => {
  assert.equal(isLifecycleSettled(interpretLifecycleOutcome("reclaim", { ok: true, removed: true })), true);
  // 团队目录还在 → 不算生效：父级一旦被告知「完成」，会把选中团队回落掉，
  // 用户看着团队消失，实际还活着，而且再也点不到它。
  assert.equal(isLifecycleSettled(interpretLifecycleOutcome("reclaim", { ok: true, removed: false })), false);
  assert.equal(isLifecycleSettled(interpretLifecycleOutcome("reclaim", { ok: true })), false);
  assert.equal(isLifecycleSettled(interpretLifecycleOutcome("stop", { ok: true, results: [] })), true);
  assert.equal(isLifecycleSettled(interpretLifecycleOutcome("stop", { ok: false })), false);
  assert.equal(isLifecycleSettled(interpretLifecycleOutcome("stop", null)), false);
});

test("源码钉法：onDone 只在真的生效时触发，且在途闸用 ref（连点不会双发）", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./TeamLifecycleActions.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(isLifecycleSettled\(interpreted\)\) onDone\?\.\(team, action\);/,
    "通知父级的条件必须是「真的生效」");
  assert.doesNotMatch(source, /response\.ok && payload!\.ok === true/,
    "旧的宽松成功判定（只看 HTTP + ok 字段）必须消失");
  assert.match(source, /if \(busyRef\.current\) return;/, "在途用 ref 闸，不依赖还没刷新的 state");
  assert.match(source, /keepConfirm = action === "reclaim" && !isLifecycleSettled\(interpreted\);/,
    "回收未删掉时保留确认区，便于就地重试");
  assert.match(source, /if \(!keepConfirm\) setConfirming\(false\);/);
  assert.match(source, /if \(!aliveRef\.current\) return;/, "卸载后不再 setState");
});

test("LifecycleOutcomeMessage：三档语气分别接到 status / alert，并带 aria-live", () => {
  const success = render(React.createElement(LifecycleOutcomeMessage, {
    outcome: interpretLifecycleOutcome("stop", { ok: true, results: [] }),
  }));
  assert.match(success, /role="status"/);
  assert.match(success, /aria-live="polite"/);
  const error = render(React.createElement(LifecycleOutcomeMessage, {
    outcome: interpretLifecycleOutcome("stop", { ok: false, error: "boom" }),
  }));
  assert.match(error, /role="alert"/);
  assert.match(error, /aria-live="assertive"/);
});
