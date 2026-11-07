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
