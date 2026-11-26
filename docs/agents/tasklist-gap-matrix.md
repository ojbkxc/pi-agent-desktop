# 智能体团队 · 共享任务列表：差距矩阵 / 路线图 / 可落地 diff

> 角色：T3（gap-optimizer）。基准：cc-haha `E:/cc-haha-main/cc-haha-main`（zip 快照，v0.7.9 开发周期中段）
> vs pi-agent-desktop `D:/GitHub/pi-agent-desktop`（HEAD `01fec7c6`）。行号按本次实读核对。

---

## 0. 前置声明：两份上游报告并未落盘（影响 T4）

团队计划里 T1（cc-haha 参考架构）与 T2（pi-agent-desktop 现状）的产出**没有落盘**：

- 两个成员会话（`01a210a8-adb7…` = cc-haha-analyst、`01a210a8-b99a…` = pi-teams-auditor）都停在
  `toolResult` 之后，**没有 assistant 收尾消息、没有 report 文件、没有 team_message 回报**，状态是 `parked`。
- 磁盘上唯一成文的对比材料是 `docs/cc-haha-vs-pi-agent-desktop.md`，但它是**全功能面对比**（会话/终端/IM/Computer Use…），
  对「共享任务列表」只有一行「形态趋同」，**不含任务列表维度的任何结论**。

因此本文的 T1/T2 证据是**我自己重新采集**的（两侧源码实读 + 行号锚点，见每行「证据」列）。
**给 T4 的提醒**：核验本文时不要去找两份「上游报告」对账——不存在；请直接按 §6 的证据锚点回源码复核。

## 0.1 并发风险（必须先看）

本次作业期间，`D:/GitHub/pi-agent-desktop` 工作区**正被另一个会话并发编辑**（不是本团队成员：四个成员此刻全 `parked`）。
已观察到它在同一批文件上改动：

| 文件 | 并发改动内容 |
|---|---|
| `app/api/teams/[team]/workbench/route.ts` | 新增 `?since=<contentHash>` 条件请求，命中回 304 |
| `lib/agent-teams-swimlane.ts` | 新增 `contentHash` 字段 + `deriveSnapshotContentHash()` |
| `hooks/useTeamTimeline.ts` / `.test.mjs` | 按 `contentHash` 去重快照帧 |
| `lib/streaming-message.ts`、`components/StreamingRateLine.tsx`、`hooks/useAgentSession.ts` | 与本任务无关的流式速率改动 |

后果：**本文 §5 的 diff 已经和该并发改动落在同一批文件里**（它甚至在我的 `taskListRevision` 之上叠了 `contentHash`，
并保留了指向本文的注释）。所以：

1. 不要 `git checkout` 这两个文件去「清理」——会连带销毁对方的改动。
2. 结论层面 `contentHash` 与 `taskListRevision` 是**互补**的（前者整帧、后者只哈希 tickets），两者都留。
3. 需要独立复现我的改动时，用 §5 的 hunk 逐段核对，别用整文件 diff（里面混着对方的东西）。

---

## 1. 两侧模型摘要

| | cc-haha | pi-agent-desktop |
|---|---|---|
| 本质 | agent 内建的**共享任务列表**（`~/.claude/tasks/<listId>/<id>.json`），桌面/CLI 同一个 store | **pi-team 工单**（`~/.pi/agent/teams/<dir>/tickets/<id>.json`）+ **plan 任务投影**，桌面只读投影 |
| 存储 | 一任务一文件 JSON；`blocks`/`blockedBy` 双向落盘 | 一工单一份 JSON，内含 `mandates[]`/`assignments[]`/`subscribers[]`/`thread[]` |
| 写并发 | 列表锁 `.lock` + 单任务锁 + `revision` 自增 | **仅单票文件锁**（proper-lockfile） |
| 生命周期 | `generation` / `deleted` / `terminal frame`（删除后排队写者失效） | **无** |
| 领取 | `claimTask()`：原子抢占（owner/依赖/agent_busy 三查 + 可选 markInProgress） | **无 claim**，只有 lead 侧 `assign` |
| 面向 agent 的工具 | `TaskCreate/TaskList/TaskGet/TaskUpdate`（`alwaysLoad`，`isTodoV2Enabled()` 门控） | `team_ticket`（11 个 operation，成员可用） |
| UI | `TaskListV2.tsx`（Ink 文本任务列表：owner、openBlockers、activity） | `TaskBoardCanvas.tsx`（Web DAG 画布：分层泳道、依赖曲线、五态配色、环告警） |

