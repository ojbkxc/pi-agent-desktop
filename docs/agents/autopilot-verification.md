# 无人值守（Autopilot）链路验收清单

本文件记录「定时任务失败 → 自动修复」与「团队计划自动批准」两条无人值守链路的
验收口径，并**明确区分**已进程内自动化覆盖的部分与必须人工在真实环境跑的部分。

设置来源：`<agent dir>/pi-web/settings.json` 的 `autopilot` 段。
`enabled`（总开关，默认开）、`autoFixFailedRuns`、`autoApproveTeamPlans`、
`maxAutoFixRounds`（1–50）。手动会话永远走人工评审，不受这些开关影响。

## 一、已自动化覆盖（进程内，`node --test`）

| 链路 | 测试 | 断言要点 |
| --- | --- | --- |
| 定时任务失败 → 建 autofix | `lib/scheduled-tasks/autopilot-e2e.test.mjs` | 真 `Scheduler.tick()` + 真 autopilot 设置读取 + 真 autofix store/detect；失败运行后恰建 1 条 autofix 任务，文本带 `[scheduled:<taskId>:<runId>]` 标记，`verifyCommand` 探测为 `npm test`，`cwd` 正确，`maxRounds` 取自设置，注入的 `autofixStart` 收到该任务 id |
| autopilot 关闭不建任务 | 同上 | 总开关关闭 / `autoFixFailedRuns` 关闭时均不建任务、`autofixStart` 从不被调用 |
| 计划自动批准（判定→投递） | `lib/agent-teams-autopilot.test.mjs` | 临时 `PI_TEAM_DIR` + 真 `plan.json`/`config.json` 夹具 + 注入 `deliver`：`review_pending` + 无人值守会话 → 投递批准 prompt 给 lead；同 plan+revision 幂等；手动会话 / 非 review_pending / 投递失败均不批准 |
| 开关门控与设置读取 | `lib/autopilot.test.mjs`、`lib/agent-teams-autopilot.test.mjs` | 总开关 + 子开关 + 会话来源三者缺一不可；设置读写与轮次上限边界 |

**注入点**（生产默认行为不变，仅测试用）：
- `SchedulerOptions.autofixStart`（`lib/scheduled-tasks/scheduler.ts`）：默认仍动态 import 真 runner；
- `autoApproveTeamPlanForSession({ deliver })`（`lib/agent-teams-autopilot.ts`）：默认仍 `defaultDeliver`。

## 二、必须人工验收（真实仓库 / 真实会话）

自动化只到「建出任务 / 判定并投递 prompt」为止；下面几件**依赖真实 agent 会话、
真实验证命令、真实收件箱与通知**，必须在打包环境手跑。

### A. 定时任务失败 → 自动修复 + 收件箱条目
1. 准备一个 git 仓库，`package.json` 里有会失败的 `scripts.test`。
2. 建一个 cron 定时任务指向该目录，先在设置里打开 `autopilot.enabled` + `autoFixFailedRuns`。
3. 等该任务跑一次并失败。
4. 观察点：
   - 侧栏「自动修 Bug」出现一条新任务，状态从 queued → running；
   - 该任务文本含 `[scheduled:<taskId>:<runId>]` 标记；
   - 修复会话真跑 `verifyCommand`，成功落 succeeded，结果进入收件箱；
   - 同一个失败 run 不重复建任务（幂等标记生效）。

### B. 团队计划自动批准（真链路）
1. 由**定时任务或 autofix**发起、带 `PI_WEB` 无人值守标记的会话里，让 lead 产出一个
   `review_pending` 计划。
2. 打开 `autopilot.enabled` + `autoApproveTeamPlans`。
3. 观察点：
   - 计划不再停在「待评审」，lead 自动收到批准 prompt 并执行 `team_plan` approve + launch；
   - 计划卡状态推进（approvedSnapshot 写入、launch.status 从 pending 起走）；
   - 同一 plan+revision 只投递一次。
4. **反例（必须成立）**：在**手动会话**里产出同样计划 → 仍显示计划卡、仍要求人工点
   批准，绝不自动通过。桌面永不自己写 `plan.json`。

### C.（可选）阻塞对话框 120s 默认应答
在无人值守会话里触发一个阻塞式扩展对话框（select/confirm/input/editor），确认约
120 秒后自动取安全默认（取消 / 否 / 空），且手动会话不受影响。

## 三、结论
- 建 autofix 任务、计划批准判定与投递 prompt：**已自动化**（上述表格）。
- 「真实修复引擎跑通验证命令」「lead 真正 approve+launch」「收件箱/推送落地」：
  **必须人工按第二节验收**——它们跨真实 agent 会话与网络，进程内无法可靠复现。