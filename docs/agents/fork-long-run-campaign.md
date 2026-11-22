# 长时自主「项目战役」runner（fork-long-run-campaign）

> **状态：设计（未实现）。** 本文是「自动帮我做项目、几天几夜」诉求的**第一阶段落地设计**，
> 在现有「自动修 Bug」引擎（`lib/autofix/**`）之上扩展，**不是**新造一套调度框架。
> 文中标「新增」的文件/字段尚不存在，标「复用」的均为当前已实现代码（带 file:line）。
> 实现时以代码为准；若与本文冲突，改本文，不改已验证的行为。

## 0. 目标与非目标

**目标**：一个「战役（campaign）」= 一句项目总目标 + 一份**有序、带依赖的 backlog**；
runner 逐项推进，每项自带机器判据，跨天跑、可恢复、有成本与安全闸，人在睡梦中也能推进。

**起步定位**：把 autofix 从「单任务、单验证命令、修到测试过」升级为「多项 backlog、每项自带
acceptance、跑完一项落下检查点再跑下一项」。autofix 今天已有的三块**最强资产直接复用**：
1. **引擎侧判据**：模型自称完成不算数，只有验证命令 exit 0 才算（`lib/autofix/verify.ts:26-102`；
   `lib/autofix/runner.ts:335-371`）。
2. **durable store + 接续**：`<agent dir>/autofix/tasks/<uuid>.json` 原子写、pid 认领、60s sweep
   重驱（`lib/autofix/store.ts:34-124`；`lib/autofix/runner.ts:632-738`）。
3. **Provider 中断自愈**：中断不消耗轮次、转 `waiting-provider`、退避探测
   （`lib/autofix/runner.ts:24-39,427-507`；`lib/outage/scheduler.ts`）。

**明确不做**（见 §11）：dsh 的 Source/Trigger/Eval/Mandate 事件驱动域（需先补入站鉴权，全仓
无 webhook，见 `docs/agents/fork-super-agent.md:130-133`）；跨 provider 自动换模型；进程内沙箱。

## 1. 数据模型（新增 `lib/campaign/types.ts`）

纯类型 + 纯判定，客户端可 import（不含 `node:fs`），照 `lib/autofix/types.ts:1-14` 的约定。

### 1.1 `Campaign`（落盘 v1）

```ts
type CampaignStatus =
  | "queued" | "running" | "verifying" | "waiting-provider"
  | "paused" | "succeeded" | "failed" | "stopped";

type ItemStatus =
  | "pending" | "running" | "verifying" | "done" | "failed" | "skipped";

interface Campaign {
  version: 1;
  id: string;                 // randomUUID()，文件名即 id
  objective: string;          // 项目总目标（一句话/一段）
  cwd: string;                // 战役工作目录
  status: CampaignStatus;
  items: CampaignItem[];      // 有序 backlog（顺序=默认执行序；dependsOn 再约束）
  currentItemId: string | null;
  // ── 硬闸（见 §5、§6）──
  maxTotalRounds: number;     // 全战役轮数硬顶
  maxItems: number;           // 项数硬顶（防无界）
  maxTotalCostUsd: number;    // 成本闸；必须 > 0，否则拒绝启动（§5）
  spentCostUsd: number;       // 累计（每轮结束后累加）
  totalRounds: number;
  // ── 跨天唤醒（§4）──
  intervalMs: number;         // 0 = 连续；>0 = 每段之间等待（复用 goal 的语义）
  nextRunAt?: number;
  // ── 生命期 ──
  sessionId: string | null;   // 战役主会话（每项可复用同一会话，上下文延续）
  pid: number | null;         // 驱动进程（=Next server），照 autofix 语义
  startedAt: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  lastError: string | null;
  truthFile?: string;         // P2：项目记忆/笔记文件（§7）
}

interface CampaignItem {
  id: string;                 // item-1, item-2 …（战役内稳定）
  title: string;
  instruction: string;        // 给 agent 的该项任务说明
  acceptance: string;         // 人类可读的完成判据（展示 / 裁判兜底）
  verifyCommand?: string;     // 机器判据（exit 0 = done）；P1 必填，见 §5
  dependsOn: string[];        // 前序 item id（DAG；参照 agent-teams ticket 的 blocked 口径）
  status: ItemStatus;
  round: number;              // 本项已用轮数
  maxRounds: number;          // 本项轮数上限（复用 AUTOFIX_MAX_ROUNDS=20）
  costUsd: number;
  checkpoint?: { sha?: string; patchPath?: string; at: number }; // P2（§6）
  lastError: string | null;
  rounds: CampaignRound[];    // 复用 AutofixRound 形状（`lib/autofix/types.ts:68-80`），cap 50
}
```

