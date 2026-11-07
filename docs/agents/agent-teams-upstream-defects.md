# pi-team 上游缺陷与宿主↔扩展契约缺口

面向 pi-agent-desktop 的 `pi-team` 扩展评审清单。**证据行号按实际阅读时核对**，标注
pi-team 版本 **0.2.0**（`node_modules/pi-team/package.json`）；pi-team 升级后行号可能偏移，
以当时源码为准。

每条固定四段：**现象** / **复现路径** / **证据** / **影响 + 修复方向**。
修复方向**只给方向、不给可直接套用的补丁**——补丁会被误当成已修。

排序原则：会让人**误判成功**的 > 会让**功能不可用**的 > **一致性/口径** > **设计取舍**。
这是评审结论，不是发现顺序。

> 与上游评审初稿的差异（以本文件为准）：
> - 「`resolveTeamHost()` 在桌面恒返回 noop 桥」**不成立**。桌面始终给 `createPiTeamExtension(pi, host)`
>   显式传 host（真桥或 `createUnavailableTeamHost`），`teamHost.js:148-149` 的 `explicit` 分支优先，
>   走不到 `createNoopHost`。真正成立的是「宿主桥的 `stop` 会抛/静默，被 release 吞掉」（见 A1）。
> - 「M4 `findTeamPlanForSession` 永不命中」**降级**：它是死代码，无实际后果；真后果是跨会话隔离失效，
>   已并入 B1。仓库内零调用（`grep -rn findTeamPlanForSession lib app components` 无命中）。
> - 「H5 plan 独有成员在名册/泳池完全不可见」**是误报**：宿主 `buildRoster` 已合并（有测试）。
>   真缺口只剩「**工具侧**看不到」，与 M1 同根因，已合并为 B2。
> - 「`team_permission_update` 被列进工具名集合」的**证据在宿主侧**（`lib/builtin-extensions.ts:420`），
>   不在 pi-team dist；因此归入 B4（一致性），不归 A 类。

---

## 一、pi-team 包内缺陷（只能改 pi-team 仓库根治）

### A1. `getLifecycle()` 有副作用 + `release()` 吞掉 `host.stop` 异常 → 「停成功」的假象 ★最危险

- **现象**：调用者以为停掉了成员/团队，实际会话可能仍在跑。`release` 正常返回 ≠ 会话已停。
  更隐蔽的是：任何「探测某团队是否有活实例」的代码一旦调用 `getLifecycle(teamName, host)`，
  就会**顺手创建一个空实例并注册**，此后该实例一直存在。
- **复现路径**：① 对不存在的团队调用 `getLifecycle(name, host)` → 注册表多出一个空实例；
  ② 对成员调用 `release()`，而宿主桥 `stop` 抛错（如未启用子 agent 时）→ 异常被吞，`release` 仍返回 entry。
- **证据**（pi-team 0.2.0）：
  - `node_modules/pi-team/dist/teamLifecycle.js:291-299`：`getLifecycle` 在不存在时 `new TeamLifecycle(...)` 并 `registry.set`。
  - `node_modules/pi-team/dist/teamLifecycle.js:182-199`：`release` 先 `#apply` 写 status，再
    `try { await this.#host.stop(entry.sessionId) } catch { if (process.env.PI_TEAM_DEBUG) console.error(...) }`
    —— 异常只在 debug 下打印，调用方拿不到失败。
  - 宿主侧 `lib/pi-team-host.ts:183-205`：`createUnavailableTeamHost().stop()` **抛错**
    （`内置子 agent 未启用，无法停止成员`），正好落进上面的 catch；
    pi-team 自带的 `teamHost.js:8-33` 的 `createNoopHost().stop()` 同样抛错。
- **影响 + 修复方向**：这是最容易被误判为成功的一组。根治需 pi-team：把「查/建」拆开
  （探测不得产生实例），并让 `release` 把 `host.stop` 的失败**上报**（返回值或抛错）而非吞掉；
  在此之前宿主只能靠**读回执**（lifecycle status + generation）判断真停，不能信 `release` 没抛。

### A2. 配额计数错：数的是 **config 名册人数**，不是「活跃 worker」

- **现象**：`spawn=false` 的成员、早已退出的成员都被计入上限；且是**跨团队**口径。
  per-team 12 拦得住单团队失控，拦不住跨团队超卖。
