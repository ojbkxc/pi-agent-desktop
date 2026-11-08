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

// d5-2（v2 判真·高危）：批量→单个切换时面板原地复用，useState(memberIds) 只在挂载时
// 取值——提交会把整批成员打到 PATCH 上。守卫：面板必须按 mode+成员集重挂载，且切换
// 团队时面板关闭（跨团队残留同理）。
test("d5-2：换模型面板按 mode+成员集重挂载，切团队时关闭", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /key=\{`\$\{modelPanel\.mode\}-\$\{modelPanel\.memberIds\.join\(","\)\}`\}/);
  assert.match(source, /setModelPanel\(null\);\s*\n\s*\}, \[selected\]\);/, "selected 变化时关闭面板");
});

// d5-3（v2 判真·高危）：生命周期组件无 key——A 团队开着回收确认框切到 B，确认会 POST
// 到 B（不可逆）。onDone 也从未接线，回收成功后名册与时间线不刷新。守卫：key 随团队
// 重挂载 + onDone 已接（携带团队名与动作）。
test("d5-3：生命周期组件按团队重挂载，onDone 已接线", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /<TeamLifecycleActions\b[\s\S]*?key=\{selected\}/);
  assert.match(source, /onDone=\{handleLifecycleDone\}/);
  assert.match(source, /const handleLifecycleDone = useCallback\(\(doneTeam: string, action: string\)/);
  const lifecycle = await read("./TeamLifecycleActions.tsx");
  assert.match(lifecycle, /onDone\?\.\(team, action\)/, "onDone 必须携带操作团队名与动作");
});

// d4-1（队长转达的一行级规格）：完成度只认 countTaskStates 的 completed，
// 不得自数 status === "ended"（失败票已 ended，会被错误计成完成）。
test("d4-1：进度条 done 与统计头同源（countTaskStates.completed）", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /const done = counts\.completed;/);
  assert.doesNotMatch(source, /filter\(\(ticket\) => ticket\.status === "ended"\)\.length/);
});

// #55 第一段（忙闲可见，纯读派生）：成员区标题行必须有空闲成员名单与未认领派活
// 的降级提示；派生来自 ./member-workload（纯函数，边界单测在同目录 member-workload.test.mjs）。
// 自动化边界（已拍板）：系统只检测与提示，改派/加成员由用户一键确认——本区不得出现动作按钮。
test("#55：成员区空闲名单与未认领提示已接线（纯读，无动作按钮）", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /import \{ deriveMemberWorkloads, idleMemberIds \} from "\.\/member-workload"/);
  assert.match(source, /t\("teams\.workload\.idleMembers", \{ names: idleNames\.join\(", "\) \}\)/);
  assert.match(source, /t\("teams\.workload\.unassigned", \{ count: orphanCount \}\)/);
  // 空闲名单按名册顺序派生自快照（snapshot 变化即重算）。
  assert.match(source, /const idleNames = useMemo\(\(\) => \{[\s\S]*?idleMemberIds\(snapshot\)/);
  const workload = await read("./member-workload.ts");
  assert.match(workload, /export function deriveMemberWorkloads/);
  assert.match(workload, /export function idleMemberIds/);
  assert.match(workload, /export function workloadBadgeKind/);
  const band = await read("./FormationBand.tsx");
  assert.match(band, /deriveMemberWorkloads\(snapshot\)\.byMemberId/);
  assert.match(band, /data-workload=\{badge\.kind\}/);
});

// #58 一键调度动作面板挂载（v5 契约）：建议只展示、执行两段式确认、workload 失败
// 只降级面板不阻断画布；票标题由既有快照映射（缺票回退 ticketId）。
test("#58：DispatchPanel 已挂载并传快照票标题映射（建议只展示，失败不阻断画布）", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /import \{ DispatchPanel \} from "@\/components\/AgentTeams\/DispatchPanel"/);
  assert.match(source, /<DispatchPanel\s/);
  assert.match(source, /team=\{selected\}/);
  assert.match(source, /snapshotStamp=\{snapshot\?\.generatedAt \?\? null\}/);
  assert.match(source, /ticketSubjects=\{ticketSubjects\}/);
  assert.match(source, /for \(const ticket of snapshot\?\.tickets \?\? \[\]\) map\[ticket\.id\] = ticket\.subject;/);
  const panel = await read("./DispatchPanel.tsx");
  // 执行端点与请求体走 v5 契约字段。
  assert.match(panel, /\/assignments`, \{/);
  assert.match(panel, /action: "add", members: \[member\]/);
});

// #63 占用行（v8 平铺契约 @ 9b7c083）：字段缺失不渲染不编造——bytes:null 不显示
// 大小（失败原因由 usageError 行如实带出）、usageError 不存在不出空文案、
// ended 严格 true 且 idleDays>=7 才提示（仅提示，无自动清理动作）。
test("#63：占用行如实展示接线（缺字段不编造、ended+闲置仅提示）", async () => {
  const source = await read("./AgentTeamsView.tsx");
  assert.match(source, /import \{ formatTeamActivityDate, formatTeamBytes, hasDisplayableUsage, shouldNoticeIdleTeam \} from "\.\/team-usage-display"/);
  // 先收窄 currentTeam 再判可展示性（避免 possibly-undefined 绕过）。
  assert.match(source, /\{currentTeam && hasDisplayableUsage\(currentTeam\) && \(/);
  // usageError 行有错误才渲染（无错误不出空文案）。
  assert.match(source, /\{currentTeam\.usageError && \(/);
  // bytes 是 number 才显示大小行；bytes:null 不渲染大小（不显示「未知」噪音）。
  assert.match(source, /\{typeof currentTeam\.bytes === "number" && \(/);
  // ended+闲置提示走纯函数判定（严格 true + 阈值）。
  assert.match(source, /\{shouldNoticeIdleTeam\(currentTeam\) && \(/);
  // reclaim 确认文案（TeamLifecycleActions 渲染 confirmReclaim；三语值必须写明
  // 删除清单与「保留成员会话」——防退化回笼统的「删除团队数据」）。
  const lifecycle = await read("./TeamLifecycleActions.tsx");
  assert.match(lifecycle, /teams\.lifecycle\.confirmReclaim/);
  const localePlugins = await read("../../lib/i18n/locale-plugins.ts");
  assert.match(localePlugins, /删除团队记录：计划、工单、成员邮箱与回执；成员会话记录（\.jsonl）与产物保留/);
  assert.match(localePlugins, /permanently deletes the team records: plan, tickets, member mailboxes and receipts\. Member session transcripts \(\.jsonl\) and artifacts are kept/);
});
