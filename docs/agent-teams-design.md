# pi-agent-desktop Agent Teams 设计文档

> 状态：调研完成，待实现评审
> 日期：2026-11-04
> 目标：把 D:\GitHub\pi-agent-desktop（ojbkxc fork，已同步上游 main）改造成「agent teams 比 PI-Desktop 和 cc-haha 都好用」的桌面端。本文是实现工程师的直接施工依据。

---

## 0. 摘要与核心结论

**一句话**：在 pi-agent-desktop 现有 in-process subagent runtime（`lib/subagent-runtime.ts`）之上，移植 pi-team 的文件层团队模型，叠加 DeepSeek dsh-superagent 的 Ticket/Mandate/Assignment 三段式授权模型与「先落库后执行」的 durable pipeline，产出一套「durable worker session + 生命周期工具 + 邮箱投递 + 泳道可视化」的 agent teams 能力。

**关键设计决策**：

1. **复用 subagent runtime 的 spawn 原语，不另起炉灶**。pi-agent-desktop 已有 `SessionManager.create(parent.cwd, undefined, { parentSession })` + `createAgentSessionFromServices` + `registerSession` + `appendCustomEntry` 的完整 durable session 创建链（`lib/subagent-runtime.ts:284-326`）。agent teams 的 spawn 直接复用这条链，只在外层包一层「团队关系注册 + 任务投递」。
2. **工具面采用多工具而非单工具多 action**。对比 PI-Desktop 的 `SessionTask`（9 个 action 塞在一个工具里），采用 cc-haha/pi-team 的多工具风格：每个工具一个清晰 schema，LLM 更容易选对，UI 更容易映射。
3. **授权模型采用 DeepSeek 的 Mandate/Ticket/Assignment 三段式**，比 PI-Desktop 的扁平 spawn 和 cc-haha 的 team-member 都更严谨：Mandate 管「允许做什么」，Ticket 管「做什么」，Assignment 管「谁来做」。
4. **worker 间消息用 pi-team 已验证的邮箱投递**（inboxes/*.json + proper-lockfile + identity-based claim），叠加 DeepSeek 的 Subscription 扇出与 Read receipt。
5. **泳道数据模型独立于 H5 渲染**：服务端产出纯 JSON 快照，H5 只消费，不碰会话内部状态。
6. **上限策略**：建议每父会话 8 个活跃 worker、全局 32 个（对比 PI-Desktop 4/16），理由见 §8。

---

## 1. 调研对象与借鉴来源

### 1.1 PI-Desktop Session Orchestrator（ADR 0237，D391）

PI-Desktop 把多 agent 编排做成一个官方插件 `pi.session-orchestrator`，核心是 `SessionTask` 工具，9 个 action：

| action | 语义 |
|---|---|
| `spawn` | `session/create` + `agent/prompt`，创建新 durable session（不复制 transcript），继承父的 project/provider-model/thinking/permission |
| `send` | 复用已记录的 worker session，向同一 sessionId 发后续消息 |
| `supervise` | 同 send，向已记录的 worker session 发监督性后续 |
| `status` | 只读状态刷新（有界，桌面读 5s 上限） |
| `wait` | 1 秒轻量轮询，默认 25s / 上限 45s，超时返回 `timedOut`；transcript 读取推迟到 worker 不运行之后 |
| `result` | 有界 report 提取（12000 字符上限） |
| `accept` | 接受 worker 的 report |
| `cancel` | `agent/abort`，**永不删除 session** |
| `list` | 列出 worker（Agents 面板数据源） |

**上限**：每父会话 4 个活跃 worker，插件全局 16 个。worker 不能再 spawn worker。

**v1 限制（明确不做的）**：
- 无 worker 间消息（worker 只能和父通信）
- 无生命周期事件订阅，靠轮询（有界延迟）
- 无 worker 间任意 session 控制
- 不新增 MCP self-call、A2A channel、message bus、DAG

**host 侧原语**（`crates/host-core/src/session_collaboration/`，Rust + SQLite）：
- `session.collaboration.spawn` — 事务内创建 worker session + 第一条 task delivery
- `session.collaboration.send` — 幂等投递 task/message 到已存在 session
- `session.collaboration.message` / `status` / `result` / `pending` — 只读投影
- `session.collaboration.settle` — 从持久化 turn 派生结果，最多一次 completion callback
- `session.collaboration.cancel` — 取消 queued 投递或中断已绑定 turn，保留 session
- `session.collaboration.fail` — 记录投递失败，创建一次 failure callback
- Schema：`session_collaboration_links`（session_id → created_by_session_id + plugin_id）+ `session_collaboration_messages`（kind: task/message/completion，status: queued/running/completed/failed/cancelled/interrupted，remaining_hops 预算 9 跳）

**可借鉴**：durable session 的继承语义（project/provider/model/thinking/permission 四元组）、cancel 不删 session、有界 report、幂等投递、completion callback 的 receipt 语义、worker 不能 spawn worker 的安全边界。

### 1.2 cc-haha swarm（Agent Teams）

cc-haha 有完整的 Agent Teams 体系（`src/utils/swarm/`，46 个文件）：

**团队模型**（`teamHelpers.ts`）：
- `TeamFile` = config.json，含 `name/description/createdAt/leadAgentId/leadSessionId/members[]/teamAllowedPaths/hiddenPaneIds`
- 成员字段：agentId/name/agentType/model/providerId/effortLevel/planMemberId/terminated/prompt/color/planModeRequired/joinedAt/tmuxPaneId/cwd/worktreePath/sessionId/subscriptions/backendType/isActive/mode/lastError/autoRetry/awaitingDependencies
- `backendType`: tmux / iterm2 / in-process / process（desktop 成员）
- 原子写：`mutateTeamFileAsync`（proper-lockfile + rename，Windows EPERM/EACCES/EBUSY 重试）

**工具面**（4 工具）：
- `TeamCreate` — 建团队 + draft 成员
- `TeamPlan` — get/submit/update + 审批快照（approve/return/cancel/retry/end），提交后 `review_pending` 等人类审批，审批通过后 server 自动启动成员
- `TeamDelete` — 删团队
- `SendMessage` — `to: name | "*" 广播`

**邮箱投递**（`teammateMailbox.ts`）：
- `~/.claude/teams/<team>/inboxes/<agent_name>.json`（未读）+ `<agent_name>.history.jsonl`（已读，append-only）
- `writeToMailbox` / `readUnreadMessages` / `claimMailboxMessages`（identity-based claim 防双消费）/ `markMessagesAsReadByIdentity` / `clearMailbox`
- 结构化协议消息（JSON envelope，`isStructuredProtocolMessage` 路由）：`permission_request/response`、`sandbox_permission_request/response`、`shutdown_request/approved/rejected`、`team_permission_update`、`mode_set_request`、`plan_approval_request/response`、`task_assignment`、`idle_notification`
- idle notification：worker 空闲时发 `{type:"idle_notification", from, idleReason, summary, completedTaskId, completedStatus, result (capped 4000 chars)}`

**泳道可视化**（v0.5.4「Agent Teams 协作工作台」）：成员、任务、通信流与依赖泳道画布。数据源 `TeamWorkbenchSnapshot`：
```
{ version, generatedAt, taskListRevision, team: TeamDetail, tasks: TaskInfo[], messages: TeamWorkbenchMessage[] }
TeamWorkbenchMessage = { id, from, to, recipients, kind: direct/broadcast/system, text, summary, timestamp, color, taskId, protocolType }
TeamWorkbenchSessionTimeline = { sessionId, teamName, incarnationId, snapshots[], source: live/archive/transcript }
```
任务锚点 `TeamTaskAnchor` = { taskId, status, messageId, timestamp }，把成员对话按 TaskUpdate 切成「在哪个任务上工作」的片段。

**可借鉴**：团队文件 + 邮箱 + 结构化协议消息 + 审批快照 + workbench 快照 + task anchor 的泳道数据思路。

### 1.3 DeepSeek dsh-superagent / Harness（2026 调研）

DeepSeek 2026 年发布两个关键项目：
- **deepseek-harness**（271k stars）：开源 agent harness，「Everything is a Plugin」，基于 **Cordis**（arXiv 2608.25512，spatiotemporal composability 编程范式）。`npx @deepseek-ai/dsh web` 起本地 Web UI。
- **dsh-superagent-prototype**（18k stars）：proactive coding agent，packaged as bundle for Harness。监听 GitHub/Feishu，在自己的 agent session + directory 工作，回复 PR 线程，web panel 展示需人工的项。

**dsh-superagent 领域模型**（docs/001-domain.md）——这是最值得借鉴的部分：

```
Source(事件流) → Trigger(不可变事件) → Thread(按时间排序) → Eval(判断) → Mandate(授权) → Ticket(工作单元) → Assignment(执行绑定) → Executor(worker) → Channel(回复通道)
```

核心概念：
- **Source**：事件流，kind 可复用 / instance 是配置；保存读位置和 bot 身份，重启不重放
- **Trigger**：不可变事件，审计与幂等的单位；接受两次只得一个 Ticket
- **Thread**：按时间排序的 Trigger，只允许一个 Eval 在跑，持有 Subscriptions + 运行中 Eval + Decision 历史
- **Eval**：两层判断（gate + assessment），**不持有状态**；输入 Trigger 批次 + Thread 快照 + 所有 Tickets + 当前 Policy
- **Mandate**：accept 授予的东西（Policy 版本、范围、强度、匹配的规则），**不可变**；只有人的 stop 或 Policy 变化才能撤销
- **Ticket**：授权工作单元，**只有 Eval 能创建**；状态 open → ended 可往返，定义自己的状态（不跟随 Executor）；持有 Channels + Inputs + Assignments
- **Assignment**：Ticket 绑定到一个 Executor 实例，pending → running → ended，独立于 Ticket
- **Subscription**：Ticket 与 Thread 的多对多关系，由 Thread 持有；匹配的 Trigger 扇出到活着的订阅 Ticket，**不检查发送者**——后续讨论无需再 @ agent 就能到达 worker
- **Channel**：Thread 的写侧（acks/replies/PRs/reviews）

**执行模型**（docs/003-execution.md）：
- **先落库后执行**：决策持久化，再执行。「relaying、launching、delivering 都先存储后执行」
- **Report 状态**：ready/blocked/failed/waiting/dropped
- **Read receipt**：消息一旦被某步 claim 且随后有 Report 或 turn end，就算已读；未读未确认的消息在 Ticket 结束时回到 Eval
- **并发槽位**：有界并发，**留一个额外槽位给人的消息或状态请求**（防止新工作饿死人类继续对话）
- **重试**：投递 2s 后重试，延迟翻倍至 1 分钟；瞬时失败（408/429/5xx/refused/reset/timeout）3 次退避重试
- **失败挂起**：blocked/failed 时 CI 和 bot 消息记录但不投递；人的消息、后续非 blocked/failed 的 Report 或重试结束挂起
- **隔离**：每个 Ticket 一个 Executor Session（`worker-<ticket-id>`）+ 一个目录（`<stateDir>/work/<ticket short name>`）；「这些 wrapper 和目录建立默认值，**不是安全边界**」
- **worker 工具**：foreground shell 5 秒后转后台 job，让 worker 能在下一步捡新消息；worker subagent 用 `standard` preset，权限同 worker，仅在 Ticket 存活期保留；subagent 的 job 在结束时被杀
- **重启**：运行中 Assignment 结束并标 "host restarted"，新 Assignment 带恢复提示；按最老 Ticket 优先

**哲学**（docs/000-philosophy.md）：
- 注意力经济学：「以最小人类注意力，给最大价值」；每条消息/设置/面板元素必须回报大于成本，否则砍掉
- 只在被要求或团队规则允许时行动；未请求的工作从 record-only 模式开始
- 简洁发言：确认一次、说明打算做什么、工作期间沉默、只在结果就绪/需要决策/无法完成时再开口
- 按影响停止而非按努力停止
- 诚实报告：未完成标未完成，失败叫失败
- 最小概念、最小设置：一个默认值胜过一个可配置项；行为写在 prompt 里而非设置里
- 面板只展示需要人的东西

**架构**（docs/007-architecture.md）：
- 全 in-process，单 SQLite（`<stateDir>/orchestrator.sqlite`），目录锁防多进程
- Engine 单线程，所有方法同步；副作用通过 durable Effects 队列（kind: assessment/launch/delivery/relay/notice/reply）在事务内入队，commit 后执行
- Passes 每 2 秒跑一次，drain due effects 再 `Engine.evaluateDue`
- 每个状态类型一个 writer，其他只读或问 writer；`src/core` 不 import 外部（除 Node hashing）、不做 I/O
- 插件：main + github-watch + feishu-watch，通过 cordis.patch.yml 注入

**可借鉴**：Mandate/Ticket/Assignment 三段式授权、先落库后执行的 durable pipeline、Subscription 扇出、Read receipt、并发槽位留人优先、per-Ticket session+目录隔离、worker shell 转后台 job、哲学层面的最小概念/注意力经济学。

### 1.4 DeepSeek 官方 Agent Teams 插件与社区生态（2026-11 补充调研）

**官方插件**（deepseek-harness 内置，实验性质）：
- **智能体团队（Agent Teams）**：团队协作 + **共享任务板（shared task board）**
- **子智能体（sub-agents）**：把任务分配给其他 agent
- **Agent 循环（Agent Loop）**：控制 agent 的工具调用节奏
- Harness 本体 = Cordis 内核（只做插件加载/卸载/依赖）+ 能力插件（model/tools/skills/session/sandbox/storage/loop/scheduling/UI 全插件化）；`Agent = Model + Harness`；桌面版支持 macOS 13+/Windows 10+。Cordis 论文（arXiv 2608.25512）把动态组合拆成两个正交轴：**时间可组合性**（revertible effects，运行时持有逆变换）与**空间可组合性**（reactive coeffects，依赖声明 + 响应式启停），合并为 context paradigm。

**社区 dsh 团队插件生态**（GitHub，已验证各机制的可行性）：

| 项目 | Star | 角色分工 | 消息协议 | 验收/验证机制 |
|---|---|---|---|---|
| NanmiCoder/dsh-agent-teams | 2.7k | captain + durable sub-agents；14 个协调工具；DAG 任务依赖；**memberMaxDepth 默认 0（禁嵌套 spawn）**；Approve & Run 先出 roster+DAG 再调度 | 成员间**直接持久邮箱消息，无需中转**；Web 审批唤醒 captain | 可选质量门（requirements→implementation→verification→review→integration）；toolPolicies allow/deny（明示「不是 OS 沙箱」）；`.agent-teams/` 文件状态 + Web UI 读盘 |
| huxint/dsh-team | 14 | 命名持久队友（名字+会话+记忆）；主会话记账任务表；`/agent-teams <目标>` 组队 | 成员邮箱直连；**跳数上限 maxChainHops=4、往返 maxChainRoundTrips=2**；maxTeammates=8；maxRecentMessages=50 | 共享工作区（黑板+私密便签，重启存活，容量 32 条/4000 字）；像素岛可视化；队友不可自建团队 |
| MichaelShii/dsh-plugin-teamflow | 18 | 需求→PRD→设计→开发→QA→**验收** 流水线；默认 3 路并发、上限 8；主线程不自行改码 | 12 个 teamflow_* 工具；AGENTS.md 稳定共识层 + managed block | **防假交付**：交付以证据为准（命令+退出码+断言数）；QA 独立对抗探针；P0–P2 缺陷自动回修 ≤2 轮，超限升级人工；**验收必须显式结论行否则挂起等人**；断点续跑 |
| toolclub/dsh-agent-team-gui | 287 | lead 规划 + 有界 DAG | 团队持久化 + Run Center | per-agent 模型/工具绑定；token 洞察 |
| hunmer/dsh-team-control | 8 | 可配成员上限 + DAG 调度 | SSE 面板 | 权限配置 |
| joekytc/dsh-swarm | 7 | 多智能体流水线 | 可视化看板 | 「可证明的完成」（provable completion） |
| yangdcm/dsh-expert-team | 16 | 12 角色、9 道门禁阶段 | 共享工作区 | 阶段门禁 |
| zoe1nan/dsh-cockpit | 22 | 命令台/遥测 | 任务板 | 审批 |
| BotHarness/DeepSeekBot | 604 | 个人 bot 团队（持久记忆/身份/权限） | bot-to-bot | 权限 |
| bowenliang123/dsh-context | 4.1k | 上下文仪表盘（含 agent teams 洞察） | — | — |

**通用 DeepSeek 多智能体框架**（非 dsh 宿主）：
- zhayujie/CowAgent（47.8k）：多智能体、多模型、多通道 harness
- jnMetaCode/agency-agents-zh（21.8k）：277 个角色，DAG 自动协作
- Devin-AXIS/iPolloWork（7.4k）：人 + agent 团队工作台，Codex/DeepSeek/OpenCode 多 harness
- open-multi-agent/open-multi-agent（7k）：**durable approvals + verifiable run records**
- KunAgent/Kun（6.4k）、Fei2411/DS-Bot（5.5k：**长驻 bot 团队、bot 间消息、群聊**）、jnMetaCode/agency-orchestrator（2.4k：YAML 零代码组团队）、Deuz-AI/Deuz-SDK（508：durable execution + swarm + A2A）、dream-num/dsh-univer-office（666：多智能体 worktree 隔离）

**生态调研追加可借鉴点**（并入第 6/8/10 节设计）：
- **证据式交付验收**（teamflow 防假交付）：交付判定基于「命令 + 退出码 + 断言数」证据，QA 独立对抗探针，验收需显式结论行——可并入 `team_result` 的验收语义，比「报告即完成」严谨
- **消息节流上限**（dsh-team）：maxChainHops=4 / maxChainRoundTrips=2——防团队内消息风暴，直接用作 worker 邮箱协议的参数
- **captain 记账 + 队友汇报**（dsh-agent-teams、dsh-team 共用模式）：与 PI-Desktop supervise/result 一致，但队友可直接互发消息（无中转）
- **质量门 opt-in**：teamflow/dsh-agent-teams 的阶段门禁均为可选配置，不作为 v1 默认
- **in-process 单进程协调共识**：dsh-agent-teams 明示「并行进程编辑同一团队不协调」——印证本设计默认 in-process + 文件锁的取舍

### 1.5 pi-team 现有扩展（D:\GitHub\pi-team）

已交付的文件层团队（从 cc-haha swarm 后端提取改写）：
- 4 工具：`team_create` / `team_plan`（get/submit/update + 审批快照）/ `team_delete` / `team_message`（send/read/broadcast `"*"`）
- 4 命令：`/team`（Fleet 视图）/ `/team-create` / `/team-plan` / `/team-status`
- 数据落盘 `~/.pi/agent/teams/<team>/`：config.json + plan.json（状态机 draft → review_pending → launching → running）+ inboxes/*.json + inboxes/*.history.jsonl
- 机制：`agent_settled` 事件自动投递邮箱消息为 `<teammate-message>`；identity-based claim 防双消费；Windows rename 重试（EPERM/EACCES/EBUSY）
- 类型细节：ToolDefinition.execute 必须返回带 `details` 字段；参数 schema 用 TypeBox `Type.Object` + `StringEnum`

**已知限制**：文件层团队——teammate 进程 spawn 未实现。成员需以 `PI_TEAM_NAME`/`PI_AGENT_NAME` 环境变量独立启动 pi 实例才收信。

**这是本次改造的起点**：把「文件层团队」升级为「真实 durable worker session + 生命周期工具 + 泳道」。

---

## 2. 架构设计

### 2.1 模块划分

```
D:\GitHub\pi-agent-desktop\
├── lib/
│   ├── agent-teams-runtime.ts        ← 新增：AgentTeamsController（复用 subagent-runtime 模式）
│   ├── agent-teams-registry.ts       ← 新增：团队注册表（读写 ~/.pi/agent/teams/）
│   ├── agent-teams-mailbox.ts        ← 新增：邮箱投递（移植 pi-team teammateMailbox）
│   ├── agent-teams-types.ts          ← 新增：共享类型
│   ├── agent-teams-swimlane.ts       ← 新增：泳道快照投影（给 H5）
│   ├── subagent-runtime.ts           ← 已有：spawn 原语参考（不修改，只复用）
│   ├── subagent-extension.ts         ← 已有：扩展注册模式参考
│   └── rpc-manager.ts                ← 已有：startRpcSession / registerSession / getSession
├── app/
│   └── api/
│       └── agent-teams/              ← 新增：团队 REST/API 路由（H5 与 Agents 面板数据源）
│           ├── route.ts              ← GET /api/agent-teams（列表）
│           ├── [team]/route.ts       ← GET/DELETE 单团队
│           ├── [team]/workbench/route.ts  ← GET 泳道快照
│           └── [team]/members/[id]/route.ts  ← GET 成员详情/transcript
├── components/
│   └── AgentTeams/                   ← 新增：Agents 面板 + 泳道画布（H5 同构）
└── docs/agent-teams-design.md        ← 本文
```

**分层原则**（借鉴 DeepSeek）：
- `agent-teams-registry.ts` + `agent-teams-mailbox.ts` 是纯数据层（文件 I/O + lock），不依赖 session runtime
- `agent-teams-runtime.ts` 是编排层，依赖 session runtime（通过 dependencies 注入），不直接做文件 I/O
- 扩展（`agent-teams-extension.ts`）是工具/命令注册层，调用 runtime

### 2.2 扩展注册方式

pi-agent-desktop 用 `InlineExtension`（`{ name, factory, replaceable, builtin }`）通过 `extensionFactories` 注入 resource loader（参考 `lib/builtin-extensions.ts:342-344`、`lib/subagent-extension.ts:149-157`）。

**agent teams 扩展注册**：

```typescript
// lib/agent-teams-extension.ts
export function createAgentTeamsExtension(
  runtime: AgentTeamsExtensionRuntime,  // 桥接到 server 端 controller
  isEnabled: () => boolean = () => true,
): InlineExtension {
  return {
    name: "pi-web-agent-teams",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      if (!isEnabled()) return;
      // 注册 8 个生命周期工具 + 4 个团队工具
      pi.registerTool(defineTool({ name: "team_spawn", ... }));
      pi.registerTool(defineTool({ name: "team_send", ... }));
      // ... 其余工具
      pi.registerCommand("team", { handler: ... });
      pi.registerCommand("team-status", { handler: ... });
      // 生命周期事件
      pi.on("agent_settled", async () => { /* 邮箱投递 */ });
      pi.on("session_start", async () => { /* 恢复 team 上下文 */ });
    }
  };
}
```

**桥接模式**（完全复刻 subagent-runtime 的 `SubagentExtensionRuntime`）：

```typescript
// lib/agent-teams-runtime.ts
export interface AgentTeamsExtensionRuntime {
  start(req: TeamSpawnRequest): Promise<TeamSpawnResult>;
  send(req: TeamSendRequest): Promise<TeamSendResult>;
  status(req: TeamStatusRequest): Promise<TeamStatusResult>;
  wait(req: TeamWaitRequest): Promise<TeamWaitResult>;
  result(req: TeamResultRequest): Promise<TeamResultResult>;
  accept(req: TeamAcceptRequest): Promise<TeamAcceptResult>;
  cancel(req: TeamCancelRequest): Promise<TeamCancelResult>;
  list(req: TeamListRequest): Promise<TeamListResult>;
  message(req: TeamMessageRequest): Promise<TeamMessageResult>;
}
```

`createAgentTeamsController(dependencies)` 的 dependencies 注入：
- `getSession(sessionId)` — 从 `globalThis.__piSessions` 取 AgentSessionWrapper（复用 `rpc-manager.ts:2526` `getRpcSession`）
- `registerSession(inner, opts)` — 注册到 registry（复用 `rpc-manager.ts:2437` 的 registerRpcWrapper 模式）
- `startRpcSession(sessionId, sessionFile, cwd, opts)` — 重附着已持久化 session（复用 `rpc-manager.ts:2849`）
- `invalidateSessionList()` — 刷新会话列表缓存
- `getAgentDir()` — 取 `~/.pi/agent/`

**工具 exposure**：生命周期工具用 `exposure: "model-only"`（同 subagent 的 `SUBAGENT_TOOL_EXPOSURE`），防止 codemode 脚本调用。团队管理工具（team_create/team_plan/team_delete）用默认 exposure。

### 2.3 数据流

```
[父会话 Agent] --tool team_spawn--> [AgentTeamsController.start]
                                          │
                                          ├─ registry.writeTeam(团队+成员)
                                          ├─ SessionManager.create(parent.cwd, undefined, {parentSession})
                                          ├─ createAgentSessionFromServices(...)
                                          ├─ registerSession(inner)  ← 进 globalThis.__piSessions
                                          ├─ sessionManager.appendCustomEntry(TEAM_META_TYPE, 元数据)
                                          └─ inner.prompt(任务)  ← 启动 worker
                                          