**一句话**：cc-haha 强在**并发正确性与「抢占式自组织」**；pi 强在**授权可追溯、多派活、讨论/回执、DAG 可视化**。
两边不是同一套语义，pi 的缺口集中在「运行期可变的任务图」与「成员自主取活」。

---

## 2. 差距矩阵

差距性质：**缺失**（对面有、这边没有）｜**弱化**（有但保障更弱）｜**口径错**（行为与宣称不符）｜**等价**｜**pi 更强**

| # | 维度 | cc-haha | pi-agent-desktop | 差距 | 影响 | 证据 |
|---|---|---|---|---|---|---|
| G1 | 领取（claim） | `claimTask()` 原子抢占：`already_claimed`/`already_resolved`/`blocked`/`agent_busy` 四种拒绝原因，可 `markInProgress` | `team_ticket` 的 operation 只有 `create/list/show/mandate/assign/progress/end/subscribe/post/ack/unacked`，**无 claim** | **缺失** | 成员无法自取任务；并行成员不能靠共享列表自组织，必须 lead 逐个 `assign` | `src/utils/tasks.ts:1157-1240`；`teamTickets.js` 导出面 |
| G2 | 跨票写原子性 | 列表锁 `.lock` + 单任务锁；`blockTask` 把 `blocks`/`blockedBy` 两端边放在**同一事务**里 | 只有单票文件锁，**无列表级锁** | **弱化** | 「抢占 + 忙检查」「依赖双写」这类跨票不变量无法原子，只能靠上层 `expectedUpdatedAt` 事后兜 | `tasks.ts:539-660`；`teamTickets.js` `withTicketLock` |
| G3 | 写侧乐观并发 | `revision` 单调自增 + 快照带 `capturedAt`/`revision`，能排先后 | `plan.json` 有 `expectedRevision`（不匹配即 409）；**tickets 无任何 revision** | **弱化** | 工单是纯读-改-写，无「期望版本」校验；两个 lead 并发改同一票会静默覆盖 | `lib/agent-teams-plan-write.ts`（有）；`teamTickets.js`（无） |
| G4 | 运行期依赖边 | `blocks`/`blockedBy` 是任务本体字段，运行中随时可加 | 依赖**只来自 plan.json**；runtime 票恒 `dependencies: []` | **缺失** | 运行中新建的票进不了 DAG：画布无连线、`blocked` 永不成立、也不会被「依赖完成」解锁 | `lib/agent-teams-swimlane.ts:678`；`docs/agent-teams-design.md` §7.1 |
| G5 | 依赖环 | 未做环检测 | Tarjan SCC（迭代式，深链不爆栈）+ 画布环告警 | **pi 更强** | cc 侧遇环只能等超时/人工发现 | `lib/agent-teams-task-layout.ts:162-267` |
| G6 | 任务 ID | 高水位标记 + 目录扫描，删除后不复用 | `ticket-<uuid>` | **pi 更强**（天然不复用） | — | `tasks.ts:341-390` |
| G7 | 任务列表生命周期 | `generation`/`deleted`/`terminal frame`：列表删除后**排队写者失效**，不会复活 | **无**；`writeTicket` 无条件 `mkdir -p` | **缺失** | 团队删除后一条迟到的 `team_ticket` 写会把 `tickets/` 目录重建出来 → 幽灵票/幽灵团队 | `tasks.ts:920-1130`；`teamTickets.js` `writeTicket` |
| G8 | 快照因果可辨 | `readTaskListSnapshot()` 持列表锁读全量 + `capturedAt` + `revision` | 只读投影，`generatedAt` 每轮变；本次新增 `taskListRevision` + `contentHash` | **已补（部分）** | 原口径下 `version` 恒 1、`generatedAt` 每轮变 → 客户端去重条件永不成立（「60 帧同一张图」） | 本文 §5 D1；`hooks/useTeamTimeline.ts:43-64` |
| G9 | 自动取活 | `useTaskListWatcher`：`fs.watch` + 1s 去抖 + `claimTask` + 提交失败释放 claim | **无** | **缺失** | 成员只被动等派活/唤醒；空转成本高 | `src/hooks/useTaskListWatcher.ts` |
| G10 | plan → 任务落地 | launch 时**materialize**：`createTask()`，并把 plan task id → task id 建映射 | **读时投影派生**（`source: "plan"`），不落盘 | **形态不同** | pi 的「计划任务」没有独立生命周期，plan 一改票就变；好处是不会出现「计划与任务两份真相」 | `teamPlanRuntime.ts:246`；`swimlane.ts:600-640` |
| G11 | 「可认领」口径 | 无此概念（任务要么有 owner 要么没有） | 四态 `available` 同时覆盖「无人认领」与**「已派活但没开工」** | **口径错** | 画布与统计把已派出去的票显示成「可认领」，而成员侧根本没有 claim 工具 → 假承诺 | `agent-teams-task-layout.ts:124-142`；`TaskBoardCanvas.tsx:27` 自述 |
| G12 | 讨论 / 订阅 / 已读回执 | 无（消息走邮箱） | `ticket.thread` + `subscribers` + `acks/receipts.jsonl` | **pi 更强** | — | `teamTickets.js` `postToThread`/`recordAck` |
| G13 | 授权不可变 | 无 | `Mandate` 不可变，改主意只能新建 + `revokes` | **pi 更强** | — | `teamTickets.js` `addMandate` |
| G14 | 派活幂等 | 无 `clientRequestId` | `dispatchAssignment`：`clientRequestId` sidecar + `expectedUpdatedAt` 代际，重试不重发 | **pi 更强** | — | `lib/agent-teams-assignments.ts:251-330` |
| G15 | 停滞检测 | 无 | `ticketStalled()`：票未结束、挂着 running 派活、但成员已 failed/parked/aborted | **pi 更强** | — | `lib/agent-teams-task-progress.ts` |
| G16 | 依赖缺失的处置 | 过滤为「已解除」（fail-open） | 同 fail-open（缺失依赖不建边） | **等价（共同缺陷）** | 依赖 id 写错时任务被误放行，两端都不会报 | `tasks.ts` `TaskListTool.call`；`agent-teams-dependency-focus.ts:41` |

