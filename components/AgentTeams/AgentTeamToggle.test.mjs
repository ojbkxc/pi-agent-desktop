import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * A2 composer 开关（`AgentTeamToggle`）：只有 SSR 静态标记可断言（组件用了 useI18n，
 * 没有像计划卡那样的纯视图可拆分），所以这里锁的是**属性口径与文案**，不是回调接线：
 *
 * - 可用 + armed → `data-armed` / `aria-pressed="true"`，没有 is-unavailable；
 * - 不可用 → `is-unavailable` + `data-disabled-reason`，**不落 aria-pressed**（它只在真能
 *   切换时有意义），且 title 是本地化文案；
 * - 每个不可用原因都必须有文案，**绝不把 i18n 键原文渲染到界面**（每个用例反向断言
 *   `chat.agentTeam.` 不出现）。
 *
 * `disabled` 这一档是「全局开关关掉」——照 cc-haha，那行仍然在、只是不能勾、点了去设置。
 */
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AgentTeamToggle } = await jiti.import("./AgentTeamToggle.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { initialLocale: "en" },
      React.createElement(AgentTeamToggle, {
        onToggle: () => {},
        onOpenSettings: () => {},
        ...props,
      }),
    ),
  );
}

test("可用 + armed：高亮、aria-pressed=true、不带不可用标记", () => {
  const html = render({ armed: true, available: true });
  assert.match(html, /data-agent-team-toggle/);
  assert.match(html, /data-armed="true"/);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /is-unavailable/);
  assert.doesNotMatch(html, /data-disabled-reason/);
});

test("可用 + 未 armed：aria-pressed=false，不落 data-armed", () => {
  const html = render({ armed: false, available: true });
  assert.match(html, /aria-pressed="false"/);
  assert.doesNotMatch(html, /data-armed/);
  assert.doesNotMatch(html, /is-unavailable/);
});

test("全局关掉（disabled）：整行还在、置灰、无 aria-pressed、title 是本地化文案", () => {
  const html = render({ armed: false, available: false, disabledReason: "disabled" });
  assert.match(html, /data-agent-team-toggle/, "全局关掉时那行必须仍在（照 cc-haha：整行消失＝能力静默消失）");
  assert.match(html, /is-unavailable/);
  assert.match(html, /data-disabled-reason="disabled"/);
  assert.doesNotMatch(html, /aria-pressed/, "不可用时不该落 aria-pressed");
  assert.match(html, /title="Agent Teams are off in Settings/);
  assert.doesNotMatch(html, /chat\.agentTeam\./, "不得把 i18n 键原文渲染到界面");
});

test("chatOnly / lean / memberSession 三个原因都有本地化文案（不渲染键原文）", () => {
  const expected = {
    chatOnly: /Not available in Chat-only sessions/,
    lean: /Not available in Lean mode/,
    memberSession: /Team members cannot start a team/,
  };
  for (const [reason, pattern] of Object.entries(expected)) {
    const html = render({ armed: false, available: false, disabledReason: reason });
    assert.match(html, new RegExp(`data-disabled-reason="${reason}"`), reason);
    assert.match(html, pattern, `${reason} 的文案`);
    assert.doesNotMatch(html, /chat\.agentTeam\./, `${reason} 不得渲染键原文`);
  }
});
