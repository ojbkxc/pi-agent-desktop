import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 接线守卫（V2）：对抗验证点出两处「声称有、其实断/缺」的地方，这里用「读源码 +
// 正则」定点钉住，防上游合并或后续重构悄悄摘掉（写法与
// components/AgentTeams/AgentTeamsView.wiring.test.mjs 一致）。只守「接线 / CSS 是否在位」，
// 不锁具体实现细节。
//
//   S1 —— AppShell 渲染 <AgentTeamsView> 时五个 prop 必须齐全。少了 onRequestClose，
//         workbench-ui 在 AgentTeamsView.tsx 写的「← 返回会话」按钮（`onRequestClose && …`）
//         永远为假、是死代码；少了 sourceSessionId，根节点 data-source-session-id 永远是空。
//   M1 —— 团队条 `--compact`（窄屏）必须真的把文字标签 / 进度 / 阶段文字收敛掉（display:none）。
//   M2 —— armed 的 composer 团队 chip 必须有高亮规则。

const read = async (file) =>
  (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

/** 截出 `<AgentTeamsView … />` 这个 JSX 元素的属性文字（首个自闭合结尾即元素结束）。 */
function agentTeamsViewElement(source) {
  const start = source.indexOf("<AgentTeamsView");
  assert.notEqual(start, -1, "AppShell 没有渲染 <AgentTeamsView>");
  const end = source.indexOf("/>", start);
  assert.notEqual(end, -1, "<AgentTeamsView … /> 没有自闭合结尾");
  return source.slice(start, end);
}

/** css 里 selector 是否落在一条含 `display: none` 的规则内（容忍逗号分组 / 声明顺序）。 */
function hasDisplayNoneRule(css, selector) {
  let index = css.indexOf(selector);
  while (index !== -1) {
    const braceStart = css.indexOf("{", index);
    const braceEnd = css.indexOf("}", braceStart);
    if (braceStart !== -1 && braceEnd > braceStart) {
      const block = css.slice(braceStart, braceEnd);
      if (/display\s*:\s*none/.test(block)) return true;
    }
    index = css.indexOf(selector, index + 1);
  }
  return false;
}

// `\b` 前缀确保 `teamName` 不会误命中 `initialTeamName=` 里的子串——否则删掉 teamName
// 后断言仍会因 initialTeamName 而假绿。
const AGENT_TEAMS_VIEW_PROPS = [
  "teamName",
  "initialTeamName",
  "sourceSessionId",
  "onRequestClose",
  "onOpenSession",
];

test("S1：AppShell 传齐 <AgentTeamsView> 的五个 prop（缺一即断/死代码）", async () => {
  const element = agentTeamsViewElement(await read("./AppShell.tsx"));
  for (const name of AGENT_TEAMS_VIEW_PROPS) {
    assert.match(
      element,
      new RegExp(`\\b${name}\\s*=`),
      `<AgentTeamsView> 少了 ${name}= —— 工作台「← 返回会话」/ 来源会话标识会断`,
    );
  }
});

test("M1：团队条 --compact 收敛文字标签 / 进度 / 阶段文字（display:none）", async () => {
  const css = await read("../app/native-theme.css");
  for (const cls of ["agent-team-strip-label", "agent-team-strip-progress", "agent-team-strip-phase-label"]) {
    const selector = `.agent-team-strip--compact .${cls}`;
    assert.ok(
      css.includes(selector),
      `native-theme.css 缺 ${selector} 选择器（窄屏该文字不会收敛）`,
    );
    assert.ok(
      hasDisplayNoneRule(css, selector),
      `${selector} 没有 display:none —— 窄屏下该文字仍会占位`,
    );
  }
});

test("M2：armed 的 composer 团队 chip 有高亮规则", async () => {
  const css = await read("../app/native-theme.css");
  const selector = ".composer-teams-chip--composer.is-armed";
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `native-theme.css 缺 ${selector}`);
  const braceStart = css.indexOf("{", start);
  const braceEnd = css.indexOf("}", braceStart);
  assert.ok(braceStart !== -1 && braceEnd > braceStart, `${selector} 不是一条声明块`);
  assert.ok(/\S/.test(css.slice(braceStart + 1, braceEnd)), `${selector} 规则体为空`);
});
