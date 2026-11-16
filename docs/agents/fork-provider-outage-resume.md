# Provider 中断自愈（API 挂几小时后自动续跑）

目标：模型 API 连续不可用（几分钟到几小时）时，会话/任务**挂起等待**而不是判失败；服务恢复后自动接着干，轮次预算不被故障烧掉；进程重启后仍能接续。

现状结论（2026-11-16 调研）：**做不到**。三层各有地基但缺关键一环。

| 层 | 现状 | 缺口 |
|---|---|---|
| 进程层 | `lib/keepalive/` 15s 心跳、90s 假死、`scripts/pi-supervisor.mjs` 外部拉起（5 次/小时预算），默认关闭 | 只拉进程，不恢复 turn |
| 单轮调用层 | agent 层 `maxRetries:3`、`2/4/8s`、单次延迟 cap 60s，合计约 14s（`pi-coding-agent/dist/core/settings-defaults.js:17-24`）；provider 层默认 0 次（`pi-ai/dist/utils/provider-retry.js:77`），`retry-after > 60s` 直接失败（`:22-27`） | 无小时级退避、无恢复探测 |
| 任务层 | autofix 有孤儿接续（`lib/autofix/runner.ts:498-524`，60s sweep）；goal 有自主续跑但**同进程 + 20 轮/10 分钟双闸**（`lib/goal/goal-types.ts:48-55`）；scheduled 只补最近一个 slot | 普通聊天 turn 不落库、不续跑；goal 不区分 provider 故障，几分钟烧光预算后 `paused` |

设计原则：

1. **故障分类先于重试**。provider 不可用 ≠ 任务失败，更 ≠ 该消耗预算。
2. **挂起要落盘**。进程随时可能被重启/更新，内存态不可依赖。
3. **续跑用 followUp 提示，不重发原 prompt**。原用户消息已在会话记录里，重发会重复。
4. **有硬上限**。等待总时长、探测次数、恢复后连续失败次数都有上限，绝不无限烧。
5. **rpc-manager 只加钩子**。该文件 fork-ownership 标 high 风险，接线控制在个位数行。

---

## 1. 故障分类（纯函数，先写测试）

新文件 `lib/outage/classify.ts`，输入 `(errorText, statusCode?)`，输出四类：

| 类别 | 判据（示例） | 处置 |
|---|---|---|
| `transient` | 429 短限流、单次连接抖动 | 交回 SDK 既有 3 次重试，不进挂起 |
| `outage` | 5xx、连接拒绝/重置/DNS、`service unavailable`、`upstream error`、`stream interrupted` | **挂起**，长退避探测 |
| `quota` | `insufficient_quota`、`quota exceeded`、`billing`、Zhipu 1308、`usage limit` | **挂起**但标记「额度类」，退避更长（额度可能按小时/按周期恢复） |
| `terminal` | 401/403 鉴权失效、模型不存在、400 参数错 | **不挂起**，按失败上报用户 |

复用 SDK 已有的可重试判据（`pi-ai/dist/utils/retry.js` 的 `RETRYABLE_PROVIDER_ERROR_PATTERN` 与 `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`），在其上再分 `quota` / `terminal`，避免自己维护第二份错误词表。**先读该文件，能用导入就用导入**；只能复制时，把词表版本与来源行号写进注释。

## 2. 挂起记录（原子写）

`lib/outage/store.ts`，文件 `~/.pi/agent/pi-web/outages/<sessionId>.json`：

```jsonc
{
  "version": 1,
  "sessionId": "...",
  "kind": "outage" | "quota",
  "reason": "upstream 503",
  "scope": "chat" | "goal" | "autofix" | "scheduled" | "team",
  "origin": { "provider": "...", "modelId": "..." },
  "resume": { "mode": "followup", "note": "上一轮因服务中断未完成…" },
  "budget": { "attempts": 3, "maxAttempts": 40, "startedAt": 0, "deadlineAt": 0 },
  "guard": { "lastUserMessageId": "...", "sessionUpdatedAt": 0 },
  "pid": 1234,
  "updatedAt": 0
}
```

- 原子写：tmp + rename（与 autofix 任务文件同风格）。
- `guard.lastUserMessageId` 是**防抢跑**的关键：续跑前核对会话最后一条用户消息仍是挂起时那条，用户中途发了新消息就作废记录（`superseded`）。
- 孤儿判据照抄 autofix：`pid` 活着且记录新鲜 ⇒ 归本进程；pid 死/缺失且超过 stale 阈值 ⇒ 可接续（`lib/keepalive/resume.ts:67-94` 的分类函数可直接复用其思路）。