- **复现路径**：建多个团队（含 `spawn=false` 或已停的成员），累计名册人数逼近 32 → 新派发被
  `LIMIT_EXCEEDED` 拒绝，尽管实际活跃 worker 很少。
- **证据**：`node_modules/pi-team/dist/teamTools.js:34-50` 的 `countActiveWorkers` 累加
  `teamFile.members.filter((m) => m.name !== TEAM_LEAD_NAME).length`（**名册长度**，非生命周期活跃数）；
  `teamTools.js:57-71` 的 `checkSpawnLimits` 并用它做全局口径；调用点在
  `teamTools.js:287`（create）与 `teamTools.js:441`（launch）。
- **影响 + 修复方向**：上限名不副实。根治需 pi-team 改成按生命周期里的**活跃/运行态**计数
  （lifecycle status），并把口径写进错误文案；宿主侧无法在不改包的前提下纠正。

### A3. `team_delete` 之后，孤儿会话从配额里「隐身」

- **现象**：删团队只删磁盘数据，**不停会话**；此后这些仍在跑的会话不再计入全局配额。
- **复现路径**：建团队并派发成员 → `team_delete` → 成员会话仍在运行，但全局计数已不含它们 →
  可以继续派发直到真实资源被撑爆。
- **证据**：`node_modules/pi-team/dist/teamTools.js:516-527`（`team_delete` 只做
  `dropBus(name); dropLifecycle(name); await deleteTeamDir(name);`，无 `host.stop`）；
  计数侧 `countActiveWorkers`（A2 同证据）依赖 `listTeamNames()`，目录删了就统计不到。
- **影响 + 修复方向**：与 A2 叠加。根治需 pi-team 要么在删除前编排停会话，要么让配额统计
  不依赖「团队目录是否还在」。宿主侧的兜底是删除前自行逐成员停（见 A6：包内没有团队级 stop）。

### A4. `team_cancel` 双重 stop

- **现象**：一次 `team_cancel` 对同一会话触发两次停止。
- **复现路径**：对某成员调用 `team_cancel`。
- **证据**：`node_modules/pi-team/dist/teamTools.js:759` 调 `env.lifecycle.release(member, {tombstone:true})`，
  而 `release` 内部**已经**停一次（`teamLifecycle.js:191`）；随后 `teamTools.js:763` 又显式
  `await host.stop(sessionId)` 停第二次。
- **影响 + 修复方向**：多数宿主 `stop` 幂等，但会放大「stop 抛错被吞」的噪声（A1）。根治需
  pi-team 二选一（release 或显式 stop），别都做。

### A5. `dropLifecycle` / `dropBus` 未从包根导出 → 宿主删团队后清不掉注册表

- **现象**：宿主删团队后无法释放 pi-team 进程内的 lifecycle/bus 注册表项；**同名团队重建会复用旧实例**。
- **复现路径**：删团队（宿主侧直接删目录，而非走 pi-team 工具）→ 重建同名团队 → 新的
  `getLifecycle`/`getBus` 命中旧实例。
- **证据**：`node_modules/pi-team/dist/index.js:6,12,37,40-42` 只导出
  `PI_TEAM_EXTENSION_NAME` / `default` / `createPiTeamExtension` / `setInjectedHost` /
  `resolveTeamHost` / `getLifecycle` / `getBus`；`dropLifecycle`（`teamLifecycle.js:301-305`）与
  `dropBus`（`teamBus.js:396`）存在于 dist 但**未再导出**。
- **影响 + 修复方向**：宿主只能照抄那两行实现（`registry.get(name)?.dispose(); registry.delete(name)`），
  属于「绕」。根治需 pi-team 在根导出 drop*。

### A6. 工具集不含团队级 stop/release

- **现象**：没有「停止整个团队」的工具，也没有 `release` 工具；宿主只能逐成员编排，容易漏。
- **复现路径**：想一次性停掉一个团队 → 只能 `team_cancel` 逐个成员。
- **证据**：`node_modules/pi-team/dist/teamTools.js` 注册的工具集为 `team_create`(:~220)、`team_delete`(:508)、
  `team_message`(:~536)、`team_plan`(:~324)、`team_status`、`team_ticket`、`team_wait`、`team_result`、
  `team_cancel`(:744) 等；无团队级 stop/release。