**结论排序**（按「会让人误判成功 > 功能不可用 > 口径」）：

1. **G11 口径错** —— 界面在承诺一个不存在的动作（可认领）。
2. **G7 缺失** —— 删团队后幽灵复活，属于「以为删干净了」。
3. **G4 缺失** —— 运行期任务图断链，「等依赖」形同虚设。
4. **G1 + G2 + G9** —— 自组织能力的整块缺口（三者同源：没有原子 claim 就没有自动取活）。
5. **G3** —— 写侧无版本校验，属并发数据风险。
6. **G16** —— 两端共同缺陷，值得单独定口径。

---

## 3. 优化路线图

排序原则：先修「说错话」（口径），再补「会骗人」（幽灵/断链），最后才做「能力扩张」（claim/自动取活）。
**归属仓库**一栏决定这件事能不能由桌面侧单独发布。

### P0 · 桌面侧可独立发布（零上游依赖）

| 项 | 动作 | 对应 | 价值 | 成本 | 状态 |
|---|---|---|---|---|---|
| R1 | `available` 口径拆开：把「已派未开工」从「可认领」里拿出来 | G11 | 高（消除假承诺） | 低 | **待做**，见 §4 方案 A/B |
| R2 | 快照内容指纹 + 去重 + `?since=` 304 | G8 | 中高（轮询抖动/重渲染） | 低 | **已完成**（本次 D1 + 并发会话的 `contentHash`） |
| R3 | 同 id 合并不得用空 `assignments` 抹掉计划口径 | G4 邻域 | 中（防「running 跳回可认领」） | 极低 | **已完成**（本次 D3） |
| R4 | 依赖缺失与「已解除」分离：拼错的依赖 id 应报出来，而不是静默放行 | G16 | 中 | 低 | **已完成**：`findDanglingDependencies()` + 画布横幅显式告警，**fail-open 语义未变**（背后不设 fail-closed）。触发面要如实记：plan 的两条写入口（上游 `validateTeamPlanGraph`、桌面 `applyTeamPlanEdits`）都会拒绝未知依赖，所以正常路径产生不出悬空边——这个告警兜的是**手改 plan.json、旧版本写入、第三方直接编辑**这三类带外输入 |

