# 后台命令与常驻会话（fork）

> 来源：DeepSeek 团队《Super-agent 设计探索：更自主的 Agent 系统怎么搭》里两条还没有对应物的机制——
> **「等人这件事得从循环里去掉」**（异步工具调用）与 **「常驻 Router」**。
> 本仓既有 agent-teams 已覆盖「Router + Worker 分派」的主体，本轮只补它缺的那两块。

两个功能互相独立，可以分开关：
| 扩展名 | 关掉它 | 失去什么 |
|---|---|---|
| `pi-background-jobs` | `-builtin:pi-background-jobs` | `bash_background` / `get_background_job` / `stop_background_job` |
| `pi-pinned-sessions` | `-builtin:pi-pinned-sessions` | Router 提示注入；**常驻仍然生效**（注册在 store 层） |

---

## 1. 后台命令（`lib/background-jobs/`）

### 为什么不能改 SDK

SDK 的工具契约是硬 `await`（`pi-agent-core/dist/agent-loop.js` 的 `await prepared.tool.execute(...)`），
`ToolDefinition` 只有 `sequential` / `parallel` 两种执行模式，没有超时也没有后台。改 SDK 需要
动 `agent-loop.js` 与 `types.d.ts` 的契约，而 node_modules 会被 install 覆盖（本仓没有 patch-package），
所以这一层落在应用侧。

### 做法

`bash_background` **立即返回** job id 与日志路径，进程在后台跑；跑完把结果作为**新消息**注入会话：

```
execute → startBackgroundJob() → 立刻 return {jobId, logPath}
                                    ↓ (spawn shell, detached)
                          stdout/stderr → jobs/<id>.log（8 MB 封顶）
                                    ↓ exit / timeout / stop
                          writeJob() → sendCustomMessage({deliverAs:"followUp", triggerTurn:true})
```

三条必须守住的纪律：

1. **输出不进上下文**。全量进 `jobs/<id>.log`，注入消息只带尾部 4 KB 与路径。
   否则一条 `npm run build` 能撑爆上下文。
2. **生命周期落盘**。记录在 `~/.pi/agent/pi-web/jobs/<id>.json`（原子写 0600），不放 `globalThis`。
   `subagent-runtime` 的 `__piSubagentRuns` 只在内存里、重启即丢——那是既有缺陷，这里不重复。
   落盘后上个进程遗留的 `running` 由 `settleOrphanedJobs()` 在启动时结算成 `interrupted`。
3. **杀进程树**。Unix `detached:true` + `process.kill(-pid)`；Windows `taskkill /T /F`。
   只杀 shell 会让 `node` 变孤儿。与 SDK 前台 bash 同策略。

### 时序竞态

`exit` / 超时 / `stop` 三路都会到达 `finish()`，由 `ActiveJob.settled` 保证**先到者赢**，
后到者只看不改。否则一次 stop 之后一条迟到的 `exit` 会把终态改回 `completed`，用户看到自相矛盾的结果。

### 与审批的接线

`bash_background` 执行的仍是任意 shell 命令，必须进审批范围，否则等于开了一条绕过审批的后门。
`lib/tool-approval/policy.ts` 的 `SHELL_TOOLS` 因此包含它——既有测试
`policy.test.mjs` 里有一条专门反向断言这件事。

### 对外出口

- 模型：三个工具（见上表）。
- UI / 手机：`GET /api/background-jobs`（列表）、`GET ?id=`（单条 + 输出尾部）、
  `POST ?id=`（停止；已结束的 job 返回 409，不谎报「停掉了」）。

### 已知边界

- 前台 `bash` 仍同步等待，语义未改——只有显式调用 `bash_background` 才异步。
- 后台进程随服务进程一起死（`detached` 只脱离进程组，不脱离系统会话）；
  重启后记录被结算成 `interrupted`，**不会**自动续跑。
- 输出是「字符流合并」，stdout 与 stderr 交错写入同一文件，没有做行级分色。

---

## 2. 常驻会话与 Router 角色（`lib/pinned-sessions/`）