- **影响 + 修复方向**：设计取舍（设计文档 §8 未列团队级停止）。若要根治，pi-team 应提供团队级
  stop/release 并保证回执。

### A7. M2：卡死重建只在 **config.json 本体**残留时发生

- **现象**：`team_create` 重名报「已存在」，但判据是「config.json 能否解析成合法团队文件」，
  不是「目录是否存在」。
- **复现路径**：① 目录在、`config.json` 损坏/缺失 → `readTeamFileAsync` 返回 `null` → **可重建**；
  ② 只剩一份**合法但过期**的 config.json → 报「已存在」，无法重建。
- **证据**：`node_modules/pi-team/dist/teamTools.js:253-255`（`const existing = await readTeamFileAsync(name); if (existing) return 已存在`）；
  `teamHelpers.js:82-95`（`readTeamFileAsync` 解析失败/ENOENT 返回 `null`）。
- **影响 + 修复方向**：语义合理但反直觉，需在文档/文案里写明。根治方向：pi-team 明确「存在」的定义
  （目录 vs 合法 config），并让报错给出可操作提示。

### A8. 幂等静默失败（H4）：哪些操作同 id 幂等、失败时怎么表现

- **现象**：`team_plan approve` 强制 `request_id`，同 id 重复批准**不报错**，而是返回「已记录过」，
  `committed=false`。调用方若只看「没抛错」会以为这次批准生效。
- **复现路径**：用同一个 `request_id` 连续 `approve` 两次 → 第二次不重复提交，返回不同的
  成功文案（`该批准已记录过…未重复提交`）。
- **证据**：`node_modules/pi-team/dist/teamTools.js:416`（缺 `request_id` 直接拒绝）、
  `teamTools.js:420-422`（`approveTeamPlan(...)` 返回 `{plan, committed}`；`!committed` 走
  「已记录过」分支）。
- **影响 + 修复方向**：本质是「幂等成功」与「首次成功」文案一致度高，调用方需**读 `committed`
  或 state**，不能只看是否报错。根治方向：pi-team 在返回值/结构化字段里显式区分
  `alreadyApplied`，而不是靠文本。

---

## 二、宿主 ↔ 扩展契约缺口（桌面侧能绕 / 能补）

### B1. `PI_SESSION_ID` 在服务器进程恒未设置 → `leadSessionId` 恒为 `'unknown-session'` → 跨会话隔离失效

- **现象**：任何带 lead 身份的会话（**别的团队的 lead**，或没有团队身份的**普通项目会话**）都能操作
  任意团队的 plan；隔离判据形同虚设。
- **复现路径**：会话 A 建团队 1、会话 B 建团队 2；在 B 里用 `team_plan` 指向团队 1 —— 因为
  `team.leadSessionId` 对两队都是 `'unknown-session'`，`incarnation()` 的隔离判据恒为真，操作被放行。
- **证据**：
  - `node_modules/pi-team/dist/teamTools.js:261`：`leadSessionId: process.env.PI_SESSION_ID || 'unknown-session'`（建团队时）。
  - `node_modules/pi-team/dist/teamTools.js:373`：`const sessionId = process.env.PI_SESSION_ID || 'unknown-session'`（`team_plan` 时）。
  - `node_modules/pi-team/dist/teamPlanStore.js:39-43`：`incarnation()` 的**唯一**隔离判据是
    `team.leadSessionId !== sessionId` → 恒不成立；`teamPlanStore.js:43` 的 plan 身份哈希还把
    `leadSessionId` 算进去（`JSON.stringify([team.name, team.leadSessionId ?? '', team.createdAt])`）。
  - 桌面进程从不设置它：`grep -rn PI_SESSION_ID lib app` 只命中 `lib/project-command-env.test.mjs:139`，
    那是把会话 id 注入 **`!command` 的 bash 子进程**环境，与**同进程内**的 pi-team 扩展无关。