- `CampaignRound` 直接复用 autofix 的轮次记录形状（`round/at/status/verifyExitCode/error?/outputTail?`），
  不另造。
- 依赖判定纯函数 `availableItems(campaign)`：`status==="pending" && dependsOn 全部 done`，
  照 `lib/agent-teams-task-layout.ts:124-133` 的 blocked/available 口径。
- 硬闸纯函数 `campaignGateExceeded(campaign, nowMs)`：`totalRounds>=maxTotalRounds` 或
  `spentCostUsd>=maxTotalCostUsd` 或 `items.length>maxItems` → 返回触顶原因（照
  `lib/goal/goal-store.ts` 的 `goalGateExceeded` 写法）。
- 常量建议：`CAMPAIGN_DEFAULT_ITEM_MAX_ROUNDS = AUTOFIX_MAX_ROUNDS (=20)`、
  `CAMPAIGN_DEFAULT_MAX_ITEMS = 40`、`CAMPAIGN_MAX_TOTAL_ROUNDS = 400`（可调，但须有默认硬顶）。

**为什么 `verifyCommand` 在 P1 必填**：引擎侧判据是本引擎的立身之本（`verify.ts` 注释）。
没有机器判据的 item，只能靠模型或裁判「声称完成」，与本引擎哲学冲突；P1 一律要求每项有
可执行的 `verifyCommand`（例如 `npm test -- items/foo` 或专项脚本）。`acceptance` 仅作展示
与未来裁判兜底（复用 `lib/goal/goal-judge.ts` 的独立模型思路，P2+）。

## 2. runner 循环与终态（新增 `lib/campaign/runner.ts`；复用 `lib/autofix/verify.ts`）

驱动结构与 `lib/autofix/runner.ts:220-372` 同形，差异只在「逐项」：

```
认领（status=running, pid=process.pid，复核落盘，照 runner.ts:220-239）
for (;;) {
  重读 campaign；若 !active 返回
  过闸（§5）：触顶 → paused（成本闸）/ exhausted→failed（轮数闸）；发事件
  取 currentItem = availableItems()[0]；无 → succeeded（全 done）
  if item.status==="pending" → 置 running，写 checkpoint 前态（P2）
  跑 agent 回合（复用 runAgentTurn 等价的 prompt_done 判定，runner.ts:523-615）
    ├ aborted/attention → stopped
    ├ error 且 classifyOutageError.suspend → waiting-provider（不消耗轮次，§3）
    └ ok → verifying
  跑 verifyCommand（复用 runVerifyCommand，verify.ts:26-102）
    ├ exit 0 → item.done；P2 打 git checkpoint；currentItemId=下一项；continue
    └ 非 0 → 喂输出尾回下一轮；item.round++；
             item.round>=maxRounds → item.failed → campaign.failed（除非 continueOnItemFailure，P1 不做）
  每轮累计 spentCostUsd（§5）与 totalRounds；写盘 + 事件
}
```

**终态**：`succeeded`（所有 item done）、`failed`（某项耗尽轮次或不可恢复错误）、`stopped`（用户
Stop / abort）、`paused`（成本闸 / 跨天间隔到点后主动让出 / 用户暂停）、`waiting-provider`（上游中断，
归 outage 接续）。终态与活跃态判定沿用 `isActiveAutofixStatus` 的思路（`lib/autofix/types.ts:133-146`）。

**并发**：P1 与 autofix 一致，**同一时刻只驱动一个战役、一项**（多任务/多项同 cwd 会抢端口/抢测试
文件，见 `runner.ts:69-70` 注释）。真正的多 worker 留给 P4（§9）。