[worker Agent] --agent_settled--> [邮箱投递 <teammate-message>]
                                          │
                                          └─ 写入父/兄弟的 inbox
```

worker 完成 → `agent_settled` 事件 → 写 `SUBAGENT_RESULT_TYPE` entry + 发 completion 到邮箱 → 父会话的 `agent_settled` 读到 inbox → `pi.sendMessage(teammate-messages, deliverAs: "followUp")` → 父 agent 新 turn 处理。

---

## 3. spawn 机制：durable worker session 创建

### 3.1 pi SDK session API（已验证可用）

pi-agent-desktop 的 session 创建链（`lib/rpc-manager.ts:2879-2926` + `lib/subagent-runtime.ts:284-326`）：

```typescript
// 1. 创建 durable session 文件（~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl）
const sessionManager = SessionManager.create(
  parent.cwd,                    // 或 worktree 路径
  undefined,                     // agentDir
  { parentSession: parent.sessionFile }  // 父子关系写进 session 文件 header
);

// 2. 构建 services（工具、MCP、资源加载器）
const services = await createAgentSessionServices({
  cwd: childCwd,
  agentDir,
  modelRuntime: parentModelRuntime,
  settingsManager,
  resourceLoaderOptions: {
    noExtensions: !profile.loadExtensions,
    noSkills: !profile.loadSkills,
    appendSystemPrompt,           // worker 的角色 prompt
    ...(exactSystemPrompt ? { extensionFactories: [createExactSystemPromptExtension(...)] } : {}),
  },
});