- **为什么宿主那套身份注入救不了它（关键）**：`PI_AGENT_NAME`/`PI_TEAM_NAME` 是**构造期捕获**
  （`teamTools.js:79-84` 的 `resolveAgentName/resolveTeamContext` + `teamTools.js:86-90` 的
  `createTeamRuntime` 在构造时读一次），所以宿主的「工厂同步窗口 set → 构造期捕获 → restore」有效；
  而 `PI_SESSION_ID` 是在**工具调用那一刻**读 `process.env`（上面 261/373 行），进程内并发多会话
  共用一个 `process.env`，同步窗口无效。**根治只能改 pi-team**：让它从 `ExtensionContext`（工具 ctx）
  里取当前会话 id，而不是读进程 env。
- **影响 + 修复方向**：当前是**潜在雷**（提示词从未引导跨团队操作），但契约层面已破。桌面侧无法
  可靠补（写 `process.env` 会串号）；只能先用文档约束、并在 UI/提示词层面避免跨团队操作。

### B2. `config.json` 是唯一权威名册 → **工具侧**看不到 plan 独有成员（合并原 H5 + M1）

- **现象**：`team_plan launch` 派发但**没写进 config.json** 的成员，`team_message` 直接失败说
  「不是该团队成员」；`team_status` / `/team` 也漏他们；配额口径同样漏（叠加 A2）。
  但**泳道/UI 能看到**他们——因为宿主已合并。
- **复现路径**：用 `team_plan` 提交并批准、`launch` 派发一个只在 plan 里、从没进 config 名册的成员 →
  对该成员 `team_message` → 报「不是该团队成员」。
- **证据**：
  - pi-team 侧：`node_modules/pi-team/dist/teamTools.js:555-561`（`team_message` 用
    `team.members.find((entry) => entry.name === params.recipient)` 从 **config 名册**查，查不到即失败）；
    `teamTools.js:516-527` 的 `team_delete`/名册相关路径同样只认 config。
  - 宿主侧已兜住 UI：`lib/agent-teams-swimlane.ts:407` 的 `buildRoster`（在 `:492` 使用）合并
    config 名册 + plan 成员；测试 `lib/agent-teams-swimlane.test.mjs:105-139`
    （「plan 独有成员出现在名册并可被票认领」，`:127`/`:130`/`:138` 断言）。
  - 原「H5：完全不可见」是**误报**——此宿主已修。
- **影响 + 修复方向**：真缺口落在**工具侧**（pi-team 只认 config）。根治需 pi-team 的消息/状态/配额
  统一走一份「config ∪ plan」的合并名册。宿主侧能补的是**在派发时把 plan 成员补写进 config**，
  但这会与 pi-team 的「config 是权威」假设打架——建议先在设计文档固化口径，别急着绕过。

### B3. `PI_TEAM_NAME` 口径陷阱：**原始名** vs **目录名**

- **现象**：任何假设「PI_TEAM_NAME == 目录名」的外部代码都会错——目录名是 sanitize 过的。
- **复现路径**：团队名含中文/符号（如「前端队」）→ 目录是 `---`；拿目录名回填 `PI_TEAM_NAME`
  会让名字语义错位（展示、对账、回填都会怪）。
- **证据**：
  - `node_modules/pi-team/dist/teamTools.js:~235`（`team_create` 的 `team_name` 参数）与
    `teamTools.js:299` 附近的派发：把**未 sanitize** 的 `params.team_name` 交给
    `host.start({ teamName: name })` 作为 `PI_TEAM_NAME`。
  - `node_modules/pi-team/dist/teamHelpers.js:36-46`：`getTeamDir(teamName) = join(getTeamsDir(), sanitizeName(teamName))`
    —— 目录名只在**查找时**由 `sanitizeName` 得出，从不回写。
  - 宿主对齐：`lib/rpc-manager.ts:2885` 的 `resolveTeamMemberIdentity` 取 `config.json` 的 `name`
    （原始名），而不是目录名。
- **影响 + 修复方向**：契约边界（pi-team 不导出「名 ↔ 目录」的显式映射）。宿主侧已按原始名对齐；
  修复方向是**文档化**该口径（已在 `resolveTeamMemberIdentity` 注释写明），并警惕任何新代码走「目录名当团队名」。

### B4. 成员工具名集合列入了**消息类型**（一致性）

- **现象**：`MEMBER_TEAM_TOOL_NAMES` 里有 `team_permission_update`，但它只是**协议消息类型**，
  pi-team 并未注册同名工具。