**「从第 K 项续跑」**：resume 不从头。`resumeCampaign` 重置 `currentItemId` 为第一个非 `done`
的 available item，`totalRounds` 保留（不白送预算），并把 `buildRecoveryNote()`
（`lib/keepalive/resume.ts:175-188`）注入首轮 prompt，让模型先 `git log`/`git status` 核对实际状态。

## 3. Provider 中断（复用 `lib/outage/**`，照 autofix 接线）

中断**不判失败、不消耗轮次**：`classifyOutageError().suspend` 时把状态转 `waiting-provider`、
在战役会话上落一条 `scope` 为战役类别（如 `"campaign"`）的 outage 记录，退避/死线/两段探测由
`lib/outage/scheduler.ts` 承担。战役 sweep 见到 `waiting-provider` 时先查 outage 记录
（`isOutageDue`/`isOutageExpired`），与本文件 `lib/autofix/runner.ts:642-664` 的处理逐字对齐。
通用 outage 调度器**不得**自行续跑 campaign 会话（避免双驱动）——照 `scheduler.ts:121-122`
对 `scope==="autofix"` 的跳过写法，新增 `scope==="campaign"` 的跳过分支。

## 4. 跨天唤醒（复用 goal/scheduled，不新造 timer 语义）

- **连续推进**（`intervalMs===0`）：与 autofix 相同，靠进程级 sweep 重驱孤儿
  （`lib/autofix/runner.ts:720-738`，挂在 `instrumentation-node.ts:30`）。
- **按段等待**（`intervalMs>0`，例如每段跑完歇 30m/1d 再跑下一项）：读写 `nextRunAt`，语义直接
  复用 goal 的 `computeNextRunAt` / `goalRepeatDue` / 7 天上限（`lib/goal/goal-interval.ts:86-124`）。
  到点由进程级 tick 向战役会话投一条「continue campaign」提示（照
  `lib/goal/goal-repeat.ts:56-121` 的 `runGoalRepeatTick`，独立 `startCampaignRepeatLoop`，
  挂 `instrumentation-node.ts`，受 `PI_WEB_DISABLE_SCHEDULER=1` 静默）。
- **每日定时启动/推进**：也可由现有 Scheduled 任务（`lib/scheduled-tasks/**`，含 catch-up 与 lease）
  建一个 campaign 或在固定时间投递推进提示；不做第二套 cron。

**防双驱动**（本仓踩过多次）：与 goal 同口径——「跑完立刻续」由 runner 自己负责；「到点续」由
repeat tick 在投递前先把 `nextRunAt` 推到下一档（`goal-repeat.ts:84-92`），两边只留一个驱动者。

## 5. 成本闸（新增 `lib/campaign/gate.ts`）

**这是当前最大的缺口**：全仓只有 usage **统计**（`lib/usage-breakdown.ts` 的
`getUsageCostBreakdown`），没有任何强制闸；goal 的 `budget` 字段只落不下闸
（`lib/goal/goal-types.ts:22-23`）。campaign 必须补上：

- **启动前置**：创建路由**拒绝**没有 `maxTotalCostUsd>0` 的 campaign（与 autofix 现无成本闸形成
  对比）。这是硬要求——无人值守跨天必须有人给的钱袋子。
- **运行中**：每轮结束从战役会话的 usage 累计 `spentCostUsd`（`getUsageCostBreakdown` /
  session usage），超 `maxTotalCostUsd` → `paused` + Needs You 通知（§8），**不静默继续烧钱**。
- **默认值**：建议默认 `maxTotalCostUsd` 由创建 UI 必填（无默认），避免用户无感开跑。

## 6. 安全闸（新增 `lib/campaign/gate.ts` + 路由校验）

与 autofix 的**现状差异**（必须收紧，见差距 #8）：autofix 修复会话以 `skipToolApproval:true`
运行（`lib/autofix/runner.ts:778-790`），无人值守 shell 全开、无沙箱。campaign 改为：

- **强制 git 仓**：创建时 `git rev-parse --is-inside-work-tree` 必须成功，否则拒绝；非 git 目录
  不许跑（否则无从 checkpoint、无从回滚）。
