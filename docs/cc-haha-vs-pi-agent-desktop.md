# cc-haha vs pi-agent-desktop 功能对比报告

> 生成日期：2026-11-22。作者：analyst（cc-haha 侧同步与功能对比）。
> 对比基准：cc-haha 最新 main（git clone, depth 1）vs pi-agent-desktop（D:/GitHub/pi-agent-desktop 工作副本）。

---

## 0. 方法与限制（重要）

- 本机 bash 工具在本次会话中不可用（harness 内部错误 `findCommandPattern is not defined`），**无法运行本地 `diff -r` / `git log`**。
- 等效替代：直接读取 `_latest/.git/` 元数据（HEAD、logs/HEAD、packed-refs、config）确认 clone 完整性与 HEAD；commit 消息/日期通过 GitHub API（`api.github.com/repos/NanmiCoder/cc-haha/commits/e6b6e48…`）交叉核验；差异规模用 compare API（`v0.7.8...e6b6e48`，ahead_by=118）+ 关键文件抽样比对（package.json、README.md、src/、desktop/、mobile/、docs/ 目录树逐层 ls 对照）。
- 建议后续 bash 恢复后用 `diff -qr E:/cc-haha-main/cc-haha-main E:/cc-haha-main/_latest` 复核一遍，预期与本文结论一致。

## 1. cc-haha 最新代码状态（任务 1）

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | https://github.com/NanmiCoder/cc-haha.git（branch main，浅克隆完整） | `E:/cc-haha-main/_latest/.git/config`、`.git/HEAD`、`.git/refs/heads/main` |
| HEAD commit | `e6b6e48826ad4ade7e969f9f11e21ea67fdb5526` | `.git/refs/heads/main`；GitHub API 交叉核验一致 |
| 提交信息 | `feat(desktop): support Up/Down arrow prompt history navigation in composer (#1957)` | GitHub API commit JSON |
| 提交时间 | 2026-11-20T16:15:50Z（北京时间 2026-11-21 00:15）；clone 时间约 2026-11-21 11:37 (+0800)，clone 已完成、工作区完整 | GitHub API；`.git/logs/HEAD` |
| 版本号 | `package.json` version = `999.0.0-local`（占位）；实际发布版本：release-notes 最新为 **v0.7.9**（HEAD 在 v0.7.9 发布之后、v0.7.10 开发期） | `E:/cc-haha-main/_latest/package.json:4`；`release-notes/`（最新 `v0.7.9.md`） |

## 2. 旧副本 → 最新 的主要变化点（任务 2）

旧副本 `E:/cc-haha-main/cc-haha-main`（zip 解压，无 .git）的快照定位：

- 其 `release-notes/` 止于 **v0.7.8**（无 `v0.7.9.md`），而 `_latest` 有 → zip 摄于 v0.7.8 发布（2026-11-10，compare API base commit `release: v0.7.8 (#1875)`）之后、v0.7.9 发布之前。
- zip 已包含 v0.7.9 周期的部分功能（如 `desktop/src/components/agentTeams/AgentTeamsRuntimeControls.tsx` 存在），但不含 HEAD 的 `desktop/src/api/promptHistory.ts`（#1957，2026-11-20 才加入）→ zip 处于 v0.7.9 开发周期中后段。
- `v0.7.8...HEAD` 共 **118 个 commit**（GitHub compare API，ahead_by=118）。
- 抽样比对：两侧 `package.json`（含全部 dependencies/scripts）逐行一致；`README.md` 仅差赞助商一句话文案；`src/`、`desktop/`、`mobile/`、`docs/` 顶层目录树完全一致 → 差异集中在源码内容级（v0.7.9 功能与修复），而非结构级。

「旧副本 → 最新」主要变化点（依据 `release-notes/v0.7.9.md` + HEAD commit）：

