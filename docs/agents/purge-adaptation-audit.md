# dsh-purge 适配评估（2026-11-23）

对象：`kingcharleslzy-ai/dsh-purge`（社区版 `dsh-purge-community` 1.7.20）对本仓库
`pi-agent-desktop` 的适配度。结论先说：**数据面 1:1 同步、语义面有意重写、宿主面结构性不适配**，
真正缺的只有四处，其余是两种宿主形态决定的、搬不过来也不该搬的部分。

上游校验基准（本次实查，不是文档抄写）：

- `GET /repos/kingcharleslzy-ai/dsh-purge/commits/master` → `sha = e519253d5b01344056055af9d2041dcafa42fed3`，
  与 `lib/redteam-skills.ts:21` 的 `REDTEAM_PACK_COMMIT`、`optional-skills/README.md` 完全一致，
  即本仓库钉的**就是上游 HEAD**，没有落后。
- 上游 `package.json` version = `1.7.20` = `lib/redteam-skills.ts:22` `REDTEAM_PACK_VERSION`。
- `optional-skills/redteam/*.md` 23 个文件逐个 SHA256 与上游 `skills/redteam/` 比对：**全部字节相同**（0 处漂移）。

## 1. 两边的形态差异（决定了什么能搬）

| | dsh-purge | 本仓库 |
| --- | --- | --- |
| 宿主 | DeepSeek Harness（cordis 插件，`@deepseek-ai/cordis` ^4，声明 `<0.3.0`） | pi coding agent（`@earendil-works/pi-*` 1.5.2）+ Tauri 壳 |
| 生效方式 | 打宿主补丁（`cordis.patch.yml`，86 条）+ 改提示词段位 | 只用宿主公开 seam：`before_agent_start` / `context` / 设置文件 |
| 桌面形态 | Electron `app.asar` 换包 + handoff | Tauri 自更新 |
| 提示词注入 | `prompt-inject.md` / `rules` → `AGENTS.md` / 加密槽 | `structured_templates` 追加到最后一条 user 文本 |

`lib/purge/*` 的注释写的是 ported from AIGX `src/purge/mod.rs`——同一血统的手写重写，
而不是把上游 `lib/core.js`（185KB）搬过来。这是刻意的：上游那 100+ 个模块里绝大多数是
宿主补丁、asar 迁移、更新通道，在 pi 宿主上没有落点。

## 2. 逐能力对照

| 上游能力（1.7.20） | 本仓库对应 | 判定 |
| --- | --- | --- |
| `skills/redteam/**` 23 个技能 | `optional-skills/redteam/**`（逐字 vendored，默认不加载，面板安装到 `<agentDir>/skills/redteam/`，标记文件控制卸载） | **已适配，字节级一致** |
| 破甲正文注入（preset） | `auto_preset` + `lib/purge/auto-apply.ts`（按模型查目录，prepend/append，默认开） | **语义等价，实现自研** |
| 预设库 | `assets/purge-presets/**` 53 条，来源是 `jailbreaks` 集合，不是上游 `presets/` | **来源不同**（见 §3-A） |
| 治理管线（normalize → 改写 → 同义词 → 结构化 → 技能注入） | `lib/purge/governance.ts` | **语义等价，顺序与计数口径均已单测** |
| `rules` → `AGENTS.md` 覆盖 + `prompt-inject.md` | 无对应；本仓库走 `structured_suffix` / `structured_templates` | **不适用**（pi 的项目指令由 SDK 自己管） |
| 宿主补丁 #14/#17/#60/#62/#67/#74 等 86 条 | 无 | **不适用**（没有 cordis） |
| `boost` 强化段（order `-50000`，issue #76 实测 0/6 首拒） | 只有 `auto_preset` 的前插 | **缺失**（见 §3-B） |
| `refusal-retry`（首拒重试） | 无 | **缺失**（见 §3-C） |
| 技能归档导入（zip/tar）+ `market` | `lib/skill-market/**` + 固定 redteam 包；不支持任意归档导入 | **部分**（见 §3-D） |
| 更新/备份/回滚/`diagnose`/`selfcheck` | `app/api/updates/**`、Tauri updater；无 purge 级备份回滚与自检 | **部分** |
| 闸门归属审计 | `app/api/purge/gate-log` + `components/PurgeGateLogSection.tsx` | **已实现（自研）** |
| Electron asar handoff、web cookie 域、端口归并 | 无 | **不适用** |
| 兼容矩阵（`docs/compatibility.md`，逐 DSH 发行标注 compatible/unknown） | 无 | **不适用**（依赖 DSH 发行号，pi 侧无对应概念） |

## 3. 四个真实缺口

### A. 预设库来源不是上游（P3，需要一次决策）

上游自带 `presets/redteam`（`agent.cordis.yml` 27KB + `anchor-gate.mjs`）与
`presets/unrestricted`（`agent.cordis.yml` 15KB + `preset.yml`）。它们是 **cordis agent 配置**
（persona / 工具表 / 压缩 / 委派分组），不是一段可以直接拼进系统提示词的正文，所以
`assets/purge-presets/**` 改用 `jailbreaks` 里的纯 prompt 是合理的形态选择。