- **最低审批档**：campaign 会话**不**跳过审批；要求全局命令审批档至少为 `dangerous`
  （`lib/tool-approval/policy.ts:12-15,381-396` 的 `requiresApproval`），危险命令命中
  `DANGEROUS_RULES`（`policy.ts:263-342`）时仍要求确认；无人值守时由 120s 安全默认兜底
  （`lib/autopilot.ts:113-127`，取 cancel/否）。
- **worktree 隔离（建议）**：campaign 在独立 git worktree 内跑（复用 `lib/worktree.ts`），
  与用户主工作区隔离，破坏性改动不污染主分支。
- **硬顶**：`maxItems` + `maxTotalRounds` 纯判定（§1.1），触顶即 `failed`，绝不无界循环。
- **checkpoint**：每项 done 后 `git commit`（或落 patch 到 `campaign/<id>/checkpoints/`），
  item.checkpoint 记录 sha/patch 路径；resume 依赖它判断「第 K 项是否真做完」。

## 7. 记忆与上下文（P2+，`truthFile`）

- 会话级压缩已有（`lib/compaction-*`、`rpc-manager-compaction*`），跨天不会无限爆上下文。
- **项目记忆文件**（P2）：`<cwd>/.campaign/NOTES.md`（或 `campaign.truthFile`），每项完成时由
  runner 追加一段「做了什么/关键决策/坑」，下一项开工时注入 prompt。这是「几夜之间不失忆」的关键；
  P1 先落字段占位，记忆写入放 P2。

## 8. 可观测性（日摘要 + Needs You）

- **进度**：`items[]` 的 done/total、`totalRounds/maxTotalRounds`、`spentCostUsd/maxTotalCostUsd`
  投影成进度条（新增 `components/CampaignView.tsx`，照 `components/AutofixView.tsx` 形状）。
- **日摘要**：每天（或每段结束）写 `campaign/<id>/digest-YYYYMMDD.md`：完成项、轮数、花费、
  失败原因尾部。「我睡着时它做了什么」用它回答，而不是翻会话。
- **Needs You**：`paused`（成本/用户暂停）、`failed` 进现有收件箱
  （`lib/attention-types.ts` 的 `awaiting` 列表），手机上可看到并决定继续/停止。

## 9. 多 worker（P4，复用 agent-teams）

P1–P3 单会话逐项推进即可覆盖大多数「单线程也能干」的项目。当单项足够大需要并行时：campaign
的一项可 spawn 一个 **agent-teams** 团队（lead+workers，上限 12/32，`docs/agent-teams-design.md:885-899`），
由 lead 拆更细的 ticket 并行；`accepted.jsonl`（`lib/agent-teams-swimlane.ts:14-15`）的验收记录
回流映射为 item 完成。**注意**：team tickets 随团队销毁（`agent-teams-swimlane.ts:14-15`），
所以真相源永远是 **campaign 文件**，team 只是阶段内临时执行器。

## 10. 分阶段落地（P1 → P4）

| 阶段 | 内容 | 落点（新增除注明外） | 验证 |
|---|---|---|---|
| **P1** | Campaign/CampaignItem 类型、有序 backlog、逐项 verify、成本闸前置、git 校验、store、sweep 续跑、最简 UI | `lib/campaign/{types,store,runner,prompt,gate}.ts`；`app/api/campaigns/route.ts` + `[id]/route.ts`；`components/CampaignView.tsx`；i18n 进 `lib/i18n/locale-plugins.ts` | 纯 reducer 单测（availableItems/gate/resume 选 K）；store 原子写测试；路由校验（拒无成本闸/非 git）；runner 注入假会话+假 verify；真仓跑 2 项手动验收 |
| **P2** | 跨天间隔唤醒、每项 git checkpoint、记忆文件、恢复读 `git log` | `lib/campaign/repeat.ts`；`instrumentation-node.ts` 接线；checkpoint 用 `lib/worktree.ts` | kill 进程→重启从第 K 项续而非第 0 项；间隔到点自动推进 |
| **P3** | 成本运行中闸 + Needs You 日摘要 + 审批可开 | `gate.ts` 扩 spent 累计；`components/CampaignView.tsx`；`TasksView` | 超预算自动 pause 且进收件箱 |
| **P4** | 单项 spawn agent-teams、accepted 回流 | `lib/pi-team-host.ts` 接 campaign→team 桥 | 真 3-worker 跑通 |
| P5（可选） | 事件触发（webhook/CI），**仅在前置入站鉴权后** | — | — |