- **复现路径**：审阅成员工具白名单时看到该项；实际无对应工具，属于「名单里有个不存在的东西」。
- **证据**：宿主侧 `lib/builtin-extensions.ts:411-420`（列表含 `team_permission_update`）；
  pi-team 侧它只是消息类型——`node_modules/pi-team/dist/message-protocol.js:34`
  （`TEAM_PERMISSION_UPDATE: 'team_permission_update'`），dist 里**没有**同名工具注册。
- **影响 + 修复方向**：功能上无害（白名单多一项），但误导维护者。方向：从 `MEMBER_TEAM_TOOL_NAMES`
  移除，或在注释里标明它是消息类型而非工具。**证据在宿主侧，故归此而非包内缺陷。**

### B5. 桌面改成员模型不更新 `plan.approvedSnapshot`

- **现象**：桌面「改成员模型」只写 `config.json`；pi-team 那份负责「快照与活记录一起改」的函数
  从未被调用 → 重启后成员按 `approvedSnapshot` 重建，模型**回退到批准时的旧值**。
- **复现路径**：批准并运行的团队 → 桌面改某成员模型 → 重启/成员被重建 → 模型变回旧值。
- **证据**：
  - pi-team 提供并**同时**改两处：`node_modules/pi-team/dist/teamPlanStore.js:204-236`
    （`setRunningMemberRuntime` 同时更新 `members` 与 `approvedSnapshot.members`）。
  - 桌面的写路径**只动 config**：`lib/agent-teams-swimlane-store.ts:367` 的
    `applyTeamMemberModelChanges`（读-改-写 `config.json` + 投递 `set_model`），
    仓库内**无** `setRunningMemberRuntime` 调用（`grep -rn setRunningMemberRuntime lib app components` 无命中）。
- **影响 + 修复方向**：口径不一致导致「改了又退回去」。方向：桌面改模型时**同时**改 plan 的
  `approvedSnapshot`（或让 pi-team 的写路径成为唯一入口）。**这是宿主侧能补的**，优先于 A 类。

---

## 附：本次核对的证据清单（pi-team 0.2.0）

| 文件 | 关键行 | 用途 |
|---|---|---|
| `dist/teamTools.js` | 34-50, 57-71, 287, 441 | 配额计数与上限检查（A2） |
| `dist/teamTools.js` | 253-255 | `team_create` 重名判据（A7） |
| `dist/teamTools.js` | 261, 373 | `PI_SESSION_ID` 恒 `unknown-session`（B1） |
| `dist/teamTools.js` | 416, 420-422 | `approve` 幂等静默（A8） |
| `dist/teamTools.js` | 516-527 | `team_delete` 不停会话（A3） |
| `dist/teamTools.js` | 555-561 | `team_message` 只查 config 名册（B2） |
| `dist/teamTools.js` | 759, 763 | `team_cancel` 双重 stop（A4） |
| `dist/teamPlanStore.js` | 39-43 | `incarnation()` 隔离判据（B1） |
| `dist/teamPlanStore.js` | 204-236 | `setRunningMemberRuntime` 同步快照（B5） |
| `dist/teamLifecycle.js` | 182-199, 291-299, 301-305 | release 吞错 / getLifecycle 副作用 / drop 未导出（A1, A5） |
| `dist/teamBus.js` | 396 | `dropBus` 存在但未导出（A5） |
| `dist/teamHost.js` | 8-33, 136-143, 147-155 | noop 桥 stop 抛错 / 注入 / 解析（A1） |
| `dist/index.js` | 6, 12, 37, 40-42 | 根导出面（A5） |
| `dist/message-protocol.js` | 34 | `team_permission_update` 是消息类型（B4） |
| `lib/pi-team-host.ts` | 183-205 | `createUnavailableTeamHost` 的 stop 抛错（A1） |
| `lib/builtin-extensions.ts` | 411-420 | `MEMBER_TEAM_TOOL_NAMES`（B4） |
| `lib/agent-teams-swimlane.ts` | 407, 492 | `buildRoster` 合并名册（B2） |
| `lib/agent-teams-swimlane.test.mjs` | 105-139 | plan 独有成员进名册的测试（B2） |
| `lib/rpc-manager.ts` | 2885 | `resolveTeamMemberIdentity` 取原始名（B3） |
| `docs/agent-teams-design.md` | 912 | 成员工具集的设计取舍 |
