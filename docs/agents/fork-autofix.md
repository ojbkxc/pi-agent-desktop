# 自动修 Bug（fork-autofix）

用户给一句任务说明（例如「这个 bug 不修好，CI 过不去」），AI 自动反复迭代代码，直到
**验证命令 exit 0** 或撞轮次上限。参照 dsh-superagent 的 Executor（每任务一个 Session +
一个工作目录），在 pi-web 里落成「一个 agent 会话 + 引擎侧判据回路 + 进度落盘 + 任务页」。

## 为什么判据在引擎侧

模型自称「修好了」不可信。每一轮 agent 回合结束（`prompt_done`）后，由 `lib/autofix/verify.ts`
在本机跑 `verifyCommand`：

- exit 0 → `succeeded`；
- 非 0 / 超时 → 记录本轮 `verify-failed`，把失败摘要与输出尾喂回下一轮 prompt；
- 回合本身出错（`prompt_error` / `stopReason: "error"`）→ 记 `agent-error` 轮，直接进下一轮；
- 阻断型扩展对话框（confirm/select/input/editor/custom）→ 无人值守没人回答，立即中止并落
  `stopped`，`lastError` 说明去打开会话。

`verifyCommand` 未显式给时从 `<cwd>/package.json` 的 scripts 探测，顺序 test → typecheck →
check → lint；探测不到就拒绝建任务（没有判据的自动修 Bug 没有意义）。

## 模块

| 文件 | 职责 |
| --- | --- |
| `lib/autofix/types.ts` | 类型、默认值/上限、纯判定（孤儿/汇总）、`AutofixValidationError`。客户端可 import |
| `lib/autofix/prompt.ts` | 第 1 轮完整指令、第 2 轮起带失败输出尾（纯函数） |
| `lib/autofix/detect.ts` | 从 package.json 探测验证命令（纯函数 + 读文件） |
| `lib/autofix/store.ts` | `<agent dir>/autofix/tasks/<uuid>.json` 原子读写、上限裁剪 |
| `lib/autofix/verify.ts` | `spawn` 跑验证命令，exit code / 超时 / 输出尾 |
| `lib/autofix/runner.ts` | 驱动循环、认领、停止/继续、`resumeAutofixTasks` / `summarizeAutofixTasks` / `startAutofixSweepLoop`、生产 deps |
| `lib/autofix/events.ts` | globalThis 事件总线（SSE） |
| `lib/autofix/client.ts` | 浏览器侧 API 封装（只 import 类型） |
| `app/api/autofix/route.ts` | GET 列表+汇总 / POST 建任务并开始修 |
| `app/api/autofix/[id]/route.ts` | GET 单任务 / POST stop·resume / DELETE |
| `app/api/autofix/resume/route.ts` | POST 手动触发一次接续扫描 |
| `app/api/autofix/events/route.ts` | SSE：只说「变了」，客户端防抖重拉列表 |
| `components/AutofixView.tsx` | 任务页（任务说明 → 启动 → 轮次/日志） |
| `components/AutofixSidebarRow.tsx` | 侧栏入口（活跃数 badge） |
| `hooks/useAutofix.ts` | 共享 store + 共享 SSE（与 `useScheduledTasks` 同模式） |

## 进度持久化与接续（与挂机保活 t4 的约定）

`~/.pi/agent/autofix/tasks/<uuid>.json`（`getAgentDir()` 根，遵守 `PI_CODING_AGENT_DIR`），
`writePrivateFileAtomicSync` 原子写。关键字段：`task` / `cwd` / `verifyCommand` / `status` /
`round` / `maxRounds` / `lastError` / `sessionId` / `pid` / `createdAt` / `updatedAt` /
`finishedAt` / `rounds[]`（capped 50）。

接续口径（`isAutofixTaskResumable`）：

- 活跃状态 = `queued | running | verifying`；
- `pid` 是**驱动进程**（Next server 进程，`process.pid`），不是 agent 会话进程；
- pid 活着 → 永不判孤儿（长回合可能超过任何心跳阈值）；pid 死 → 立即可接续；
- pid 缺失 → `queued` 立刻可接续，其余要 `updatedAt` 超过 `staleMs`（默认 10 分钟）。

出口：`resumeAutofixTasks({ staleMs: 600_000 })`（不抛错、幂等、并发上限 1）与
`summarizeAutofixTasks()`（只读汇总）。进程级自愈由 `startAutofixSweepLoop()`（start 立即扫
一次 + 每 60s，挂在 `instrumentation-node.ts`，与 `startScheduler` 同一开关族
`PI_WEB_DISABLE_SCHEDULER=1`）。挂机保活只读该目录做「待接续 N 个」展示，驱动全部由本模块承担。

## 会话

每个任务一个修复会话：新建时钉工具集 `read/bash/edit/write/grep/find/ls`
（`AUTOFIX_TOOL_NAMES`）、写 `pi-web:autofix` 自定义条目、命名 `Autofix · <任务首行>`。
已有 `sessionId` 时先看进程内会话，再按会话文件重开（对话上下文继续）。任务页「打开会话」
直接把用户带到这个会话。

## 驱动进程的并发与认领

- 进程内驱动表（globalThis）按 taskId 去重；`startAutofixTask` 重复调用返回同一 promise；
- `driveAutofixTask` 认领：置 `running` + `pid=process.pid` 后**复核**落盘结果，另一活着的
  进程正在驱动时直接放弃（照 `acquireLease` 的写法）；
- 同时驱动的任务数上限 1（多任务同 cwd 会抢端口/抢测试文件）；其余保持 `queued` 由下一
  次 tick 接手。

## 环境与测试缝

- `PI_WEB_DISABLE_SCHEDULER=1`：不启动 sweep 循环（与调度同族，测试/e2e 全静默）。
- `PI_WEB_DISABLE_AUTOFIX_DRIVER=1`：`startAutofixTask` 直接 no-op（单测里建任务但不真去
  建会话/跑 npm test）。
- 单测：`lib/autofix/{store,runner,prompt}.test.mjs`、`app/api/autofix/autofix-routes.test.mjs`
  （临时 `PI_CODING_AGENT_DIR`，绝不碰真实 `~/.pi/agent`）。

## UI

侧栏「自动修 Bug」行 → AppShell 覆盖视图（`?view=autofix`，照 Scheduled/Tasks 的形状）。
页面复用 `.scheduled-*` 的壳与卡片样式，只有轮次日志与「最近错误」一行是新的
（`app/native-theme.css` 的 `.autofix-*`）。文案全部在 `lib/i18n/locale-plugins.ts` 的
`FORK_MESSAGE_PATCHES`（en / zh-CN / zh-TW）。状态与轮次状态的 `t()` 一律用字面量 key
（不用模板拼键），静态调用点门禁可见。

## 安全边界

`verifyCommand` 来自用户输入，等价于本机终端执行 —— 与 Scheduled 任务同一信任模型：路由
只接受本机受信请求（`isApiRequestAllowed`，公网隧道下同样要求 web 密码），长度上限 500，
超时会杀子进程（SIGTERM 后 5s SIGKILL 兜底）。修 bug 会话本身有 shell 工具，与普通会话同权限。