## 3. 探测与退避（调度器）

`lib/outage/scheduler.ts`，仿 `startAutofixSweepLoop`（`lib/autofix/runner.ts:548-569`）在 `instrumentation-node.ts` 启动，受同一 `PI_WEB_DISABLE_SCHEDULER=1` 开关族静默：

- 退避序列：`30s, 1m, 2m, 5m, 10m, 20m, 30m(封顶)` + ±20% 抖动。`quota` 档从 5m 起、封顶 30m。
- **两段式探测**：
  - 前 3 次：直接重发该轮的续跑提示（连接失败不产生 token，成本≈0）。
  - 之后：改为轻量探针（该 provider 的模型列表或 1-token 请求），成功后再续跑，避免恢复瞬间反复重放长上下文。
- 硬上限：`maxAttempts` 默认 40、`deadlineAt` 默认 6 小时后（`quota` 默认 24 小时）。触顶转 `expired`，UI 提示并停止。
- 恢复后保护：续跑一轮若又遇到 `outage` → 回挂起（不计新预算）；若遇到 `terminal` 或连续 3 次非 outage 失败 → 判失败，不再挂起。
- 取消：用户在 UI 点「取消等待」或对该会话按 Stop → 删除记录。**Stop 语义不变**（aborted 仍然不自动续跑）。

## 4. 接入点（四个，按改动从小到大）

### 4.1 普通会话（P1，核心）

- `lib/outage/rpc-hook.ts` 导出 `onRunEnded({ sessionId, outcome, provider, modelId })`。
- `lib/rpc-manager.ts` 的 `agent_end` 分支（`:663-669`，已有 `agentRunOutcome(event)`）后加**一行**调用；`agent_settled` 的 aborted 分支（`:697-703`）保持不续跑。
- 挂起时不把 `lastRunOutcome` 当失败展示，新增会话状态 `waiting-for-provider`（沿用 `getTaskSnapshot()` 的 waiting 结构，`lib/rpc-manager.ts:780-797`）。
- 会话 wrapper 可能被 10 分钟 idle 驱逐——**这没关系**：状态在磁盘上，调度器按 `sessionId` 重新 `startRpcSession` 即可（autofix 的 `openLiveAutofixSession` 就是这套做法，`lib/autofix/runner.ts:589-630`）。

### 4.2 goal（P2）

- `lib/goal/goal-extension.ts:165-183` 的 `agent_settled`：续跑前先查挂起记录，存在则**不发送续跑、不 `applyGoalEvent({type:"message"})`**，预算不动。
- 恢复后由调度器续跑，goal 正常推进。
- 附带修一个既有问题：现在 `agent_settled` 只看 `event.aborted`，不看失败原因，provider 故障会烧完 20 轮。分类钩子落地后顺带修正。

### 4.3 autofix（P3）

- `lib/autofix/runner.ts:278-295` 的 agent-error 分支：分类为 `outage/quota` 时不 `round += 1`，写挂起记录，任务状态置 `waiting-provider`（新增状态，`lib/autofix/types.ts`）。
- 恢复后 sweep 照旧驱动；`buildRecoveryNote`（`lib/keepalive/resume.ts:173-186`，目前**定义了但无人调用**）在这里首次启用。

### 4.4 scheduled（P3）

- `lib/scheduled-tasks/runner.ts` 失败分支：`outage/quota` 不计入「连续失败 5 次停用」，改为同一 slot 内退避重试，slot 结束仍未恢复则记 `skipped-provider-outage` 并在下一个 slot 正常跑。

## 5. 重启接续（P4）

- 调度器启动时扫描 `outages/`：孤儿记录按 §2 判据接续。
- 续跑提示统一用 `buildRecoveryNote()` 生成（核对工作目录真实状态、跳过已完成步骤），避免重复劳动。
- ⚠️ **待验证的前置问题**：用户消息在 SDK 何时落盘。若 `prompt()` 调用后立刻落盘，则续跑用 followUp 提示是安全的；若只随 `message_end` 落盘，则「用户消息 + 中断」的记录可能缺失，需要在挂起记录里存一份原 prompt 作为兜底。**实现前必须写脚本验证**（构造一个立即失败的上游，看 `.jsonl` 里有无该 user 条目），不要凭推断。

## 6. UI 与设置

