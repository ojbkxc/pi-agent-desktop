import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * AgentTeamsView 是纯客户端组件（挂载时才 fetch /api/teams，SSR 渲染不出下拉），
 * 所以这里只对源码做接线断言：团队下拉的 value 必须是目录名（id，稳定、可查表），
 * label 必须用 displayName（config.name）——否则中文团队名会显示成一串短横线。
 */
test("团队下拉：value 用目录名，label 用 displayName", async () => {
  const source = await readFile(new URL("./AgentTeamsView.tsx", import.meta.url), "utf8");
  assert.match(source, /options=\{teams\.map\(\(team\) => \(\{ value: team\.name, label: team\.displayName \}\)\)\}/);
  assert.match(source, /displayName: string/, "TeamSummary 必须声明 displayName");
  assert.doesNotMatch(source, /label:\s*team\.name\b/, "label 不得再用目录名");
});