**明确「不做」**：P1 不做 teams、不做成本运行中闸（只做前置必填）、不做记忆文件、不做事件触发。

## 11. 明确不做（避免重复讨论）

- **不做** dsh Source/Trigger/Eval/Mandate 事件域模型：需先补入站鉴权（webhook 签名 + 幂等 +
  来源白名单，全仓未做，`docs/agents/fork-super-agent.md:130-133`）；「夜以继日」用周期 campaign
  tick 已够。
- **不做**跨 provider 自动换模型（改变行为、与用户显式选择冲突，见 `docs/agents/fork-provider-outage-resume.md` 的「明确不做」§9）。
- **不做**进程内沙箱（依赖 OS/worktree 隔离）。
- **不做**第二套 cron（复用 `lib/scheduled-tasks/**`）。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 失控成本 | `maxTotalCostUsd` 创建必填；运行中累计超限即 pause（§5） |
| 破坏性改动（`rm -rf`/覆盖主分支） | 强制 git 仓；建议独立 worktree；每项 checkpoint；审批档 ≥ dangerous |
| 无界循环 | `maxItems` + `maxTotalRounds` 硬顶；单项 20 轮封顶（复用） |
| Provider 长中断 | outage 接续：不消耗轮次、<40 次/6h 封顶（已实现） |
| 双驱动（sweep vs repeat vs outage） | 同 goal 口径：先推 `nextRunAt` 再投递；outage 跳过 campaign scope（§3、§4） |
| 重启丢进度 | durable store（§1.2）+ sprint 认领 pid + sweep（复用 autofix） |
| 无人值守安全默认 | autopilot 默认开、阻塞对话框 120s 取 cancel（`lib/autopilot.ts:113-127`） |

## 13. 测试计划

| 层 | 用例 |
|---|---|
| types/reducer | `availableItems` 拓扑与 blocked；`campaignGateExceeded` 三种触顶；resume 选第 K 个非 done 项；item round 封顶 |
| store | 原子写（tmp+rename）；坏 JSON 降级；UUID 校验；上限裁剪（照 `lib/autofix/store.test.mjs`） |
| 路由 | 拒 `maxTotalCostUsd<=0`；拒非 git cwd；`maxItems/maxTotalRounds` 越界拒绝 |
| runner（注入） | 假会话 + 假 verify：逐项推进、失败喂尾、outage 不计轮次、成本累计 pause、abort→stopped |
| 恢复 | 写盘→新进程扫描→从第 K 项续，注入 recovery note |
| e2e（手动） | 真 git 仓、2–3 项、其中一项故意先红后绿，观察跨重启续跑与日摘要 |

均用 `node --test`（本仓禁 `npm test`），临时 `PI_CODING_AGENT_DIR`，绝不碰真实 `~/.pi/agent`。

## 14. 文件级落点小结

- **新增**：`lib/campaign/{types,store,runner,prompt,gate,repeat}.ts`、
  `app/api/campaigns/route.ts`、`app/api/campaigns/[id]/route.ts`、
  `components/CampaignView.tsx`、`components/CampaignSidebarRow.tsx`。
- **复用（不改或最小改）**：`lib/autofix/verify.ts`（`runVerifyCommand`）、
  `lib/autofix/types.ts`（`AutofixRound` 形状与常量）、`lib/outage/**`、
  `lib/keepalive/resume.ts`（`buildRecoveryNote`）、`lib/goal/goal-interval.ts`（间隔/7 天）、
  `lib/tool-approval/policy.ts`（审批档）、`lib/autopilot.ts`（对话框超时）、
  `lib/worktree.ts`（隔离/checkpoint）、`lib/usage-breakdown.ts`（成本）。
- **接线改动**：`instrumentation-node.ts`（startCampaignSweep/Repeat，受 `PI_WEB_DISABLE_SCHEDULER=1`）、
  `lib/i18n/locale-plugins.ts`（`campaign.*` 三语）、`components/AppShell.tsx`（覆盖视图）。