代价：想在本仓库拿到「上游那两档预设的效果」，现在只能自己在控制台写模板。
可选动作（不建议自动做）：把两份 `agent.cordis.yml` 的 persona/prefix 段抽成两条
`structured_templates` 内置项，命名 `dsh-purge-unrestricted` / `dsh-purge-redteam`。

### B. 缺 `boost` 强化段（P2，可做）

上游把破甲强化段排在所有段位最前（order `-50000`），依据是 issue #76 的 0/6 vs 2/6 首拒对比。
本仓库只有 `auto_preset_mode: prepend`，把整份预设正文放在宿主提示词之前——位置效果相近，
但没有「只放一小段强化语、正文另放」的两段式。若要补：在 `lib/purge/types.ts` 加
`boost_*` 字段并在 `composeAutoPreset` 前拼接，需要新的单测钉住段位顺序。

### C. 缺 `refusal-retry`（P2，可做）

上游遇到首轮拒答会自动重试一次。pi 宿主有 `before_agent_start` / `context`，但没有
「回看响应并重发」的 seam；实现面在 `lib/rpc-manager.ts` 的请求循环里，属于新功能而不是 bug。

### D. 技能只能装固定包（P3）

`lib/redteam-skills.ts` 只认 `optional-skills/redteam`。上游 `lib/skills.js`（27KB）支持从
zip/tar 归档导入任意技能包。本仓库已有 `lib/skill-market/**`，若要扩，优先复用 market 的下载/校验层。

## 4. 本次修掉的缺陷（与本评估同时落地）

| ID | 缺陷 | 证据 | 修法 |
| --- | --- | --- | --- |
| P1 | Windows 上没有 bash 时后台任务**整块不可用**：`startBackgroundJob` 直接 `getShellConfig()`，干净装机/ Git 装在 D 盘都抛 "No bash shell found" | `lib/background-jobs/runtime.ts:127`（修前）；本机 9 个 `runtime.test.mjs` 用例全红 | 新增 `lib/background-jobs/shell.ts`：SDK → `detectBashPath()` → PowerShell 三级兜底，降级打一行 warn；同时补 `commandTransport: "stdin"` 的写入路径（旧版 WSL bash 用 `-s`） |
| P2 | `reduce_reasoning` 只压不还：`pi.setThinkingLevel()` 改的是**会话状态**，一轮跑完会话永久留在 floor 上，控制台关了也不回升——「关掉=纯转发」当场失效 | `lib/purge/extension.ts`（修前只有压的那一次调用） | 记下压之前的档位，`agent_end` 里还原；只在现档位仍是自己压的那个时才还（用户中途手动改过就尊重用户）。3 条新单测：还原、一轮只还一次、操作者改过则不动 |
| P2 | `node scripts/check-fast-mode.mjs` 在**测试全绿**时也退 1：解析器只认 TAP 的 `# tests N`，而 node ≥22 默认 reporter 写 `ℹ tests N` | `scripts/fast-mode-checks.mjs:31`；`scripts/doc-commands.test.mjs:57` 因此长期红 | 汇总行与失败行同时认 TAP / spec 两种格式，失败名去重、跳过 `failing tests:` 标题；补 2 条格式单测 |
| P2 | `skill_file` 落盘把 `name:` 写成预设标题：53 条里 33 条标题不是合法 Agent Skills 名（大写/空格/括号/点），SDK `validateName` 告警且 `/skill:<name>` 无法调用 | `lib/purge/presets.ts` `renderSkillFile`（修前）；SDK `dist/core/skills.js:61-76` | `name` 改写成 `preset.id`（本就 `[a-z0-9-]` 白名单、且就是目录名），标题移进 `description`；顺带改成原子写；新增遍历真实目录的回归测试 |
| P3 | 并发用例用墙钟判定（`elapsed < 280`），12 个文件并行跑时重叠也会误报 | `lib/fast-mode/integration.test.mjs:326`（修前） | 改判重叠时长 `first.end - second.start >= 100`（串行时必然 ≤ 0），墙钟只进失败信息 |
| P3 | 原生 PTY 集成用例的预算写死在 12s/15s；本机 ConPTY + PowerShell 冷启动实测 9.7s，跑满 4 路并发时直接撞 watchdog，红的是超时而不是缺陷 | `lib/terminal-manager.test.mjs:150,170`（修前） | watchdog 12s→30s、`execFile` 15s→40s；断言不变，真起不来仍然红 |
| P3 | agent-teams 并行 spawn 用例靠 `setTimeout(20)` 制造重叠窗口，机器被占满时兄弟请求进来时对方已经跑完 | `lib/agent-teams-members.test.mjs:754`（修前） | 换成「兄弟到齐才放行」的 Promise 栅栏 + 2s 超时兜底：串行实现会等超时后自己走完，断言照样能分辨 |
| P2 | `relay/server.test.mjs` 没有任何超时，而它靠「等一条 websocket 消息」推进；`--test-concurrency=4` 全量跑里有一条用例卡住，整个测试进程挂了 **941 秒**，只有手动 kill 才结束（CI 上就是 job 无限卡死）。根因：用例用客户端侧 `'open'` 事件当作「已登记」，relay 的 `acceptClient` 可能还没跑，「腾位置」判定不触发；另外 auth 帧（桌面 socket）与数据帧（手机 socket）跨 socket 无顺序保证 | `relay/server.test.mjs:195-227`（修前） | ① 每个用例加 20s 硬上限，卡住变成一条带名字的失败；② `withLabel()` 给每次等待贴标签，超时说清卡在哪一步；③ 用桌面侧 `open` 帧（登记的真实凭据）代替客户端握手；④ 回显改成有界重发 + 有界等待，不再假设跨 socket 顺序。同一并发组合连跑 8 次 0 红 |
| P3 | 模型目录刷新集成用例约 1/5 偶发红：`createModelRuntimeWithExtensions()` 建出的 runtime 只创建时读过 store，而「store → 模型列表」是 `refresh({allowNetwork:false})` 做的，断言在两者之间抢跑 | `lib/model-catalog-refresh.integration.test.mjs:74`（修前）；探针实测 iteration 2 store 里已有新模型、列表却没有 | 调用方显式 `await runtime.refresh({ allowNetwork: false })`（正是 `/api/models` 那条 shared runtime 路径本来就在做的事），断言只问 store 有没有这条模型；6 连跑 0 红 |
| P3 | relay 用例每次 `mkdtempSync` 的目录没人删（只有 `relay.close()` 进了 `t.after`），本机 `%TEMP%` 攒了 42 个 `pi-relay-test-*` | `relay/server.test.mjs` `startRelay()`（修前） | 收集目录 + 文件级 `after` 统一 `rmSync`（Windows 上重试）；清完后连跑 3 次，前后计数均为 0 |
| P2 | **8 条写路由把 `await req.json()` 放在 catch→500 的大 try 里**：客户端发一个 `{` 就得到 500，正文还带着解析器原话（`Expected property name or '}' in JSON at position 1`）——状态码谎报「服务器坏了」，正文泄实现细节。仓库自己的规矩是 来源守卫 → 415 → 400(JSON) → 400(字段) → 500 | `app/api/{autopilot,lean-mode,network-proxy,pinned-sessions,relay,terminal,skills,open-in-explorer}/route.ts`；新增的 `app/api/invalid-json-gate.test.mjs` 在修前实测 **8/8 返回 500** | 新增 `readJsonBody()`（`lib/request-security.ts`）：解析失败统一 400 + 通用文案；8 条路由改用它；`open-in-explorer` 顺带补上缺失的 415 闸门。逐路由断言「400 且不含 `Unexpected/JSON.parse/SyntaxError`」，8/8 转绿 |