// 3. 创建 AgentSession（in-process，注册到 globalThis.__piSessions）
const { session: inner } = await createAgentSessionFromServices({
  services,
  sessionManager,
  model: requestedModel ?? parentModel,   // 继承父模型或指定
  thinkingLevel,
  tools: activeTools,
  excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES],
});

// 4. 写元数据进 session 文件（durable，跨重启可读）
sessionManager.appendCustomEntry("pi-web:agent-team-member", {
  version: 1,
  teamId, memberId, role, ticketId, parentSessionId, parentSessionPath, ...
});
sessionManager.appendSessionInfo(memberName);  // 侧栏显示名

// 5. 注册到 RPC registry（让 /api/agent/[id] 可达）
dependencies.registerSession(inner, { chatOnly: false });

// 6. 启动 worker
await inner.prompt(task, { source: "rpc" });
```

**durable 的关键**：
- `SessionManager.create(..., { parentSession })` 把父子关系写进 session `.jsonl` 的 header（`parentSession` 字段，参考 `AGENTS.md:263` 的 session 文件格式）
- session 文件在 `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`，是持久化文件
- 重启后：`SessionManager.open(sessionFile)` + `startRpcSession(sessionId, sessionFile, cwd)` 重附着运行时（`rpc-manager.ts:2880-2881`）
- `appendCustomEntry` 写的元数据（`pi-web:agent-team-member`）是 durable 的，跨重启可读

### 3.2 复用 subagent runtime 的 spawn 原语

`lib/subagent-runtime.ts` 的 `createSubagentController().start()` 是现成的 spawn 实现。agent teams 不重写这条链，而是：

1. **复用** `SessionManager.create` + `createAgentSessionServices` + `createAgentSessionFromServices` + `registerSession` + `appendCustomEntry` 的原语
2. **替换** metadata 类型：`pi-web:subagent` → `pi-web:agent-team-member`，增加 teamId/memberId/role/ticketId/subscriptions 字段
3. **扩展** prompt 计划：除了 subagent 的 `buildSubagentPromptPlan`，增加「团队成员身份 + 邮箱投递指令 + 任务 ticket」的 appendSystemPrompt
4. **复用** 队列与并发控制：subagent 的 `SubagentQueue`（`lib/subagent-queue.ts`）已实现 per-parent `maxConcurrent`，agent teams 用同一套，但上限按 §8 调整

### 3.3 spawn 流程（team_spawn 工具的 execute）

```
1. 解析 team_name / member 参数
2. registry.readTeam(team_name) → 校验团队存在
3. registry.mutateTeamFile(team_name, f => f.members.push(newMember))  ← 原子写，记 agentId/name/role/model/joinedAt
4. controller.start({
     parentContext: ctx,            // ExtensionContext（含 parent sessionManager）
     parentSessionId,               // 父 session id
     memberId, role, ticketId,
     task,                          // 任务 prompt
     model, thinking, max_turns,
     isolation: "worktree" | undefined,
   })
