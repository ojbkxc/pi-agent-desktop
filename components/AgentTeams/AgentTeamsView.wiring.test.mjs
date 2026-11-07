import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// 接线守卫：成员改模型与生命周期操作是「服务端 + 选择器都写好、UI 从没挂上」补的线，
// 一旦被后续合并悄悄摘掉就再没人叫得醒（与 restored-wiring.test.mjs 同款定点断言）。
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
await jiti.import("./AgentTeamsView.tsx");

const read = async (file) => (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("成员改模型面板被挂上，且单个/批量两个入口都在", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /import \{ TeamMemberModelPanel \}/);
  assert.match(source, /<TeamMemberModelPanel\b/);
  assert.match(source, /team=\{selected\}/, "PATCH 用的必须是目录名 name");
  assert.match(source, /className="agent-teams-member-model"/, "成员行单个「换模型」");
  assert.match(source, /className="agent-teams-batch-model"/, "顶部「批量换模型」");
});

test("生命周期操作被挂上，且确认文案用 displayName + memberCount", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /import \{ TeamLifecycleActions \}/);
  assert.match(source, /<TeamLifecycleActions\b/);
  assert.match(source, /displayName=\{currentDisplayName\}/);
  assert.match(source, /memberCount=\{currentMemberCount\}/);
  // currentDisplayName 取 displayName（config.name），绝不拿 sanitize 目录名渲染
  assert.match(source, /const currentDisplayName = currentTeam\?\.displayName \?\? selected \?\? ""/);
});

test("无人值守兜底设置面被挂上（含 manualNeeds 清除入口）", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /import \{ FallbackSettings \}/);
  assert.match(source, /<FallbackSettings \/>/);
});