1. **Agent Teams 运行控制**（#1890/#1951/#1954/#1860）：团队与主任务可暂停/恢复，暂停态持久化、可批量改成员模型、恢复失败可重试，运行中加成员不再卡死。
2. **Claude 官方订阅额度**（#1861/#1949）：设置里显示 5 小时/每周/OAuth 应用额度与重置时间。
3. **应用图标角标**（#1940）：Dock/任务栏显示待审批+未读会话数。
4. **会话 Markdown 导出/复制**（#1908）。
5. **深灰主题 + 可拖拽工作区预览**（#1898/#1889）。
6. **Max output tokens 升级三态开关**（#1897）与**图片上下文自动压缩**（#1893，4K 截图不再体积失败）。
7. 一批稳定性/安全修复：供应商设置互不覆盖、停止立即中止代理流、worktree/分支实时同步、MCP 走代理、H5 控制面鉴权路径规范化、打包修复等。
8. HEAD 新增（zip 之后）：**输入框 ↑/↓ 提示词历史导航**（#1957，新增 `desktop/src/api/promptHistory.ts`）。
9. 手机 App 升级 0.1.5；Claude Code 兼容版本更新至 2.1.321。

## 3. 定位差异（任务 3 前置）

| | cc-haha | pi-agent-desktop |
|---|---|---|
| 本质 | 自研「Claude Code 桌面端工作台」：Electron(桌面) + Bun(服务端 src/) + Expo(手机 App)，从 CLI 到 GUI 到手机全链路自研 | pi 生态桌面壳：Tauri + Next.js，打包 [pi](https://github.com/earendil-works/pi)（agent 内核）+ pi-web（Web UI）+ 自有桌面集成；能力随 pi/pi-web 版本每日自动同步（fork 上游同步流水线） |
| 服务端运行时 | Bun（`bin/claude-haha`、`src/server/`） | Node.js 22（Next.js standalone，`app/api/`） |
| 桌面壳 | Electron（`desktop/electron/`，另有 `desktop/src-tauri/` 目录存在） | Tauri（`src-tauri/`，签名更新器） |
| 平台 | macOS / Windows / Linux（全平台安装包） | macOS(AS) / Windows x64 / Linux x64（无 Intel Mac） |
| 移动端 | 原生 App（Android APK + iOS TestFlight，Expo）+ H5 控制面 | PWA（浏览器/手机浏览器），无原生 App |
| 核心差异 | 全栈自研、功能面更宽（IM、Computer Use、图片生成、手机 App） | 依托 pi 生态：上游自动同步/签名更新/分支会话/fork 管理等工程化能力独特 |

## 4. 能力对照表

图例：✅ 有 ｜ ⚠️ 部分/形态不同 ｜ ❌ 无。「实现方式差异」指同类能力两侧的做法区别。

| 维度 | cc-haha | pi-agent-desktop | 实现方式差异 |
|---|---|---|---|
| 会话/工作台 | ✅ 多会话+全局搜索、分支/Worktree 启动、Diff 审阅、内置浏览器预览（`docs/desktop/workspace.md`、`docs/desktop/sessions.md`、`README.md`） | ✅ 多标签会话、文件树、代码/Diff/MD/图片/音频/PDF/DOCX 预览、分支导航与 fork、worktree 切换（`components/SessionSidebar.tsx`、`FileViewer.tsx`、`BranchNavigator.tsx`、`app/api/worktrees/`、`docs/worktrees.md`） | cc-haha 强在「逐文件审阅+浏览器预览」一体工作台；pi 强在「会话分支/续聊/fork」与多格式文件预览；pi 另有 ArtifactPanel/HtmL 预览（`HtmlPreviewBlock.tsx`） |
| 终端 | ✅ 内置终端页（xterm：`desktop/src/pages/TerminalSettings.tsx:234`，`.settings-terminal-host` 样式体系 `desktop/src/theme/`） | ✅ 终端 tab + relay-shell（`components/TerminalPanel.tsx`、`LazyTerminalPanel.tsx`、`app/api/terminal/`、`docs/terminal.md`、`relay-shell/`） | 两侧均为 xterm 体系；pi 的终端同时暴露给远程 Web/手机端，与 relay 体系打通 |
| 权限审批 | ✅ 图形化审批卡、运行中切换 ask/skip（README；v0.7.8 #1851；v0.7.9 恢复后审批下发） | ✅ tool-approval API + 审批设置 UI（`app/api/tool-approval/`、`components/ToolApprovalSettings.tsx`、`components/ChatConfirmDialog.tsx`） | cc-haha 审批可跨端（手机/IM 卡片）下发；pi 的审批目前限 App/Web 内，IM 审批仅在评估文档中（`docs/agents/fork-im-adapters-assessment.md:172`） |
| MCP | ✅ 可视化管理（README；v0.7.9 修复 MCP 走代理 #1871） | ✅ 完整：配置/添加/登录测试（`app/api/mcp/`、`components/McpConfig.tsx`、`McpAddServer.tsx`、`McpSignIn.tsx`、`docs/agents/mcp-runtime.md`、`mcp-add.md`、`mcp-settings.md`） | pi 的 MCP 管理粒度更细（含 OAuth 登录与测试签到）；cc-haha 强调代理连通性与安全性 |
| SubAgent | ✅ SubAgent 可视化管理（README） | ✅ （`app/api/subagents/`、`docs/agents/subagents.md`、`fork-tools-subagents.md`） | pi 的 SubAgent 来自 pi 内核（pi-subagents 体系）；cc-haha 为自研实现 |
| Agent Teams | ✅ 团队工作台+暂停/恢复+成员模型批量调整（`docs/internals/agent.md`；v0.7.9） | ✅ 深度相当且更细：计划卡/任务看板/通信流/成员检查器/运行控制/成本对话框/目标条（`components/AgentTeams/` 17 组件含 `AgentTeamsRuntimeControls.tsx`、`TaskBoardCanvas.tsx`、`AgentTeamPlanCard.tsx`；`app/api/teams/`、`app/api/goals/`、`docs/agent-teams-design.md`） | 形态趋同（pi 连「运行控制」概念都已有）；pi 额外有 goals/goal 工作流与团队成本分账 |
| 定时任务 | ✅ （`docs/desktop/schedule.md`） | ✅ 保存 prompt 按时运行：小时/日/周/cron/一次性、窗口隐藏也可跑、默认只读工具、睡眠补跑、成败通知（`app/api/scheduled-tasks/`、`components/scheduled/`、`docs/scheduled-tasks-spec.md`、README） | pi 的规格文档化程度高（spec + 补跑语义）；cc-haha 有后台任务通知面板（v0.7.9 移入活动面板） |
| 手机远程接入 | ✅ 原生 App（Android APK/iOS TestFlight）+ H5 控制面 + cloudflared 隧道 + P2P 直连 + 推送（`mobile/`、`docs/desktop/remote.md`、v0.7.8/v0.7.9 release notes） | ⚠️ PWA + 三方案远程（LAN+隧道 / Tailscale / 上游 relay）+ 推送 API（`components/MobilePwaLayout.test.mjs`、`PwaRegistration.tsx`、`app/api/remote-access/`、`app/api/push/`、`relay/`、`relay-shell/`、`docs/remote-access.zh-CN.md`、`docs/remote-relay.md`） | cc-haha 有原生 App 与 P2P 直连，开箱即用；pi 走浏览器 PWA，需自行部署隧道/relay，但 relay 端可自托管（Docker，`relay/Dockerfile`） |
| IM 接入 | ✅ 8 平台：Telegram/飞书/钉钉/微信/企业微信/QQ/Slack/WhatsApp（`docs/im/*.md`；v0.7.8 修复 IM 连接层 #1815） | ❌ 无实现，仅有移植评估文档且结论为「暂不引入」、若做推荐飞书（`docs/agents/fork-im-adapters-assessment.md`） | cc-haha 自研 WS 会话层支撑全部 IM；pi 若引入需先补会话 WS 层（评估文档 §4） |
| 模型接入 | ✅ Claude/ChatGPT/Grok 官方 OAuth + 预设 + 本地端点 + OpenAI 兼容 Base URL 版本路径（`docs/start/models.md`；v0.7.8 #1852；v0.7.9 订阅额度 #1861） | ✅ pi 多 provider + 自定义模型 + OAuth 粘贴面板 + 分类器/图片模型配置（`app/api/models/`、`models-config/`、`components/ModelsConfig.tsx`、`OAuthPastePanel.tsx`、`NonChatModelsDetail.tsx`、`docs/agents/models.md`、`fork-models.md`） | cc-haha 官方账号额度/上下文窗口按账号解析更细；pi 有非聊天模型（classifier/image）显式配置页与网络代理设置（`app/api/network-proxy/`） |
| Computer Use | ✅ 读取界面/截图/点击/输入，macOS 原生引擎 + Windows/Linux 复用 agent-desktop（`docs/desktop/computer-use.md`、README） | ❌ 全仓无实现（仅 purge 预设文案提及；grep `computer.?use` 仅命中 `assets/purge-presets/`、`lib/purge/preset-catalog.ts:321`） | 差异最大项：cc-haha 独有（且其 Win/Linux 引擎本身就是 agent-desktop） |
| 技能市场 | ✅ ClawHub + SkillHub 精选、来源与安全扫描状态展示（`docs/desktop/skills.md`、README） | ✅ 精选目录直接移植自 cc-haha（`lib/skill-market/catalog/catalog.ts:2` 「照搬 cc-haha」、`lib/skill-market/catalog/skills.json`、`components/skill-market/`、`app/api/market/`、`docs/agents/fork-skill-market.md`） | pi 已同源对齐（目录数据一致），但无 iOS/Android 端市场入口 |
| 主题 | ✅ 多主题：浅色/深色/深灰（v0.7.9 新增）+ 可拖拽工作区预览（README、v0.7.9 #1898） | ⚠️ 亮/暗/系统（`lib/theme` THEME_OPTIONS、`components/AppearanceSettings.tsx`）+ 自定义 CSS 注入（`app/api/custom-css/`）+ 字体设置（`components/FontSettings.tsx`、`app/api/appearance/fonts/`）+ 原生主题（`docs/native-theme.md`） | pi 主题数量少但扩展机制（自定义 CSS/字体/原生主题适配）更工程化；cc-haha 胜在预置主题与视觉一致性 |
| 图片生成 | ✅ 内置图片生成（README；v0.7.9 图片压缩 #1893） | ⚠️ 仅模型配置层：分类器/图片模型可配置（`components/NonChatModelsDetail.tsx:40,84`）+ Codemode 工具视图透传（`components/CodemodeToolView.tsx`），无端到端图片生成会话体验 | cc-haha 有完整的生图请求链与图卡展示；pi 已有模型底座，缺 UI/请求管线 |
| 用量统计 | ✅ 成本追踪 + 模型请求追踪 + Claude 订阅额度（`src/cost-tracker.ts`、`src/costHook.ts`、v0.7.9 #1861、README 用量看板） | ✅ provider 用量查询 API + 汇总 UI + 上下文用量环 + 团队成本分账（`app/api/provider-usage/`、`components/ProviderUsageSummary.tsx`、`ContextUsageRing.tsx`、`components/AgentTeams/AgentTeamCostDialog.tsx`） | cc-haha 偏「官方订阅额度」；pi 偏「provider 维度用量+团队分账」，二者可互补 |

补充（矩阵外）：pi-agent-desktop 还有 cc-haha 未列的能力——会话分支/续聊/fork（`BranchNavigator.tsx`、`app/api/agent/`）、Artifact 面板、Autopilot/Autofix/Keepalive/Purge/Outage/Lean-mode/Pinned-sessions（`app/api/*`）、自定义 CSS、签名自动更新与三组件一致性发布流水线（`docs/desktop-updates.md`）。cc-haha 还有桌面宠物（`docs/desktop/pets.md`）、微信个人号设计稿（`wechat-personal-integration-design.md`）。

## 5. 补齐建议（按价值/成本排序，只建议不实施）

针对 pi-agent-desktop 缺口，从「用户价值 × 实现成本」排序：

1. **手机端审批闭环**（价值高 / 成本低）：pi 已有 `app/api/push/`（推送）+ `app/api/tool-approval/`（审批）+ PWA（`components/PwaRegistration.tsx`），三块都在但未串成「手机收到审批推送 → 点开即批」闭环。对齐 cc-haha 手机 App 的核心场景（离开工位也能审批/派任务），只需把 tool-approval 事件接进推送通道并在 PWA 里渲染审批卡。
2. **Claude/ChatGPT 官方订阅额度看板**（价值中 / 成本低）：照搬 cc-haha `release-notes/v0.7.9.md` #1861/#1949 的实现（`GET /api/haha-oauth/usage` 思路），挂载到现有 `app/api/provider-usage/` + `ProviderUsageSummary.tsx`，即可显示 5 小时/每周额度与重置时间。
3. **图片生成端到端体验**（价值中 / 成本低-中）：pi 已有 image 模型配置底座（`NonChatModelsDetail.tsx`）与 Codemode 透传，补 cc-haha 式的「请求前图片压缩/inline 预算」（#1893）与聊天内图卡展示即可形成可用功能。
4. **飞书 IM 单平台接入**（价值高 / 成本中）：`docs/agents/fork-im-adapters-assessment.md` 已给出完整移植路线（推荐飞书、不引入 WS 的进程内投递方案、审批走 extension_ui 卡片）。cc-haha 侧 `docs/im/feishu.md` 对应实现约 4,000 行可参考。建议仅做飞书一个平台以控制维护面。
5. **Computer Use**（价值高 / 成本高，长线）：cc-haha 独有能力，其 Windows/Linux 引擎即 agent-desktop（`docs/desktop/computer-use.md`）。pi-agent-desktop 若做，可评估直接复用同一原生组件；但涉及系统权限、桌面会话边界等大量平台细节，建议作为长期项而非近期补齐。

不做建议（评估过、暂不做）：IM 多平台铺开（评估文档已论证投入产出不成立）、原生手机 App（PWA + relay 已覆盖主场景）、深灰等更多预置主题（自定义 CSS 已可替代）。

---

### 附：本次核验用证据文件清单

- cc-haha：`E:/cc-haha-main/_latest/.git/{HEAD,logs/HEAD,config,refs/heads/main}`、`package.json`、`README.md`、`release-notes/v0.7.9.md`、`release-notes/v0.7.8.md`、`docs/desktop/{workspace,sessions,schedule,remote,skills,computer-use,pets}.md`、`docs/im/*.md`、`docs/start/models.md`、`docs/internals/agent.md`、`desktop/src/pages/TerminalSettings.tsx`、`desktop/src/components/agentTeams/AgentTeamsRuntimeControls.tsx`、`src/cost-tracker.ts`
- 旧副本对照：`E:/cc-haha-main/cc-haha-main/release-notes/`（止于 v0.7.8）、`desktop/src/api/promptHistory.ts`（不存在）、`desktop/src/components/agentTeams/`（已存在）
- pi-agent-desktop：`README.md`、`app/api/*`（agent/sessions/worktrees/terminal/tool-approval/mcp/subagents/teams/goals/scheduled-tasks/remote-access/relay/push/market/skills/models/models-config/provider-usage/custom-css/network-proxy 等）、`components/{SessionSidebar,TerminalPanel,ToolApprovalSettings,McpConfig,ModelsConfig,NonChatModelsDetail,ProviderUsageSummary,AgentTeams/,skill-market/,MobilePwaLayout.test.mjs}`、`lib/skill-market/catalog/catalog.ts`、`lib/purge/preset-catalog.ts`、`docs/{remote-access.zh-CN,remote-relay,terminal,scheduled-tasks-spec,agent-teams-design,native-theme,desktop-updates}.md`、`docs/agents/fork-im-adapters-assessment.md`
- GitHub API：commits/e6b6e48…（commit 元数据）、compare/v0.7.8...e6b6e48…（ahead_by=118）