### P1 · 需要 pi-team 上游改动（桌面侧无法单独根治）

| 项 | 动作 | 对应 | 依赖 | 风险 |
|---|---|---|---|---|
| U1 | `ticket` 加 `dependsOn: string[]`（schema v2），写入时维护双向边 + **拒绝成环** | G4 | 无 | schema 1→2 需读写兼容；老桌面读新票要能降级 |
| U2 | 新增 `team_ticket` 的 `claim` operation：依赖全完成 + 无冲突 assignment + 成员不忙，**全部在列表锁内** | G1 | U3（要列表锁） | 双消费风险，必须复用邮箱 identity-claim 口径 |
| U3 | `tickets/` 加列表级锁与 `revision` 文件；写操作支持 `expectedRevision` | G2/G3 | 无 | 与 `config.json`/`plan.json` 的锁层级要定序，避免锁序反转死锁 |
| U4 | 任务列表生命周期（`generation`/`deleted`/`terminal frame`），删除后失效排队写者 | G7 | 无 | 与「目录即真相」假设冲突（见 `agent-teams-upstream-defects.md` B2），需先定口径 |

### P2 · 体验与自动化（依赖 P1）

| 项 | 动作 | 对应 | 依赖 |
|---|---|---|---|
| U5 | 成员侧自动取活（对齐 `useTaskListWatcher`：watch → claim → 失败释放） | G9 | U2 |
| U6 | 停滞自动改派：`ticketStalled` 命中时触发 `reassign`（现成能力，缺触发） | G15 | 无（可提前） |
| U7 | UI 接 `?since=` 304 与 `contentHash` 去重（服务端已就绪） | G8 | R2 |

### 明确不建议做

- **照搬 cc-haha 的 `revision` 语义到桌面侧**：桌面是只读投影，没有写侧计数器，硬造单调号只会得到「假版本号」。
  内容指纹（R2）在只读投影下是正确抽象；要真版本号必须等 U3。
- **在桌面侧自造任务列表生命周期**（绕过 pi-team 写一份 `deleted` 标记）：会与 pi-team「目录即真相」打架，
  等于造第二份真相。归 U4。
- **把 `available` 直接改成 fail-closed 依赖判定**：依赖 id 拼错会永久锁死整条链。

---

## 4. R1 的两个方案（需产品口径确认）