5. controller 内部：
   a. parent = dependencies.getSession(parentSessionId)  ← 取父 wrapper
   b. if (!parent?.isAlive()) throw
   c. if (!parent.sessionFile) throw  ← 父必须先持久化
   d. SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile })
   e. createAgentSessionServices(...)
   f. createAgentSessionFromServices({ model, thinkingLevel, tools, excludeTools })
   g. appendCustomEntry("pi-web:agent-team-member", metadata)
   h. registerSession(inner)
   i. inner.prompt(task, { source: "rpc" })
6. 写第一条 task delivery 到 worker 邮箱（如果走邮箱模式）或直接 prompt（in-process 模式）
7. 返回 { member_id, session_id, team_id, status: "queued"|"running", ticket_id }
```

**继承语义**（对比 PI-Desktop ADR 0237）：
- project/cwd：继承父（或 worktree 隔离）
- provider/model：继承父，可显式覆盖
- thinking level：继承父，可显式覆盖
- permission mode：继承父（复用 `parent.inner` 的权限上下文）
- **不复制 transcript**（新 session，空上下文，只注入任务 prompt）

---

## 4. 生命周期工具 API 面

### 4.1 工具清单

| 工具 | 功能 | 对标 |
|---|---|---|
| `team_create` | 建团队 + 初始成员 | pi-team 已有 |
| `team_plan` | get/submit/update + 审批 | pi-team 已有 |
| `team_delete` | 删团队 | pi-team 已有 |
| `team_message` | 邮箱 send/read/broadcast | pi-team 已有 |
| `team_spawn` | spawn durable worker session | PI-Desktop spawn + cc-haha TeamCreate 成员启动 |
| `team_send` | 向 worker 发 task/message | PI-Desktop send/supervise |
| `team_status` | worker 状态查询 | PI-Desktop status |
| `team_wait` | 等待 worker 完成（有界） | PI-Desktop wait |
| `team_result` | 取 worker 有界 report | PI-Desktop result |
| `team_accept` | 接受 worker report（ack） | PI-Desktop accept + DeepSeek Read receipt |
| `team_cancel` | 中止 worker（不删 session） | PI-Desktop cancel |
| `team_list` | 列 worker + 成员（Agents 面板/泳道数据源） | PI-Desktop list + cc-haha workbench |

### 4.2 各工具参数与返回值

#### team_spawn
```typescript
parameters: Type.Object({
  team_name: Type.String(),
  member: Type.Object({
    name: Type.String(),            // 成员名（"team-lead" 保留）
    role: Type.String(),            // 角色：researcher/impl/reviewer/test-runner/...
    task: Type.String(),            // 任务 prompt
    provider_id: Type.Optional(Type.String()),
    model_id: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    max_turns: Type.Optional(Type.Number()),
    isolation: Type.Optional(Type.String()),  // "worktree" | undefined
  }),
  ticket_id: Type.Optional(Type.String()),  // 绑定的 ticket（可空）
})
returns: {
  team_id, member_id, session_id, ticket_id,
  status: "queued" | "running",
  model: { provider, modelId },
  worktree_path?: string,
}
```

#### team_send
```typescript
parameters: Type.Object({
  team_name: Type.String(),
  member_id: Type.String(),         // 或 "*" 广播
  kind: Type.Optional(Type.String()),  // "task" | "message"（默认 message）
  text: Type.String(),
  ticket_id: Type.Optional(Type.String()),
})
returns: { delivered: boolean[], rejected?: string }  // 逐成员投递结果
```

#### team_status
```typescript
parameters: Type.Object({ team_name: Type.String(), member_id: Type.Optional(Type.String()) })
returns: {
  members: [{ id, name, role, status: "running"|"idle"|"completed"|"failed"|"aborted"|"interrupted", session_id, model, last_error, activity }],
  observed_at: string,
}
```

#### team_wait
```typescript
parameters: Type.Object({
  team_name: Type.String(),
  member_id: Type.String(),
  timeout_ms: Type.Optional(Type.Number()),  // 默认 25000，上限 45000
})
returns: {
  status: "completed" | "failed" | "aborted" | "timedOut",
  result?: string,        // 有界 report（12000 字符上限）
  error?: string,
}
```
**实现**：1 秒轮询 status（同 PI-Desktop），超时返回 `timedOut`；transcript 读取推迟到 worker 不运行后。

#### team_result
```typescript
parameters: Type.Object({ team_name: Type.String(), member_id: Type.String(), evidence?: Array<{ command: string, exit_code: number, assertions: number }> })
returns: { ready: boolean, result?: string, error?: string, status: string }
```
**验收语义（借鉴 teamflow 防假交付）**：交付判定基于**证据**而非措辞——`evidence[]` 每项是「命令 + 退出码 + 断言数」；`ready=true` 时若未附证据，父会话应追问或标记「未验证」；验收需 worker 在 result 文本中给显式结论行（如 `结论：通过/不通过`），缺失则挂起等待人工。QA 类 worker 的对抗探针结果同样走 evidence。

#### team_accept
```typescript
parameters: Type.Object({ team_name: Type.String(), member_id: Type.String() })
returns: { accepted: boolean, acknowledged_at: string }
```
**语义**：ack worker 的 report。worker 的消息在被 claim 且随后有 report/turn end 才算已读（DeepSeek Read receipt）；未 ack 的消息在 ticket 结束时回到父会话的 Eval 重新判断。

#### team_cancel
```typescript
parameters: Type.Object({ team_name: Type.String(), member_id: Type.String() })
returns: { cancelled: true, session_retained: true }  // 永不删 session
```
**实现**：调 `inner.abort()`（同 PI-Desktop `agent/abort`），session 文件保留，后续可 resume。

#### team_list
```typescript
parameters: Type.Object({ team_name: Type.Optional(Type.String()) })
returns: {
  teams: [{ id, name, description, member_count, active_member_count, status }],
  // 或单团队：members + tickets + recent_messages
}
```

### 4.3 状态机

**Worker（Member）状态机**（综合 PI-Desktop + DeepSeek）：

```
draft ──spawn──> queued ──prompt──> running ──turn_end──> idle ──next_task──> running
                    │                    │                    │
                    │ abort              │ abort              │ ticket ended
                    ▼                    ▼                    ▼
                 aborted              aborted             completed
                    │                    │
                    │ failed             │ failed
                    ▼                    ▼
                 failed              failed
                    │
                    │ 重启恢复
                    ▼
               interrupted ──re-attach──> running