- 会话条/聊天区：`waiting-for-provider` 状态显示「服务不可用，{n} 后第 {k} 次重试」+「立即重试」+「取消等待」，不要显示成红色错误。
- Tasks 页（`components/tasks/TasksView.tsx`）新增一段「等待服务恢复」，与 Needs You 区分：一个等用户，一个等上游。
- 设置 › 通用：新增「服务中断自动续跑」分组（默认**开启**）：
  - 开关、最长等待（1/2/6/24 小时）、恢复后连续失败阈值（固定 3，不暴露）。
  - 设置读写复用 pi-web settings 模式（`lib/artifact-settings.ts` / `lib/lean-mode.ts` 的 `getPiWebSettingsPath/readStored/updatePiWebSettings`），仅本机可改。
- i18n 三语进 `lib/i18n/locale-plugins.ts` 的 `FORK_MESSAGE_PATCHES`，前缀 `outage.*`。

## 7. 测试矩阵

| 层 | 用例 |
|---|---|
| classify | 四类各 3-5 条真实错误串；`retry-after` 长值归 `outage`；401 归 `terminal`；quota 词表全部命中 |
| backoff | 序列单调、封顶、抖动在 ±20% 内；`quota` 起点 5m；触顶 `expired` |
| store | 原子写、坏 JSON 降级、supersede（用户发新消息）、cancel、孤儿判定（pid 活/死/stale） |
| hook | 一次 `agent_end(error)` → 生成记录且 `lastRunOutcome` 不标失败；aborted 不生成 |
| goal | 挂起期间 `agent_settled` 不续跑、轮次不变；恢复后正常续跑 |
| autofix | 挂起轮不计 round；恢复后 round 继续；`waiting-provider` 状态投影 |
| scheduled | 故障期不计失败次数；slot 结束跳过 |
| restart | 写记录 → 新进程扫描 → 接续；`buildRecoveryNote` 注入 |
| 端到端 | 假上游：拒绝连接 60s → 恢复 → 会话自动继续；进程重启版本 |

## 8. 分阶段与验收

- **P1**（普通会话挂起+恢复，不含重启）：分类、store、调度器、hook、会话状态、单测。验收：断流 5 分钟后恢复，会话自动续跑且不重复用户消息。
- **P2**（goal）：挂起不烧预算。验收：goal 进行中断流 10 分钟，恢复后仍 active、轮次只增 1。
- **P3**（autofix / scheduled）：故障不消耗轮次与失败计数。
- **P4**（重启接续）：杀掉进程重启后自动接续，注入 recovery note。
- **P5**（设置页 + i18n + e2e）。

每阶段独立可发版；P1 不依赖后续阶段。

## 9. 明确不做

- 不做「无限重试」。最长等待有硬上限。
- 不做「跨 provider 自动切换模型」（换模型可能改变行为，且与用户显式选择冲突；需要时另立专项）。
- 不改 SDK 自带重试的默认值（那是短抖动的第一道防线，改动影响全局）。
- 不把 `terminal`/鉴权类错误当挂起——那类必须让用户看见。
- 不在挂起期间保持 SSE 常连；客户端靠会话状态接口 + 现有 running-events 心跳感知恢复。

## 10. 风险

1. **用户消息落盘时机**（§5）——实现前必须实测，否则可能重复或丢消息。
2. **wrapper 驱逐与恢复竞态**：调度器与用户同时恢复同一会话，需要按 `sessionId` 的启动锁（`globalThis.__piStartLocks` 已有）。
3. **quota 类误判**：额度错误有时是永久的（账户欠费），挂起到 24h 才报错会让用户困惑 → 记录里标注「额度类」，UI 文案与 outage 分开，并允许用户在设置里关闭额度等待。
4. **rpc-manager 钩子位置**：`agent_end` 早于 compaction/队列收尾，不能在该分支做重活；只写记录、由调度器异步推进。
5. **与 Teams 的叠加**：lead 失败已有 `agent-teams-unattended` 兜底（提醒 2 次），本专项**不改** Teams 路径，避免两套重试叠加；成员失败仍交给 lead 决策。

## 11. 文件清单

新增：`lib/outage/{types,classify,store,scheduler,resume,rpc-hook}.ts`、`app/api/outage/route.ts`（状态查询 + 取消 + 设置）、`components/OutageSettings.tsx`、`docs/agents/fork-provider-outage.md`（本文件）。
改动：`lib/rpc-manager.ts`（1-2 行钩子 + 状态投影）、`lib/goal/goal-extension.ts`（挂起判断）、`lib/autofix/{runner,types}.ts`（不计轮次 + 新状态）、`lib/scheduled-tasks/runner.ts`（不计失败）、`instrumentation-node.ts`（启动调度器）、`components/tasks/TasksView.tsx`、`components/SettingsUi.tsx`、`lib/i18n/locale-plugins.ts`。