### 常驻 = 不被 idle 驱逐

不需要改 `rpc-manager`：两条驱逐路径都已经会问
`hasActiveSessionLivenessProvider()`——`resetIdleTimer()`（10 分钟闲置卸载）与
`idleCapCandidate()`（闲置会话数量上限）。它存在的目的正是
「Register session-scoped work that must survive pi-web's automatic idle eviction」
（`lib/session-liveness.ts`）。

所以 pin 的实现就是给会话注册一个 `isActive: () => true` 的 provider。

**最关键的一点：注册必须能被重建。** provider 只活在进程的 globalThis registry 里，
进程重启就全没了。补注册有两个时机，缺一不可：

| 时机 | 位置 | 作用 |
|---|---|---|
| 服务启动 | `instrumentation-node.ts` | 进程级恢复 |
| 会话 `start_session` | `lib/pinned-sessions/extension.ts` | 新开/重开的会话 |

`ensurePinnedRegistrations()` 是幂等的对齐函数：名单里有的注册、没有的释放。
名单文件读坏时它**不动**已注册的会话——宁可多留一会儿，也不要误释放。

### Router 角色

`role: "router"` 的会话在 `before_agent_start` 里被注入 `sections["pinned-router"]`，
内容是 `ROUTER_GUIDE`：**常驻视角 / 派活别自己动手 / 必须 `run_in_background` / 不要轮询 / 汇总而非转述**。

为什么是提示而不是剥夺工具：剥夺会让用户在 router 会话里连看一眼文件都不行；
本轮目标是「先能跑」，不是「用户无感 Session」。工具集仍由 `lib/tool-presets.ts` 与用户选择决定。

Worker 不新建任何东西：复用既有 subagent（`Agent(run_in_background)`），
完成后由 `notifyParent` 自动回流——这条链路早就在，Router 提示只是告诉模型去用它。

### 存储

`~/.pi/agent/pi-web/pinned-sessions.json`：`{ version: 1, sessions: [{sessionId, role, note?, pinnedAt}] }`，
原子写 0600。坏结构**抛错而不是当作空表**——静默读空会让用户的 pin 全部消失。

### 对外出口

- `GET /api/pinned-sessions`：名单 + 每条的 `registered`（本进程是否真的持有注册）。
- `PUT`：`{sessionId, role, note?}`。
- `DELETE ?id=`：取消。
- UI：侧栏「常驻」分区（`components/SessionSidebar.tsx`，可折叠、30s 轮询、行尾 × 取消）
  + 设置 › 通用 › Always on（`components/PinnedSessionsSettings.tsx`，选会话与角色）。

### 已知边界

- 常驻不占额外资源上限：pin 得越多，闲置就被钉住的越多。当前没有上限，
  设置页会在条目上显示 `registered`，但没有做总量告警。
- 常驻会话「一直在」但**不会自己跑**——没有 Trigger 就没有主动行为，见第 3 节。
- 没做「用户无感 Session」的 UI 改造：这是项目级工程，不在本轮范围。

---

## 3. 还没有做的（明确记录，避免重复讨论）

| 能力 | 现状 | 缺口 |
|---|---|---|
| Trigger 事件驱动（IM / 邮件 / CI / PR 评论） | `lib/scheduled-tasks/` 只能跑落盘的 cron/once 任务，没有任意 payload、没有幂等键；全仓无 webhook | 来源适配器、白名单快路径、Trigger/Thread 不可变存储与去重、语义层判定；**且必须先补入站鉴权（签名 + 幂等 + 来源白名单）**，现有 `/api/agent/*` 只有 `proxy.ts` 的 Host/Origin 校验 |
| 多 Worker 的 Router 常驻调度 | agent-teams 的 lead 已能做（13265 行），pin + router 提示补上「不掉线」 | 「用户无感 Session」的 UI |
| 异步 start/stop 的通用化 | 本轮只做了 shell | 把同一 job 层套到任意工具需要 SDK 层面的契约改动 |