```

- `queued`：已注册到队列，等待并发槽位
- `running`：正在执行 task（有活跃 turn）
- `idle`：turn 结束，等待下一条消息（可复用）
- `completed`：ticket 正常结束
- `failed`：provider 错误或无法完成
- `aborted`：被 cancel 或父 abort
- `interrupted`：应用重启时恢复（同 PI-Desktop `session.collaboration.recover`）

**Ticket 状态机**（DeepSeek）：
```
open ──assignment_ended──> ended ──reopen──> open
```

**Assignment 状态机**（DeepSeek）：
```
pending ──launch──> running ──turn_end──> ended
```

**Team 状态机**（pi-team）：
```
draft ──submit──> review_pending ──approve──> launching ──all_launched──> running
                      │                     │                    │
                      │ return              │ cancel/retry       │ delete
                      ▼                     ▼                    ▼
                   draft                 draft/retry          deleted
```

---

## 5. 父子关系持久化

### 5.1 数据目录结构

```
~/.pi/agent/teams/<team_name>/
├── config.json                    # 团队配置（移植 pi-team TeamFile）
│   {
│     "name", "description", "createdAt",
│     "leadAgentId": "team-lead",
│     "leadSessionId": "<uuid>",
│     "members": [
│       {
│         "agentId", "name", "agentType"/"role", "model", "providerId",
│         "effortLevel", "joinedAt", "cwd", "worktreePath",
│         "sessionId", "backendType": "in-process",
│         "isActive", "status", "lastError", "autoRetry",
│         "subscriptions": ["ticket-1", "ticket-2"],
│         "awaitingDependencies"
│       }
│     ],
│     "teamAllowedPaths": [...]    # 所有成员可编辑免询问的路径
│   }
├── plan.json                      # 计划（移植 pi-team）
│   { "planId", "state", "revision", "incarnationId",
│     "members": [{ "id", "name", "agentType", "prompt", "runtime", "reason" }],
│     "tasks": [{ "id", "subject", "description", "ownerId", "dependencies" }] }
├── inboxes/
│   ├── <member>.json              # 未读消息（原子写 + proper-lockfile 锁）
│   └── <member>.history.jsonl     # 已读历史（append-only）
└── tickets/
    └── <ticket_id>.json           # Ticket/Mandate/Assignment 记录
        {
          "id", "subject", "description", "ownerId",
          "mandate": { "policyVersion", "scope", "strength", "rules" },
          "status": "open" | "ended",
          "assignments": [{ "id", "status": "pending|running|ended", "sessionId", "startedAt", "endedAt" }],
          "channels": { "parentInbox", "workerInbox" },
          "inputs": [...],
          "decisions": [...]
        }