| | 方案 A：加第 6 态 `assigned` | 方案 B：不动枚举，只收紧口径 |
|---|---|---|
| 做法 | `TicketUrgency` 增加 `assigned`；`URGENCY_ORDER`/`WEIGHT`/`taskToneClass`/`countTaskStates`/CSS/3 处 i18n 同步 | `getTicketUrgency` 保持五态；新增 `isAwaitingStart(ticket)`，画布与统计在 `available` 上区分「无人认领 / 已派未开工」 |
| 影响面 | 5 个 TS 文件 + `app/native-theme.css` 2 处 + `lib/i18n/locale-plugins.ts` 3 处 + 2 个测试 | 1 个 TS 文件 + 画布文案 + 1 个测试 |
| 风险 | **与并发会话冲突**：`lib/i18n/locale-plugins.ts` 此刻正被对方改动 | 低（避开 i18n） |
| 建议 | 作为后续正式态 | **先上 B**；等并发改动落定后再评估 A |

---

## 5. 可落地 diff

### D1 · `taskListRevision`：任务列表的派生内容版本（已落地、已通过测试）

目标：让快照能回答「任务列表变没变」，供轮询去重、回放对账、UI 跳过无变化重渲染。

`lib/agent-teams-swimlane.ts`

```diff
 export interface TeamWorkbenchSnapshot {
   version: 1;
   generatedAt: string;
   team: WorkbenchTeam;
   members: WorkbenchMember[];
   tickets: WorkbenchTicket[];
   lanes: WorkbenchLane[];
   flows: WorkbenchFlow[];
   taskAnchors: WorkbenchTaskAnchor[];
   /** lane-diagram.html 直接消费的兼容数组（由 tickets 投影）。 */
   tasks: WorkbenchTask[];
   /** acks/receipts.jsonl 的已读回执（新增字段，不影响既有字段语义）。 */
   receipts: WorkbenchReceipt[];
   messages: WorkbenchMessage[];
   /** messages 是否因超过上限被截断（截断后 messages 只剩最新的一段）。 */
   messagesTruncated: boolean;
+  /**
+   * 任务列表的**派生内容版本**（对 tickets 的稳定序列化做哈希）。
+   *
+   * 与 cc-haha `readTaskListSnapshot()` 的 `revision` 不是一回事：那边是**写侧单调计数器**
+   * （`bumpTaskListRevisionLocked`），内容没变也可能因别的票被改而 +1，所以能排出先后；
+   * 这里只读到落盘文件的只读投影，没有写侧计数器，只能用内容哈希 —— 它只回答
+   * 「任务列表变没变」，回答不了「变了几次」。轮询去重、回放对账、UI 跳过无变化的重渲染
+   * 都够用；要真版本号需 pi-team 在 `tickets/` 下补一个 revision 文件
+   * （见 docs/agents/tasklist-gap-matrix.md G8）。
+   */
+  taskListRevision: string;
 }
+
+/**
+ * 由 tickets 算出 `taskListRevision`（纯函数，客户端可安全调用）。
+ *
+ * 只纳入**会影响画布/统计**的字段：id / status / ownerId / dependencies / 每条 assignment 的
+ * id·status·outcome。subject、description、thread、mandates 一律不参与 —— leader 改文案不该
+ * 触发全量重渲染。序列化前先把票和 assignment 按 id 排序，落盘顺序变了不算内容变化。
+ *
+ * 双 32 位 FNV-1a 累加（target 是 ES2017，不能用 BigInt 字面量）：64 位抗碰撞对
+ * 「几百张票的变更检测」绰绰有余，而快照体积只多 16 个 hex 字符。
+ */
+export function deriveTaskListRevision(
+  tickets: readonly WorkbenchTicket[],
+): string {
+  const byId = (left: { id: string }, right: { id: string }): number =>
+    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
+  const canonical = [...tickets]
+    .sort(byId)
+    .map((ticket) => {
+      const assignments = [...ticket.assignments]
+        .sort(byId)
+        .map((assignment) => `${assignment.id}:${assignment.status}:${assignment.outcome ?? ""}`)
+        .join("|");
+      return [
+        ticket.id,
+        ticket.status,
+        ticket.ownerId ?? "",
+        ticket.dependencies.join(","),
+        assignments,
+      ].join("\u001f");
+    })
+    .join("\u001e");
+  let forward = 0x811c9dc5;
+  let reverse = 0x85ebca6b;
+  for (let index = 0; index < canonical.length; index += 1) {
+    const code = canonical.charCodeAt(index);
+    forward = Math.imul(forward ^ code, 0x01000193) >>> 0;
+    reverse = Math.imul(reverse ^ (code + index), 0xc2b2ae35) >>> 0;
+  }
+  return `${forward.toString(16).padStart(8, "0")}${reverse.toString(16).padStart(8, "0")}`;
+}
```

