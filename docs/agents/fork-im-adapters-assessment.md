# IM 接入评审：要不要把 cc-haha 的完整 IM 适配层搬过来

> 评审对象：`E:\cc-haha-main\cc-haha-main\adapters\`（只读参照）。本文所有行号、行数均为实测（`wc -l`），与代码一一对应。测量不到的写「未核实」。

## 0. 结论

**推荐 A 档（只做单向推送扩展）**。当前前提是「单人使用本机 agent + 手机已能通过 Cloudflare 隧道打开完整 Web 应用」，IM 唯一真实增量是**主动推送触达**，而不是双向对话——双向手机浏览器已经给了。B 档（单平台双向）留作「确实要脱离浏览器页签」的备选；**C 档（8 平台全搬）明确不建议**。

---

## 1. cc-haha adapters 架构拆解

### 1.1 规模（实测，排除 `*.test.ts` / `*.spec.ts`）

| 目录 | 文件 | 行数 |
|---|---|---|
| common（骨架） | 26 | 4,899 |
| feishu | 17 | 4,034 |
| wechat | 17 | 3,474 |
| telegram | 6 | 2,344 |
| dingtalk | 7 | 1,497 |
| whatsapp | 5 | 1,218 |
| **slack（最薄）** | **5** | **857** |
| qq | 4 | 696 |
| wecom | 4 | 678 |
| **合计** | **91** | **19,697** |

（背景资料说 87/19,320，实测为 91/19,697；差异来自文件名过滤口径。）真正与平台无关的骨架是 `common/` 的 4,899 行。

### 1.2 `common/` 模块职责（实测行数）

| 模块 | 行 | 职责 |
|---|---|---|
| `chat-runtime.ts` | 812 | 全平台唯一的入站/出站主循环：配对 → 命令路由 → 找/建会话 → 投递 → 翻译服务端流 → 权限卡片 |
| `ws-bridge.ts` | 541 | 与桌面服务端 `/ws/:sessionId` 的 WebSocket 封装：`chatId→sessionId` 映射、心跳、指数重连、幂等投递 |
| `config.ts` | 452 | `~/.claude/adapters.json` + 环境变量加载；`resolveAllowedProjectRoots()`(:274)/`resolveAdapterWorkspace()`(:342) 是文件边界 |
| `http-client.ts` | 525 | REST 辅助：`createSession`(:169 POST /api/sessions)、`listRecentProjects`(:218)、`matchProject`(:240)、`getGitInfo`(:288) |
| `format.ts` | 395 | `/help`、`/status`、权限提示等文本渲染 |
| `session-selection.ts` | 262 | `/projects` 选择器状态机 |
| `pairing.ts` | 158 | 6 位配对码、白名单、限流（见 1.4） |
| `project-selection-router.ts` | 127 | `/new <名称\|路径\|编号>` 解析 |
| `session-recovery.ts` | 105 | `restoreStoredSessionBinding()`：把持久绑定恢复到活连接 |
| `permission-sync.ts` | 100 | 把一个服务端审批请求**恰好投递一次**，并与 `permission_requests_snapshot` 对账 |
| `message-buffer.ts` | 100 | 流式文本按时间/字数窗口合并 |
| `session-store.ts` | 82 | `chatId→sessionId` 持久化到 `~/.claude/adapter-sessions.json` |
| `permission.ts` | 75 | 解析用户对审批卡片的回复（`y/n/always`） |
| `message-dedup.ts` | 62 | 重放去重 |
| `inbound-power-activity.ts` | 58 | 入站期间占用「防休眠租约」 |
| `migration-lifecycle.ts` / `migration-control.ts` | 51+41 | 适配层重启时的静默/收尾 |
| `adapter-client.ts` | 39 | 各平台入口统一装配 httpClient + 默认工作目录（修 #1191） |
| `chat-queue.ts` | 28 | 每 chat 的 FIFO |
| `attachment/`（7 文件） | 886 | 附件类型/限额/落盘/MIME/出站图片安全加载 |

设计要点：**平台差异被收进一个 `ChatPort` 接口**（`chat-runtime.ts:68`，只要 `sendNotice`/`createResponse`，可选 `sendImage`/`setBusy`），runtime 从不 import 任何平台 SDK，因此可用假 port 测试。`chat-runtime.ts:1-17` 的注释明说：五个平台各自抄一遍同一个循环、各自回归过一次，才收敛成这一个模块。

### 1.3 最薄平台完整链路（Slack Socket Mode，逐环节文件:行号）

1. **传输** — `slack/index.ts:244` 建 `SlackSocketMode`，`:285` 启动；`slack/socket-mode.ts:104` 收到帧 → `:115` 先回 `envelope_id` 确认（Slack 3 秒未确认会重投）→ `:131` 交给 `onEnvelope`。连接串由 `slack/api.ts:143`（`apps.connections.open`）取得。
2. **归一 + 过滤** — `slack/index.ts:248` 只认 `events_api`；`slack/extract-payload.ts:85` 做筛选：非 `message`(:90)、非允许子类型(:91)、`hidden`(:92)、`bot_id`(:94，含自己)、**`channel_type!=='im'`(:97) 全部丢弃**——只服务私聊。
3. **身份校验** — `slack/index.ts:257` 进 `runtime.handleInbound`；`chat-runtime.ts:212` `isAllowedUser` → `pairing.ts:151` → `isPaired`(:85)。未授权则走 `chat-runtime.ts:238 handlePairing` → `pairing.ts:106 tryPair`。
4. **找会话** — `chat-runtime.ts:280 ensureSession` → `:533 ensureExistingSession` → `session-recovery.ts:43` 读 `session-store.ts:52` 的绑定，`http-client.ts:197` 验证会话存在，`ws-bridge.ts:114` 重连；不存在则 `chat-runtime.ts:560 createSessionForChat` → `http-client.ts:169 POST /api/sessions` → `session-store.ts:32` 落盘 → `ws-bridge.ts:114 connectSession` → `:363 waitForOpen`。
5. **投递** — `chat-runtime.ts:293 bridge.sendUserMessage` → `ws-bridge.ts:124`，payload `{type:'user_message',content}`(:131) → `:388 send` → `:395 ws.send`。
6. **流式回写** — 服务端帧 `ws-bridge.ts:263` → `:305 deliverMessage`（每 chat FIFO）→ `chat-runtime.ts:392 handleServerMessage`：`content_delta`(:420) 进 `MessageBuffer`；`message_complete`(:457) 收口。Buffer flush 触发 `SlackResponse.append`(`slack/index.ts:88`)→`render`(:103)，节流 1.2s（`:38`）调 `api.updateMessage`(`slack/api.ts:129`) 原地编辑，首帧 `api.postMessage`(:121)。
7. **权限审批** — `chat-runtime.ts:443 permission_request` → `permission-sync.ts:13 deliverImPermissionPrompt`（保证只投一次）→ `port.sendNotice`(:449) 发卡片；用户回复 → `chat-runtime.ts:266 parsePermissionCommand` → `:363 applyPermissionDecision` → `ws-bridge.ts:148 sendPermissionResponse` 回 `{type:'permission_response',requestId,allowed,rule}`。
8. **命令** — `chat-runtime.ts:311-361` 处理 `/help /status /projects /new /stop /clear`。

链路总长：**Slack 专属 5 文件 857 行**，加 `common/` 中被复用的骨架（chat-runtime + ws-bridge + config + http-client + session-store + session-recovery + pairing + permission-sync + message-buffer + format 等）约 **3,600 行**。这是移植成本的分母。

### 1.4 凭据 / 校验 / 白名单语义

- **凭据**：`config.ts:148 loadConfig`，优先级 env > `~/.claude/adapters.json` > 默认（`:4`）。Slack 用 `SLACK_BOT_TOKEN`(`xoxb-`)+`SLACK_APP_TOKEN`(`xapp-`)，见 `config.ts:238-244`；文件权限 `0600`、配对码写入用随机 tmp + rename（`pairing.ts:67-74`）。
- **`allowedUsers`**：显式白名单，命中即放行（`pairing.ts:95`）。**`pairedUsers`**：走配对码后写入的名单（`:99`）。两者都空 → 默认拒绝（`:97`）——即「未配置 = 谁都不许用」。
- **配对码**：6 位、排除易混字符（`pairing.ts:15`），TTL **60 分钟**、一次性（`:51-52`、`:144`），大小写/空格不敏感（`:122`）；**限流**每 userId 5 分钟内 5 次失败（`:27-28`、`:31-50`）。
- **`allowedProjectRoots`**：`resolveAllowedProjectRoots`(`config.ts:274`) 决定适配层可触达的目录。优先级 env `ADAPTER_ALLOWED_PROJECT_ROOTS` > 平台级 > 全局 > 默认（home ∪ 默认工作目录）。显式配置原样采纳（写 `/` 就真的放开）；**默认分支拒绝继承 `/` 或 home 的祖先**（`:320-333`），修复了「Finder 启动 .app 时 cwd=`/`，边界静默变成整个文件系统」的漏洞（`config.ts:253-273` 注释）。

---

## 2. 本仓现状对照

### 2.1 有无 IM 代码：没有

在 `lib/ app/ components/ hooks/` 下 grep，**零命中**（真命中，非套话）：

- `feishu|lark|dingtalk|telegram|slack|discord|webhook` → 仅 3 处**假阳性**：`lib/artifact-index.ts:56` 与 `lib/scheduled-tasks/scheduler.ts:28` 的 `MENTION_BIRTH_SLACK_MS`/`ORPHAN_SLACK_MS`（时间「slack」余量），`components/MessageView.tsx:1920` 注释里的「small slack」。
- `\bbot\b` → 2 处**假阳性**：`lib/mcp-import-core.ts:387` 的 auth scheme 正则 `(Bearer|Basic|…|Bot|…)`，`components/ModelsConfig.tsx:463` 的文案「bot detection」。

**`lib/web-push.ts`(366)/`lib/attention-push.ts`(66) 不是 IM**：它是 Web Push（VAPID + ServiceWorker + 浏览器订阅），推送终点是**浏览器通知**，不是第三方聊天平台。

### 2.2 本仓已有的可复用件

| 现有件 | 行数 | 若有 IM，省掉哪块 |
|---|---|---|
| `lib/rpc-manager.ts` `startRpcSession` / `AgentSessionWrapper.send`(:1332) | — | 整个 cc-haha `ws-bridge.ts`(541) 的「发消息 + 收事件」职责；本仓进程内已有会话对象，直接 `session.send({type:'prompt',message})`（rpc-manager.ts:1370） |
| `lib/agent-event-stream.ts` | 315 | 服务端事件流：`connected`/`message_start`/`message_update`/`tool_execution_update`/`extension_ui_request`(lib/agent-event-stream.ts:267-284) |
| `lib/attention-push.ts` + `lib/web-push.ts` | 66+366 | **已经实现的「触达」**：complete/failed/stopped/attention 四态推送，由 `rpc-manager.ts:3704-3728` 在 run 结束与阻塞对话框(`:873 onAttentionNeeded`)时触发 |
| `lib/relay/**`（13 文件） | — | 端到端加密中继 + 手机配对（`app/api/relay/pairing/**`）：IM 侧可复用「配对/白名单/设备列表」这一整层，不必另造 |
| `app/api/attention/route.ts`(21) + `relay-shell/home.ts` | — | 「Needs You」收件箱，手机主屏已按 `kind` 渲染待办 |

### 2.3 关键判断：本仓没有 cc-haha 的 WS 会话协议，IM 该走什么

cc-haha 的 `ws-bridge.ts` 说的是 **cc-haha 自己服务端**的协议（`src/server/ws/events.ts`：`type:'user_message'` / `permission_response` / `stop_generation`）。本仓 `/api/sessions` 是 **GET-only**（`app/api/sessions/route.ts:28` 只有 GET），没有同款 WS。

本仓 IM 投递的**真实入口**（二选一，都在服务端进程内）：

1. **进程内直连（推荐）**：在 `instrumentation-node.ts`(124 行，已有 startScheduler/keepalive 等后台循环的宿主) 里挂一个常驻桥，调用 `getRpcSession(id)` 拿 `AgentSessionWrapper`，`session.send({type:'prompt', message})`；事件侧订阅同一 wrapper 的 `session.onEvent()`。**省掉 WS 的全部封装**。
2. **HTTP 自调用**：`POST /api/agent/new`(创建+首条 prompt) 或 `POST /api/agent/[id]`(:59 `session.send(body)`)，事件走 `GET /api/agent/[id]/events`(SSE)。

无论哪条，**cc-haha 的 `ws-bridge.ts` 必须重写**（协议完全不同，本仓是 SSE/进程内事件，不是 `/ws/:sessionId`）。这是主要返工点。

---

## 3. 必要性评审（重点）

### 3.1 用户场景
单人使用本机 agent；手机通过 Cloudflare 隧道打开**完整 Web 应用**（`docs/agents/fork-public-access.md`：隧道指向 Next 服务器本身，已做 `PI_WEB_PASSWORD` + relay 配对）。也就是说，**手机浏览器 = 桌面应用的全部功能**，包括聊天、看流式输出、审批权限卡片、`ChatInput`/`ToolApprovalSettings` 等。

### 3.2 IM 解决了什么手机浏览器解决不了的？逐条验伪

| 卖点 | 是否真成立 | 依据 |
|---|---|---|
| 推送触达（人不在页面时通知） | **成立** | 手机浏览器页签关闭就收不到；这正是 `lib/web-push.ts` 要解决的问题。但**已用 Web Push 解决**——IM 版只是换一个推送通道 |
| 审批随手点 | **基本不成立** | 手机浏览器能打开完整应用并审批（`ChatInput`/权限卡片在 Web UI 上）；IM 卡片只在「人恰好在聊 IM、没开页签」时略快一步 |
| 群里协作 | **不成立** | 单人使用；且 Slack 适配层只收 `channel_type==='im'`（`extract-payload.ts:97`），群聊被显式排除——cc-haha 自己也不做群协作 |
| 不用保持页面打开 | **成立但已被覆盖** | 这正是推送要解决的问题，`attention-push`+`web-push` 已覆盖（run 完成/失败/停止/需要人） |

**结论**：IM 相对现状的真实增量 = **多一个推送通道 + 不必点开应用就能看到/回复**。二者叠加，在「单人 + 已有手机浏览器 + 已有 Web Push」下是**体验优化，不是能力补齐**。

### 3.3 成本（照搬 vs 重写）

- **能照抄**：`common/` 里与传输无关的部分——`pairing.ts`(158)、`config.ts` 的 roots 逻辑(约 200)、`chat-runtime.ts` 的命令/会话/权限状态机（约 500）、`format.ts`、`message-buffer`、`session-store`、`permission-sync`。合计约 **1,500–2,000 行**可基本照搬（去掉 `.js` 后缀、改路径）。
- **必须重写**：`ws-bridge.ts`(541) → 换成本仓 `AgentSessionWrapper`/SSE（协议不同）；`http-client.ts`(525) → 本仓路由不同（`/api/agent/new`、`/api/agent/[id]`）；平台 SDK 层（Slack 857，或任选一平台 700–4,000）。
- **粗估**：骨架移植 + 接一个平台 = **约 1,500（骨架）+ 800（平台）≈ 2,300 行新增/改写**，加设置 UI、i18n（`FORK_MESSAGE_PATCHES`，三语言）、测试。
- **确凿事实**：本仓已依赖 `ws@8.22.0`（package.json:137），做 WS 客户端无新依赖；但**服务端无 `/ws` 路由**，多平台方案需要先造一个会话 WS 协议——这是 C 档成本暴涨的根因。

### 3.4 风险

- **非官方协议封号/合规**：微信个人号（`wechat/` 3,474 行，ClawBot/iLink 长轮询）与 WhatsApp（`whatsapp/` 1,218 行，Baileys 个人号 Web 登录）走的都不是官方机器人通道，**账号被封/协议失效是真实且不可控的风险**，且可能违反平台条款。这 2 个平台（合计 4,692 行，占总量 ~24%）本就不该追求。
- **凭据泄露面放大**：IM 的 bot token 一旦泄露，等于把**本机 shell 的入口**挂在第三方平台上。cc-haha 用「配对码 + `allowedUsers` + `allowedProjectRoots` + 0600 文件」四层兜底；本仓要做必须**整套搬这四层**，且默认拒绝（`pairing.ts:97`）。隧道方案下这个暴露面本已存在（`PI_WEB_PASSWORD`），但 IM 把它从「一个静态口令」变成「第三方平台账号 + bot token」两个新秘密。

### 3.5 与现有能力的关系
`attention-push.ts` 已经在做「会话需要人时推送」（`:59 notifySessionStopped`，`rpc-manager.ts:3725` 的 `kind:'attention'`）。**IM 的增量本质上只有「双向」这一个点**——把「收到通知」升级成「在聊天窗里直接回一句」。单向触达已经被覆盖，多平台单向推送只是换通道。

---

## 4. 三档建议

### A 档：只做单向推送扩展（推荐）
- **做什么**：在现有 `web-push` 之外，加飞书/企业微信**群机器人 webhook** 推送（机器人 webhook 是官方、免审核、只需一个 URL），把 `SessionPushEvent` 的 complete/failed/stopped/attention 四态投过去。
- **规模**：新增 `lib/im-notify/`（约 3–4 文件）+ `Settings › General` 一个开关行 + i18n 三语言，**约 150–250 行**。
- **谁能用上**：任何人，只要有一个飞书/企微群机器人 URL。
- **放弃**：双向回复（回复仍回手机浏览器）。
- **风险**：极低，无 bot 常驻进程，无封号面。

### B 档：做**一个**平台的双向接入（备选）
- **推荐平台：飞书**。理由：长连接（WS 出站，无需公网回调）与 cc-haha 的 `feishu/`(4,034) 最成熟；官方机器人 + 卡片消息 + 权限卡片模板完善，审批交互体验最好；国内可达性稳定。
- **不选 Slack 的理由**：Slack 虽最薄（857 行），但在国内网络环境下可用性差，与「手机随手用」的场景冲突。**不选钉钉**：`permissionCardTemplateId` 等模板配置重（`config.ts:63`），首次搭建成本高。
- **规模**：见 §5，"约 2,300 行 + UI/i18n"。
- **谁能用上**：已配好飞书自建应用的人。
- **放弃**：其余 7 个平台；单向推送（A 档）可作为 B 档的子集一并做掉。

### C 档：完整照搬 8 平台（**不建议**）
- 理由：(a) 8 平台里 2 个是非官方协议（微信/WhatsApp，4,692 行，封号+合规风险）；(b) 本仓无 WS 会话协议，每个平台都依赖同一套 `ws-bridge` + `/ws` 服务端，**要先另造整条会话 WS 层**（cc-haha 有，本仓没有），成本从「移植骨架」变成「移植骨架 + 新建协议」；(c) 单人使用下 8 个平台里最多用得上 1 个；(d) 维护面 = 每次平台协议变更都要跟。**投入产出严重不成立**。

---

## 5. 若选 B 档：落地方案

- **目录**：新增 `lib/im-adapters/`（骨架 + 平台），平台进程或常驻循环挂在 `instrumentation-node.ts`。可参考但需取舍地复用 cc-haha `adapters/common/` 的：`pairing.ts`（配对码/白名单/限流）、`config.ts` 的 `resolveAllowedProjectRoots`（边界）、`chat-runtime.ts` 的命令/权限状态机、`permission-sync.ts`（审批只投一次）、`format.ts`、`message-buffer.ts`。
- **必须重写的两块**：① 传输层——用 `AgentSessionWrapper.send`(`rpc-manager.ts:1332`) + `session.onEvent()` 替换 `ws-bridge.ts`；② HTTP 辅助——指向本仓路由（`POST /api/agent/new`、`POST /api/agent/[id]`、`GET /api/agent/[id]/events`）。
- **配对码/白名单/审计**：直接复用本仓 `lib/relay/**` 的配对与设备列表（`app/api/relay/pairing/**`、`devices/[id]`），而不是再抄一份 cc-haha 的 `pairing.ts`——这样「手机 = 一个已配对设备」的模型统一，白名单与撤销共用一处。审批动作写入既有的 extension-ui 响应通道（`extension_ui_request` ↔ `{type:'extension_ui_response'}`，`rpc-manager.ts:1905`）。
- **新依赖**：飞书官方 SDK（或裸 `ws` + 官方长连接 URL）；本仓已有 `ws@8.22.0`(package.json:137)。**无需引入 Baileys/grammy 等重 SDK**。
- **不引入 WS 的双向实现**：本仓**不用** `/ws/:sessionId`。IM 侧「投递」= 进程内 `session.send({type:'prompt'})`（或 POST `/api/agent/[id]`）；「回显」= 订阅该 wrapper 的 `onEvent()` 把 `message_update` 增量节流后编辑同一条平台消息（照搬 `SlackResponse` 的原地编辑 + 节流思路，`slack/index.ts:80-140`）；「审批」= 监听 `extension_ui_request` 事件 → 发平台卡片 → 用户回复 → POST `extension_ui_response`。**全程无服务端 WS 新增**。

---

## 6. 推荐与判据

**推荐 A 档**。判据（基于「单人使用 + 手机已有完整浏览器 + 已有 Web Push」，不诉诸「看用户想要」）：

1. **能力已补齐，IM 只换通道**：手机浏览器是完整应用，`web-push`/`attention-push` 已覆盖四态触达。IM 的真实增量只剩「双向」一个点，而双向在浏览器里已经能做到。
2. **收益/成本比失衡**：A 档约 200 行解决触达；B 档约 2,300 行 + 常驻进程 + 新秘密（bot token）换「少点一下应用」。单人场景下不划算。
3. **最大风险集中在最没用的部分**：C 档 24% 的代码（微信/WhatsApp）是封号与合规风险源，而单人用不到。
4. **若坚持要双向**：走 **B 档—飞书**，并按 §5 复用本仓 relay 配对 + 进程内 send/SSE，**不要**照搬 `ws-bridge`。

**立即能做的低成本动作**：A 档（飞书/企微群机器人 webhook，约 200 行）——它把「触达」从「只有装了 PWA 的浏览器」扩展到「任何聊天客户端」，风险近乎为零，且不与未来是否做 B 档冲突。

---

## 附录：实测数字速查

- `adapters/` 非测试 TS：**91 文件 / 19,697 行**；`common/` **26 文件 / 4,899 行**。
- 最薄平台 Slack：**5 文件 / 857 行**；其依赖骨架约 **3,600 行**。
- 本仓 IM 命中：**0**（`feishu|lark|dingtalk|telegram|slack|discord|webhook` 与 `\bbot\b` 的命中全为假阳性）。
- 本仓可复用：`attention-push.ts` 66、`web-push.ts` 366、`agent-event-stream.ts` 315、`rpc-manager.ts` 3,743、`instrumentation-node.ts` 124；已有依赖 `ws@8.22.0`。
- cc-haha 完成通知能力实测仅 `desktop|feishu|telegram`（`src/server/services/scheduledTaskNotificationCapabilities.ts:13-17`）。