```

### 5.2 会话文件内元数据（durable，跨重启可读）

每个 worker session 的 `.jsonl` 文件内写 custom entry（同 subagent 的 `pi-web:subagent` 模式）：

```typescript
sessionManager.appendCustomEntry("pi-web:agent-team-member", {
  version: 1,
  teamId, memberId, role, ticketId,
  parentSessionId, parentSessionPath,
  parentToolCallId,
  createdAt,
  resourceSnapshot: { appendSystemPrompt, tools, loadSkills, loadExtensions },
  ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
});
// 结束时：
sessionManager.appendCustomEntry("pi-web:agent-team-result", {
  version: 1, status, completedAt, ...(result ? { result } : {}), ...(error ? { error } : {}),
});
```

**恢复**：重启后 `SessionManager.open(sessionFile)` 读这些 entry → `startRpcSession` 重附着 → worker 标 `interrupted`（同 PI-Desktop `session.collaboration.recover`）→ 新 Assignment 带恢复提示。

### 5.3 团队注册表

`agent-teams-registry.ts` 提供：
- `readTeam(teamName)` / `writeTeam(teamName, teamFile)` / `mutateTeamFile(teamName, mutator)`（原子读改写，proper-lockfile + rename，Windows EPERM/EACCES/EBUSY 重试）
- `readPlan(teamName)` / `submitTeamPlan` / `replaceTeamPlan` / `approveTeamPlan`
- `readTicket(teamName, ticketId)` / `writeTicket` / `mutateTicket`
- `listTeamNames()` / `deleteTeamDir(teamName)`
- `listLeadTeamMemberIdentities(leadSessionId)` — 供父会话工具区分自己的成员（移植 cc-haha `listLeadTeamMemberIdentities`）

---

## 6. worker 间消息（邮箱投递）

### 6.1 邮箱结构（移植 pi-team teammateMailbox）

```
~/.pi/agent/teams/<team>/inboxes/<member>.json          # 未读（原子写）
~/.pi/agent/teams/<team>/inboxes/<member>.history.jsonl # 已读（append-only）
~/.pi/agent/teams/<team>/inboxes/<member>.json.lock      # proper-lockfile 锁
```

**消息格式**：
```typescript
type TeammateMessage = {
  id: string;                    // "mailbox-<uuid>"
  from: string;                  // 发送者 agent 名
  text: string;
  timestamp: string;
  read: boolean;
  color?: string;
  summary?: string;              // 5-10 字摘要，UI 预览
  protocolType?: string;         // 结构化协议消息类型
}
```

### 6.2 投递与认领

- `writeToMailbox(recipient, message, teamName)` — 写未读 inbox（proper-lockfile 锁，Windows rename 重试）
- `readUnreadMessages(agentName, teamName)` — 读未读
- `claimMailboxMessages(agentName, teamName, candidates)` — identity-based claim，**防双消费**（两个消费者竞态时不会都 claim 同一条）
- `markMessagesAsReadByIdentity` / `markMessagesAsReadByPredicate`
- `clearMailbox`

**投递路径**：
- `team_message` / `team_send` 工具 → `writeToMailbox` → 目标 worker 的 `agent_settled` 事件读到 inbox → `pi.sendMessage(teammate-messages, deliverAs: "followUp", triggerTurn: true)` → worker 新 turn 处理
- 广播 `"*"`：遍历所有非自己、非 team-lead 的成员

### 6.3 结构化协议消息（移植 cc-haha）

| type | 用途 | 字段 |
|---|---|---|
| `permission_request` / `permission_response` | worker→lead 权限请求 / lead→worker 权限响应 | request_id, agent_id, tool_name, input, ... |
| `shutdown_request` / `shutdown_approved` / `shutdown_rejected` | 关停协议 | request_id, from, reason |
| `team_permission_update` | lead 广播权限更新 | permissionUpdate, directoryPath, toolName |
| `mode_set_request` | lead 设 worker 权限模式 | mode, from |
| `plan_approval_request` / `plan_approval_response` | 计划审批 | planFilePath, planContent, requestId, approved, feedback |
| `task_assignment` | 任务分配 | taskId, subject, description, assignedBy |
| `idle_notification` | worker 空闲通知 | idleReason, summary, completedTaskId, completedStatus, result (capped 4000 chars) |

`isStructuredProtocolMessage(text)` 路由：结构化消息不作为原始 LLM 上下文消费，而是路由到对应 handler（workerPermissions、workerSandboxPermissions 等队列）。

### 6.4 Subscription 扇出（DeepSeek 借鉴）

Ticket 与 Thread（团队讨论）多对多订阅。后续讨论（如 PR 上的新评论）扇出到活着的订阅 ticket，**不检查发送者**——worker 无需被 @ 就能收到相关上下文。这避免了 worker 间必须互相点名才能通信的限制（PI-Desktop v1 明确不做 worker 间消息，这是超越点）。

---

## 7. 泳道数据模型（给 H5 渲染的 JSON）

### 7.1 快照结构

```json
{
  "version": 1,
  "generatedAt": "2026-11-04T12:00:00.000Z",
  "team": {
    "id": "team-xxx",
    "name": "pi-desktop-upgrade",
    "description": "改造 agent teams",
    "createdAt": "2026-11-04T11:00:00.000Z",
    "leadSessionId": "<uuid>",
    "status": "running",
    "incarnationId": "inc-1"
  },
  "members": [
    {
      "id": "member-researcher",
      "name": "researcher",
      "role": "researcher",
      "model": "claude-sonnet-4-6",
      "providerName": "穿透天翼",
      "color": "blue",
      "status": "running",
      "activity": "active",
      "sessionId": "<uuid>",
      "cwd": "D:\\GitHub\\pi-agent-desktop",
      "worktreePath": null,
      "lastError": null,
      "joinedAt": "2026-11-04T11:05:00.000Z"
    }
  ],
  "tickets": [
    {
      "id": "ticket-1",
      "subject": "实现 team_spawn 工具",
      "description": "...",
      "ownerId": "member-impl",
      "status": "open",
      "dependencies": [],
      "assignments": [
        { "id": "asg-1", "status": "running", "sessionId": "<uuid>", "startedAt": "..." }
      ]
    }
  ],
  "lanes": [
    {
      "memberId": "member-lead",
      "name": "team-lead",
      "role": "orchestrator",
      "color": "gray",
      "status": "running",
      "events": [
        { "seq": 1, "at": "...", "type": "spawn", "detail": "spawned member-impl" },
        { "seq": 2, "at": "...", "type": "task", "taskId": "ticket-1", "text": "实现 team_spawn" },
        { "seq": 3, "at": "...", "type": "message", "from": "team-lead", "to": "member-impl", "text": "...", "kind": "message" }
      ]
    },
    {
      "memberId": "member-impl",
      "name": "impl",
      "role": "impl",
      "color": "green",
      "status": "running",
      "events": [
        { "seq": 1, "at": "...", "type": "spawn", "detail": "session created" },
        { "seq": 2, "at": "...", "type": "turn_start", "turnId": "..." },
        { "seq": 3, "at": "...", "type": "tool_call", "tool": "Write", "detail": "lib/agent-teams-runtime.ts" },
        { "seq": 4, "at": "...", "type": "turn_end", "turnId": "...", "status": "completed" },
        { "seq": 5, "at": "...", "type": "report", "state": "ready", "text": "实现完成" }
      ]
    }
  ],
  "flows": [
    { "from": "member-lead", "to": "member-impl", "at": "...", "text": "...", "kind": "message", "ticketId": "ticket-1" },
    { "from": "member-impl", "to": "member-lead", "at": "...", "text": "实现完成", "kind": "report", "state": "ready" }
  ],
  "taskAnchors": [
    { "ticketId": "ticket-1", "memberId": "member-impl", "status": "in_progress", "messageId": "msg-1", "timestamp": "..." }
  ]
}
```

### 7.2 H5 渲染映射

- **lanes[]** → 水平泳道（每成员一条），y 轴 = 成员，x 轴 = 时间
- **lanes[].events[]** → 泳道上的事件节点（spawn/task/turn_start/turn_end/report/message/tool_call）
- **flows[]** → 跨泳道箭头（消息/报告流动）
- **tickets[]** → 泳道上方的任务依赖条（DAG）
- **taskAnchors[]** → 成员对话按任务切分的锚点（哪个任务上工作了哪段）

H5 只消费这个 JSON，不碰会话内部状态。服务端 `agent-teams-swimlane.ts` 负责从 registry + session entries + mailbox 投影出这个快照。

### 7.3 快照 API

- `GET /api/agent-teams/[team]/workbench` → 当前快照（live）
- `GET /api/agent-teams/[team]/workbench?at=<ts>` → 历史快照（archive，落盘 `teams/<team>/workbench/<ts>.json`）
- `GET /api/agent-teams/[team]/members/[id]/transcript` → 成员 transcript 页（incremental + afterOrdinal）

---

## 8. 上限策略

### 8.1 PI-Desktop 的 4/16

PI-Desktop：每父会话 4 个活跃 worker，插件全局 16 个。理由（ADR 0237）：避免失控、保持可观测性。

### 8.2 cc-haha 的并发

cc-haha：subagent 队列 per-parent `maxConcurrent`（默认可配），team 成员数无硬上限（但 UI 和成本是软约束）。

### 8.3 DeepSeek 的槽位

DeepSeek：有界并发槽位，**留一个额外槽位给人的消息/状态请求**（防止新工作饿死人类继续对话）。

### 8.4 落地值：12 / 32 + 人类优先槽

> **2026-11-05 复核后从 8 调整为 12。** 原文档的 8 是为了「泳道画 8 条 lane」，但泳道投影
> （`agent-teams-swimlane.ts`）早已按成员数动态生成，那个锚点不存在了；而 8 会误伤常见用法
> ——lead 并行改 10 个互不相干的文件时会卡在第 9 个，可每个成员其实很轻。真正承担「防失控」
> 的是全局 32。需要更紧的人用 `PI_TEAM_MAX_MEMBERS` 调低。

| 维度 | 落地值 | 状态 | 理由 |
|---|---|---|---|
| 每父会话活跃 worker | **12** | ✅ 已实现（`getMaxMembersPerTeam()`，`PI_TEAM_MAX_MEMBERS` 可覆盖） | 只防「一个团队失控」；12 是不误伤正常并行、又能及时刹车的实用值（原 8 的锚点已失效） |
| 全局活跃 worker | **32** | ✅ 已实现（`getMaxGlobalWorkers()`，`PI_TEAM_MAX_GLOBAL_WORKERS` 可覆盖） | **真正的安全边界**：每个成员是一个 in-process AgentSession，吃内存也打 provider 限流 |
| worker 不能再 spawn worker | **保持** | 见 Phase 4 | 安全边界（PI-Desktop 已验证），防递归失控 |
| 人类优先槽 | **1 个/父** | ✅ 已实现（`isHumanPriorityEnabled()`；`PI_TEAM_HUMAN_PRIORITY=0` 可关） | 借鉴 DeepSeek：人的消息/状态请求不排队，直接插队，防饿死 |
| worker 邮箱 inbox 上限 | **8 条未读**（同 PI-Desktop `AGENT_BUSY`） | ✅ 已实现（`getMaxUnread()`；`PI_TEAM_MAX_UNREAD=0` 关闭） | 防投递风暴 |
| Ticket 依赖环检测 | **禁止环** | 见 Phase 4 | 任务 DAG 必须是有向无环图 |

**上限拒绝消息**要区分原因（同 PI-Desktop background tasks D1/D2）：`LIMIT_EXCEEDED: per-team worker limit reached (12)` vs `LIMIT_EXCEEDED: global worker limit reached (32)`。

> 落地说明：两个数值上限已在 `pi-team/src/constants.ts` 与 `teamTools.ts` 的 `checkSpawnLimits()` 中实现，
> 拒绝消息前缀为 `LIMIT_EXCEEDED`，分别带 `per-team` 与 `global`。全局计数跨所有团队的 `config.json`，
> 但排除调用方自己 —— `team_create` 是先落盘名册再派发，若把自己算进基数，新团队第一次派发就会自我判超限。
> 超限时团队名册仍然创建（有效），只是不派发任何成员。
>
> 人类优先槽落在 `teamBus.ts` 的 `#isHumanPriority()`：发送者名为 `human` 的直发消息不进
> `#scheduleWake()` 的静默合并窗口，直接 `#flush()` 立即唤醒；成员之间的消息仍走防抖合并。
> 这样一串 agent 消息不会把人的插话按窗口往后推。

---

## 9. in-process vs 子进程的取舍

### 9.1 三种部署形态对比

| 形态 | 代表 | 优点 | 缺点 |
|---|---|---|---|
| **in-process** | pi-agent-desktop subagent、DeepSeek dsh-superagent | 无进程启动开销；共享内存；直接调用 SDK；生命周期简单；durable session 文件即持久化 | worker 崩溃会拖垮父进程；资源隔离弱；一个大 worker 的内存峰值影响全局 |
| **子进程（CLI spawn）** | cc-haha tmux/iterm2/process backend、pi-team 独立 pi 实例 | 进程隔离强；崩溃不影响父；可独立重启；可独立部署到远程 | 进程启动慢（秒级）；IPC 复杂；环境变量传递易漏；Windows 下进程管理坑多 |
| **混合** | cc-haha（in-process + process 双 backend）、PI-Desktop（host sidecar + plugin） | 按场景选；in-process 用于轻量 worker，process 用于重量级/隔离 worker | 两套生命周期；一致性成本高 |

### 9.2 建议：默认 in-process，可选 worktree 隔离，未来加 process backend