```diff
   return {
     version: 1,
     generatedAt,
+    taskListRevision: deriveTaskListRevision(tickets),
     team: {
```

> 现状说明：该字段随后被并发会话包进了 `contentHash`（整帧指纹，`deriveSnapshotContentHash` 会把
> `taskListRevision` 一起算进去）。两者互补，不要合并成一个是正确的 —— 只哈希 tickets 的指纹会把
> 通信流冻住（新消息到达时 tickets 没变）。

### D3 · 同 id 合并不得用空 `assignments` 抹掉计划口径（已落地、已通过测试）

pi-team `createTicket` 的 `assignees` 是可选参数，落盘可以是 `assignments: []`。
原实现无条件覆盖，会把计划票「谁在做、做到哪」整条抹掉，画布随即从 `running` 跳回「可认领」。

`lib/agent-teams-swimlane.ts`

```diff
     if (existing) {
       // 同 id：运行时的 assignments/status 覆盖派生值，其余（subject/依赖）保留计划口径。
-      existing.assignments = assignments;
+      // 但**只覆盖非空**：pi-team `createTicket` 的 assignees 是可选参数（assignments 可为 []），
+      // 无条件覆盖会把计划票「谁在做、做到哪」整条抹掉 —— 画布随即从 running 跳回可认领，
+      // 而 runtime 侧根本没提供任何替代信息。空数组视为「运行时没表态」，保留计划口径。
+      if (assignments.length > 0) existing.assignments = assignments;
       existing.status = runtime.status;
```

### 新增测试（`lib/agent-teams-swimlane.test.mjs`，4 个用例）

| 用例 | 锁住的不变量 |
|---|---|
| `taskListRevision：同输入同摘要，可重复` | 16 位 hex；同内容 ⇒ 同摘要 |
| `taskListRevision：票顺序与 assignment 顺序不影响摘要` | 落盘顺序不是内容变化 |
| `taskListRevision：状态/依赖/派活变化必须改变摘要，纯文案变化不改变` | 改 subject 不重渲染；依赖/状态变化必须可见 |
| `tickets：同 id 合并时 runtime 的 assignments 为空不得抹掉计划口径` | D3 的不变量 |

### 验证命令与实测结果

```bash
cd D:/GitHub/pi-agent-desktop
npx tsc --noEmit                                                   # 退出码 0
node --experimental-strip-types --test lib/agent-teams-swimlane.test.mjs
node --experimental-strip-types --test lib/agent-teams-task-layout.test.mjs \
  "app/api/teams/[team]/workbench-routes.test.mjs" lib/agent-teams-swimlane-store.test.mjs
node --experimental-strip-types --test "components/AgentTeams/*.test.mjs" "lib/agent-teams-*.test.mjs"
```

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（0 错误） |
| `lib/agent-teams-swimlane.test.mjs` | 37/37 通过（含新增 4 例） |
| `task-layout` + `workbench-routes` + `swimlane-store` | 30/30 通过 |
| `components/AgentTeams/*` + `lib/agent-teams-*` | 724/724 通过 |
| 与并发会话合并后复跑（swimlane + workbench-routes + useTeamTimeline） | 64/64 通过，tsc 仍 0 |

---

## 6. 需要 pi-team 侧改动的契约缺口（不伪造补丁）