## 5. 复验命令与实测数字

```bash
node --test lib/background-jobs/shell.test.mjs lib/background-jobs/runtime.test.mjs   # 18 pass / 1 platform-skip
node --test lib/purge/presets.test.mjs lib/purge/extension.test.mjs                   # 33 pass / 17 pass
node --test scripts/check-fast-mode.test.mjs scripts/doc-commands.test.mjs            # 12 pass / 2 pass
node --test relay/server.test.mjs                                                     # 16 pass（并发组合连跑 8 次 0 红）
node --test lib/terminal-manager.test.mjs lib/agent-teams-members.test.mjs            # 10 pass / 27 pass（各连跑 3 次）
node --test lib/model-catalog-refresh.integration.test.mjs                            # 3 pass（连跑 6 次 0 红）
node scripts/check-fast-mode.mjs                                                     # 144 tests | 144 pass | 0 fail → OK
node_modules/.bin/tsc --noEmit -p tsconfig.json                                      # 0 error
node_modules/.bin/eslint .                                                           # 0 error（21 条既有 warning，未新增）
node --test --test-concurrency=4 "app/**/*.test.mjs" …                               # 6117 tests / 6068 pass / 0 fail / 49 skip
```

全量那行是本机实测（2026-11-23，`--test-concurrency=4`）：修前同一命令 10 个红
（9 个后台任务 + 1 个 `doc-commands`），修后连续 3 次全绿、0 个红；flaky 面
（PTY、agent-teams、fast-mode 并发、relay、模型目录）各自按上表次数连跑稳定。
49 个 skip 里包含 1 个 win32 不适用（超时杀进程用例）与既有平台跳过项。

## 6. 一句话结论

**技能包与上游 HEAD 逐字节一致，治理语义等价；缺的四项（boost 段、refusal-retry、归档导入、上游两份 agent 预设的正文提炼）
里没有一项是因为「适配做错了」，本次同时修掉 4 个确定性缺陷（1 个 P1、2 个 P2、1 个 P3）。**