**v1 默认 in-process**：
- 复用 pi-agent-desktop 现有 subagent runtime（已是 in-process）
- durable session 文件 + `startRpcSession` 重附着，重启可恢复
- worker 崩溃：session 文件保留，标 `interrupted`，可 resume（同 subagent 的 `resume`）
- **安全边界**：worker 不能 spawn worker；权限继承父；inbox 上限 8

**worktree 隔离**（可选，同 subagent 的 `isolation: "worktree"`）：
- 每个 worker 一个 git worktree，路径隔离
- 但 DeepSeek 明确警告：「这些 wrapper 和目录建立默认值，**不是安全边界**」——worktree 不是沙箱，只是工作目录隔离

**未来 v2 加 process backend**：

> **2026-11-05 评估结论：不做。** 理由三条：
> 1. **与已实现的能力冲突** —— 成员身份注入走 `appendSystemPrompt`（in-process 专属通道），
>    人类优先槽走 `host.wake()` 的进程内调用；换成子进程这两块都要重做。
> 2. **代价极高** —— 要重写 spawn 路径（现复用 `subagent` runtime）、新建跨进程邮箱/IPC
>    （现 `teamBus` 的 waiters 是进程内的）、处理 Windows 进程树管理。
> 3. **收益当前为零** —— 它服务的是「重量级 worker / 强隔离 / 远程部署」，而团队 agent
>    现在跑的是文件编辑、代码搜索这类轻任务；目录隔离已由 `isolation: "worktree"` 提供。

- 借鉴 cc-haha 的 `backendType: "process"` + `tmuxPaneId`/`sessionId`
- worker 作为独立 pi 子进程启动，通过邮箱/IPC 通信
- 适用场景：重量级 worker、需强隔离、需远程部署

**不做的**：不做 tmux/iterm2 backend（Windows 桌面无 tmux）；不做 A2A channel / message bus / DAG engine（PI-Desktop ADR 0237 明确不做，我们也不做——用 Ticket 依赖图代替 DAG）。

---

## 10. 实现路线（分步，每步验证）

### Phase 1：团队文件层 + 邮箱投递（移植 pi-team，1 周）

**目标**：把 pi-team 的文件层团队移植进 pi-agent-desktop 的 lib/。