pi-team 只以编译产物 `node_modules/pi-team/dist/*.js` 存在于本仓库，**没有 TS 源**。
所以这里给**规格**而不是 diff —— 硬编一份「补丁」会让人误以为可直接 apply。

### U1 · `ticket.dependsOn`（对齐 G4）

- `ticketSchema` 加 `dependsOn: z.array(z.string()).default([])`，`schemaVersion` 升 2；
- 读：`schemaVersion === 1` 视为 `dependsOn: []`（向后兼容）；
- 写：`addDependency(teamName, fromId, toId)` 在**列表锁**内同时写 `from.dependsOn += toId` 与
  `to.dependents += fromId`（双向边，照 cc-haha `blockTask` 的事务边界）；
- 成环时抛 `TeamTicketError(400)`，判据用迭代式 SCC（桌面侧 `agent-teams-task-layout.ts:162` 已有实现可移植）；
- 语义定死：`dependsOn` 指向的票 **ended 才算完成**（对应 `getTeamTaskState` 的 `dependency.status !== "ended"`）。

### U2 · `team_ticket` 的 `claim` operation（对齐 G1）

```
claim(ticketId, assignee) -> { ok, reason? , ticket? }
reason ∈ task_not_found | already_claimed | already_ended | blocked | agent_busy
```

- 必须在 `tickets/` 的**列表锁**内完成：依赖完成检查 + 冲突 assignment 检查 + 成员忙检查 + 写 assignment；
- `agent_busy` 判据复用邮箱的 identity-based claim 口径（`claimMailboxMessages`），避免两套「谁在忙」；
- 幂等：同一 `(ticketId, assignee)` 重复 claim 返回既有 assignment，不新建。

### U3 · `tickets/` 列表级锁 + revision（对齐 G2/G3）

- `tickets/.lock`（列表锁）+ `tickets/.revision`（单调计数），写操作 `bump`；
- 所有 `team_ticket` 写 operation 接受 `expectedRevision?`，不匹配 → `409`；
- **锁序**必须全局一致（列表锁 → 票锁），否则与 `config.json.lock`/`plan.json.lock` 会死锁 —— 这是本项最大风险。

### U4 · 任务列表生命周期（对齐 G7）

- `tickets/.lifecycle.json`：`{ generation, deleted, terminals: [{ frameId, generation, identity, tickets, capturedAt, revision }] }`；
- `team_delete` 先写 `deleted: true` + 终局帧，再删目录；
- 所有写操作在 `deleted` 时抛错而不是 `mkdir -p` 重建（当前 `writeTicket` 无条件 `mkdir`，这是幽灵复活的直接原因）。

---

## 7. 给 T4（verifier）的核验清单

1. **不要找 T1/T2 报告**（见 §0）——按本文件每行的「证据」列回源码复核。
2. 复核 §5 的四条测试断言是否真的在测「口径」而不是「实现细节」：尤其
   「改 subject 不改变摘要」与「依赖变化必须改变摘要」这两条互为反向断言，缺一条就测不出误报/漏报。
3. 复核 §5 的实测数字（37/37、30/30、724/724、tsc 0）——注意**当前工作区混有并发会话的改动**，
   数字会随对方继续编辑而变化；复跑前先 `git status --short` 看清现场。
4. 未覆盖风险（本文承认的测试边界）：
   - 全部是单测/路由测，**无 e2e**：`?since=` 304 与画布重渲染没有端到端验证；
   - `deriveTaskListRevision` 的碰撞率只有理论论证（64 位 FNV），无实测；
   - G7（幽灵复活）**未做任何验证**，只是源码推断，建议单独写一个复现（删团队 → 迟到 `team_ticket` → 看 `tickets/` 是否重建）。
5. 建议 T4 额外核一条事实：`app/api/teams/[team]/workbench/route.ts` 读的 `snapshot.contentHash`
   与 `lib/agent-teams-swimlane.ts` 产出的字段是否始终同步（并发会话正在改这条链，最容易漏）。