**步骤**：
1. 移植 `lib/agent-teams-registry.ts`（config.json/plan.json 原子读写，proper-lockfile）
2. 移植 `lib/agent-teams-mailbox.ts`（inboxes/*.json + history.jsonl + claim）
3. 移植 `lib/agent-teams-types.ts`（TeamFile/TeamPlan/TeammateMessage/Ticket/Mandate/Assignment 类型）
4. 移植 `lib/agent-teams-extension.ts`（team_create/team_plan/team_delete/team_message + /team /team-create /team-plan /team-status 命令）
5. 注册为 InlineExtension（`extensionFactories` 注入）

**验证**：
- `node --test lib/agent-teams-registry.test.mjs`（原子写、Windows rename 重试、锁竞争）
- `node --test lib/agent-teams-mailbox.test.mjs`（投递、认领、双消费防护、广播）
- 手动：起 pi-agent-desktop，用 team_create 建团队，team_message 广播，/team-status 查未读
- `npm run check:deps && tsc --noEmit && npm run lint`

### Phase 2：durable worker spawn（复用 subagent runtime，1.5 周）

**目标**：实现 team_spawn，创建真实 durable worker session。

**步骤**：
1. 写 `lib/agent-teams-runtime.ts`（createAgentTeamsController，复刻 subagent-runtime 的 start 流程）
2. 新增 metadata type `pi-web:agent-team-member` + `pi-web:agent-team-result`（appendCustomEntry）
3. 实现 `team_spawn` 工具（参数解析、registry 写成员、controller.start、返回 session_id）
4. 实现 `team_send` / `team_status` / `team_wait` / `team_result` / `team_accept` / `team_cancel` / `team_list`
5. worker prompt 计划：appendSystemPrompt 注入「成员身份 + 邮箱投递指令 + 任务 ticket + 停止条件」
6. Worker 的 `agent_settled` → 写 result entry + 发 completion 到邮箱

**验证**：
- `node --test lib/agent-teams-runtime.test.mjs`（spawn 后 session 文件存在、metadata entry 可读、prompt 被调用、cancel 后 session 保留）
- 手动：team_spawn 一个 worker，看侧栏出现新 session、泳道快照有 lane、worker 完成父收到 completion
- 重启恢复：杀掉 app 重启，worker 标 interrupted，可 resume
- 上限：spawn 第 9 个 worker 被拒，消息区分 per-parent vs global

### Phase 3：泳道可视化 + API（1 周）

**目标**：泳道数据模型 + H5 渲染 + REST API。

**步骤**：
1. 写 `lib/agent-teams-swimlane.ts`（从 registry + session entries + mailbox 投影快照）
2. 新增 `app/api/agent-teams/` 路由（list / [team] / [team]/workbench / [team]/members/[id]/transcript）
3. 写 `components/AgentTeams/`（Agents 面板 + 泳道画布，复用现有 UI token）
4. H5 端消费 workbench JSON（泳道画布）

**验证**：
- `node --test lib/agent-teams-swimlane.test.mjs`（快照投影：lanes/events/flows/taskAnchors 正确）
- `node --test app/api/agent-teams/*.test.mjs`（API 路由）
- 手动：多 worker 并行，泳道画布实时显示各 lane 事件与跨 lane flow
- 历史快照：at=<ts> 返回当时快照

### Phase 4：DeepSeek 三段式 + 人类优先槽（1 周）

**目标**：Ticket/Mandate/Assignment 三段式 + 并发槽位留人优先。

**落地状态（2026-11-05）**

| 步骤 | 状态 | 说明 |
|---|---|---|
| 5. team_plan 审批后自动 launch | ✅ 已实现 | `teamPlanStore.approveTeamPlan()` 原本是死代码（无人调用）；现补上 `claimPlanLaunch()` / `completePlanLaunch()` / `failPlanLaunch()`，并把 `team_plan` 扩展到 `operation: approve \| launch`。幂等靠 plan 状态机：`launch.status` 一旦不是 `pending` 就返回"没有待派发的计划" |
| 人类优先槽 | ✅ 已实现 | `teamBus.#isHumanPriority()`：`from === 'human'` 的直发消息跳过 `#scheduleWake()` 的静默合并窗口，直接 `#flush()` |
| 1. Ticket/Mandate/Assignment | ⬜ 未实现 | 只有 `message-protocol.ts` 的 `TaskAssignmentMessage` 消息类型；无 `tickets/<id>.json` 落盘实体与状态机 |
| 2. Subscription 扇出 | ⬜ 未实现 | `TeamMember.subscriptions` 字段恒为 `[]`，无扇出逻辑 |
| 3. Read receipt | ⚠️ 部分 | 只有 `teamBus.#flush()` 的"注入即标记已读"，无 ack 回执与未 ack 查询 |

**原始步骤**：
1. 实现 `tickets/<ticket_id>.json`（Mandate 不可变、Ticket open/ended、Assignment pending/running/ended）
2. 实现 Subscription 扇出（ticket 订阅 thread，后续讨论自动扇出）
3. 实现 Read receipt（claim + report/turn_end 算已读，未 ack 回 Eval）
4. 实现人类优先槽（人的消息/状态请求插队）
5. team_plan 审批后自动 launch 成员（server 端启动，非 agent 端）

**验证**：
- `node --test lib/agent-teams-runtime.test.mjs`（Mandate 撤销、Ticket 状态机、Assignment 独立状态、Subscription 扇出、Read receipt）
- 手动：提交 plan → 审批 → 成员自动 launch → 后续 PR 评论扇到订阅 ticket
- 并发：8 worker 满载时人的消息插队成功

### Phase 5：集成与端到端（0.5 周）

**目标**：全链路打通 + 回归。

**步骤**：
1. 集成测试：团队创建 → plan 审批 → spawn 多 worker → 泳道可视化 → worker 间消息 → 完成 → 父汇总
2. 回归：`npm run check:deps && tsc --noEmit && npm run lint && npm test`
3. 文档：更新 AGENTS.md 的 File Map + Topic Notes

**验证**：
- E2E：真实 provider 下多 worker 并行完成一个真实任务
- 重启恢复：杀 app 重启，团队关系完整恢复
- 上限拒绝：per-parent 8 / global 32 拒绝消息正确
- worker 不能 spawn worker：被拒

---

## 11. 对比结论：比 PI-Desktop v1 强在哪、比 cc-haha 强在哪

### 11.1 比 PI-Desktop Session Orchestrator v1 强在哪

| 维度 | PI-Desktop v1 | 本设计 |
|---|---|---|
| worker 间消息 | ❌ v1 明确不做 | ✅ 邮箱投递 + Subscription 扇出（借鉴 cc-haha + DeepSeek） |
| 授权模型 | 扁平 spawn（继承四元组） | ✅ Mandate/Ticket/Assignment 三段式（DeepSeek），授权范围/强度/规则分离 |
| 执行模型 | 插件侧轮询（1s，25-45s 有界） | ✅ 先落库后执行的 durable pipeline（DeepSeek），副作用事务内入队 commit 后执行 |
| 进度报告 | 有界 report 提取 | ✅ Report 状态机（ready/blocked/failed/waiting/dropped）+ Read receipt（DeepSeek） |
| 上限 | 4/16 | ✅ 8/32 + 人类优先槽（DeepSeek），更贴合大型重构场景 |
| 泳道可视化 | Agents 面板（列表 + status/open/stop） | ✅ 泳道画布（lanes/events/flows/taskAnchors），H5 可渲染 |
| worker 复用 | 可 send/supervise 后续 | ✅ 同样可复用（idle → running）+ Subscription 免点名 |
| 安全边界 | worker 不能 spawn worker | ✅ 同样 + Mandate 不可变（只有人 stop 或 Policy 变化撤销） |
| 重启恢复 | session.collaboration.recover（标 interrupted） | ✅ 同样 + tickets 持久化 + 恢复提示 |
| 任务编排 | 无 DAG | ✅ Ticket 依赖图（有向无环）+ task anchor 泳道切分 |
| 工具面 | 单工具 9 action | ✅ 多工具清晰 schema（LLM 更易选，UI 更易映射） |

**关键超越点**：worker 间消息（PI-Desktop v1 的最大限制）+ Mandate/Ticket/Assignment 三段式（比扁平 spawn 严谨）+ Subscription 扇出（免点名通信）+ 泳道可视化（PI-Desktop 只有列表面板）。

### 11.2 比 cc-haha swarm 强在哪

| 维度 | cc-haha swarm | 本设计 |
|---|---|---|
| 进程模型 | in-process + tmux/iterm2/process 多 backend（Windows 无 tmux） | ✅ 默认 in-process（Windows 友好）+ worktree 隔离 + 未来 process backend |
| durable session | teammate 进程/tmux pane（进程级） | ✅ durable session 文件（.jsonl）+ SessionManager 重附着（重启可恢复，跨 app 版本） |
| 审批模型 | TeamPlan 审批快照（review_pending） | ✅ 同样 + Mandate 不可变（DeepSeek）+ 审批后 server 自动 launch |
| 邮箱投递 | inboxes/*.json + history.jsonl + claim | ✅ 完全移植（pi-team 已验证）+ Subscription 扇出（DeepSeek） |
| 结构化协议 | permission/shutdown/plan_approval/task_assignment/idle_notification | ✅ 完全移植 + Report 状态机（DeepSeek） |
| 泳道可视化 | workbench 快照 + 泳道画布（v0.5.4） | ✅ 同样 + taskAnchors 泳道切分 + H5 同构 |
| 授权 | teamAllowedPaths（免询问路径） | ✅ 同样 + Mandate scope/strength/rules 分离（DeepSeek） |
| 并发 | per-parent maxConcurrent | ✅ 8/32 + 人类优先槽（DeepSeek） |
| worker 隔离 | worktree 隔离（不是安全边界） | ✅ 同样 + 明确警告 |
| 哲学 | — | ✅ 注意力经济学 + 最小概念 + 简洁发言 + 诚实报告（DeepSeek philosophy） |
| Windows 兼容 | tmux/iterm2 不适用 | ✅ 原生 Windows（in-process + proper-lockfile + EPERM 重试） |

**关键超越点**：durable session 文件（cc-haha 是进程级，我们是文件级，跨 app 版本可恢复）+ Mandate 三段式（比 teamAllowedPaths 更严谨）+ Subscription 扇出（cc-haha 需 SendMessage 点名）+ Windows 原生（cc-haha 的 tmux backend 在 Windows 不可用）+ DeepSeek 哲学层（注意力经济学、最小概念、诚实报告）。

### 11.3 共同的天花板（都承认的边界）

- worktree/目录隔离**不是安全边界**（DeepSeek 明确警告，我们同样声明）
- worker 崩溃会拖垮父进程（in-process 的代价，未来 process backend 缓解）
- 模型能力是上限：多 agent 协作的质量取决于模型是否能理解角色分工与任务边界
- 不实现 A2A channel / message bus / DAG engine（PI-Desktop ADR 0237 明确不做，用 Ticket 依赖图代替）

---

## 附录 A：关键参考文件索引

### PI-Desktop
- `docs/adr/0237-session-orchestrator-as-a-plugin.md` — Session Orchestrator ADR
- `docs/adr/0240-independent-session-discovery-and-navigable-projections.md` — 会话发现 ADR
- `docs/spec/03-runtime/02-agent-runtime.md` — Agent Runtime 规格
- `docs/spec/03-runtime/06-host-rpc-protocol.md` — host RPC 协议（session.collaboration.*）
- `docs/zh-CN/spec/07-plugins/16-trusted-extensions.md` — 受信任扩展规格
- `docs/implementation/background-task-session-dock.md` — 后台任务 dock
- `crates/host-core/src/session_collaboration/` — host 侧协作 ledger（mod/repository/settlement/projections/schema）
- `scripts/e2e-session-collaboration.mjs` / `e2e-session-completion.mjs` — E2E

### cc-haha
- `src/utils/swarm/teamHelpers.ts` — TeamFile 模型
- `src/utils/teammateMailbox.ts` — 邮箱投递
- `src/utils/swarm/inProcessRunner.ts` — in-process teammate runner
- `src/utils/swarm/spawnUtils.ts` — spawn 工具
- `src/server/services/teamService.ts` — TeamWorkbenchSnapshot 类型
- `src/server/api/teams.ts` — teams REST API
- `src/tools/TeamCreateTool/` `TeamPlanTool/` `TeamDeleteTool/` `SendMessageTool/` — 工具
- `docs/internals/agent-framework.md` — Agent 框架深度解析
- `release-notes/v0.5.4.md` — Agent Teams 工作台

### DeepSeek
- `github.com/deepseek-ai/dsh-superagent-prototype` — docs/000-philosophy.md, 001-domain.md, 002-authorization.md, 003-execution.md, 007-architecture.md
- `github.com/deepseek-ai/deepseek-harness` — Cordis "everything is a plugin"；官方实验插件：智能体团队（共享任务板）、子智能体、Agent 循环
- `deepseek.com/harness` — Harness 官方页（实验插件清单、运行方式、桌面版）
- Cordis paper: arXiv 2608.25512
- 社区生态（GitHub 调研）：`NanmiCoder/dsh-agent-teams`（2.7k★）、`bowenliang123/dsh-context`（4.1k★）、`BotHarness/DeepSeekBot`（604★）、`toolclub/dsh-agent-team-gui`（287★）、`MichaelShii/dsh-plugin-teamflow`（团队流水线+防假交付）、`huxint/dsh-team`（邮箱/工作区/跳数上限）、`hunmer/dsh-team-control`、`yangdcm/dsh-expert-team`、`zoe1nan/dsh-cockpit`、`joekytc/dsh-swarm`
- 通用框架：`zhayujie/CowAgent`、`jnMetaCode/agency-agents-zh`、`Devin-AXIS/iPolloWork`、`open-multi-agent/open-multi-agent`、`KunAgent/Kun`、`Fei2411/DS-Bot`、`jnMetaCode/agency-orchestrator`、`Deuz-AI/Deuz-SDK`、`dream-num/dsh-univer-office`

### pi-agent-desktop（目标仓库）
- `lib/rpc-manager.ts` — AgentSessionWrapper / startRpcSession / registerSession / getRpcSession（2849-3050）
- `lib/subagent-runtime.ts` — createSubagentController（191-477，spawn 原语参考）
- `lib/subagent-extension.ts` — createSubagentExtension（149-157，扩展注册模式）
- `lib/subagents.ts` — SUBAGENT_META_TYPE / SUBAGENT_CONTROL_TOOL_NAMES
- `lib/builtin-extensions.ts` — InlineExtension 注册
- `app/api/agent/new/route.ts` — POST /api/agent/new（session 创建路由）
- `app/api/sessions/route.ts` — GET /api/sessions
- `AGENTS.md` — 架构与 File Map
- `docs/agents/sessions.md` / `subagents.md` — 会话与子 agent 文档

### pi-team
- `D:\GitHub\pi-team\extensions\index.ts` — 4 工具 4 命令
- `D:\GitHub\pi-team\src/teamHelpers.ts` / `teammateMailbox.ts` / `teamPlanStore.ts` / `teamPlan.ts`

### 用户配置
- `D:\Users\Documents\Obsidian Vault\AI\Pi Agent.md` — §4.5 pi-team、§9 原生能力、§12 cc-haha 对照
