# 快速模式（fast mode）

提示词侧的速度开关：**只改模型「怎么写」，不改模型、思考档位、工具集或请求体**。
默认 `off`，关闭时对系统提示词是逐字节透传。

## 为什么是提示词，而不是参数

本机实测（`~/.pi/agent/sessions` 的真实回合）：一次 8 轮的会话里，一条 9,134
token 的回复独占 61s（约 46% 墙钟），而网关 TTFB 只有 0.7–1.3s。也就是说，
慢的大头是**输出长度**和**回合数**，不是换模型能解决的。

对应地，这一层只做四件事：

| 开关 | 作用 | 默认 |
|---|---|---|
| `brevity` | 不预告调用、不复述工具结果、不写进度日志、末尾不总结；答案本身不缩水 | 开 |
| `verifyFirst` | 拿不准且很便宜就先查一次，不要猜错再重做；已有结果不重读 | 开 |
| `actFirst` | 动手前最多一行计划；证据够就动手；一次做对比三次试探好 | 开 |
| `changeApproach` | 同一调用要重发、或连续三次结果相同：换输入/换工具/直接说卡在哪 | 开 |

三档预设：`off` / `conservative`（只留 brevity）/ `standard`（四个全开）。

## 接在哪一层，以及为什么必须是这一层

`lib/fast-mode/extension.ts` 是 `hidden: true` 的 `InlineExtension`，只挂
`before_agent_start`，只写 `event.systemPromptOptions.sections.fast_mode`，返回
`undefined`。

- **用 sections，不用 `systemPrompt`**：sections 是增量 seam，SDK 会把段落 diff
  成一条 system patch，没变就零成本，缓存前缀保住。返回 `systemPrompt` 会整段替换，
  每轮一次 cache miss。
- **必须排在 `createPurgeExtension` 之前**：purge 走 `forceSystemPrompt`（整体替换、
  不带 sections），排在它后面的 handler 才改得到最终发出去的那份。
  `lib/fast-mode/extension.test.mjs` 直接读 `lib/rpc-manager.ts` 源码钉住这个顺序。
- **段落字节确定**：同配置渲染同字符串，否则每轮都算「变了」，白付一次 patch。

## 脚本对照表：什么时候用哪个

| 我想…… | 命令 | 它回答什么 |
|---|---|---|
| 验收功能没坏 | `node scripts/check-fast-mode.mjs` | 12 个文件的测试是不是全绿（退出码 2 = 清单本身坏了） |
| 确认它真的在跑 | `node scripts/check-fast-mode.mjs --live` | 设置里是什么、有没有真跑过、没跑过该做什么 |
| 量一次会话的成本 | `node scripts/measure-turns.mjs --all` | 轮次/输出/缓存/工具/步骤一次打完 |
| 看这一档现在怎么样 | `--by-preset` / `--last` | 按档位切分、只看最近一次会话 |
| 拿到 A/B 判定 | `--ab`（先 `--ab-plan`） | 更快/更慢/混合/更省/样本不足，附缓存归因 |
| 验证断言真的会红 | `node scripts/mutation-smoke.mjs` | 六条故意破坏是否都被测试抓到 |
| 验证成本没退化 | `node --experimental-strip-types scripts/microbench.mjs` | 段落构建、设置读取、状态转换的 µs/call |

`fast-mode-live.mjs`、`fast-mode-checks.mjs` 不是入口，是被上面几个入口共用的模块（清单与体检逻辑只能有一份）。

## 模块图

```
presets.ts            存档位 id 列表（client-safe，无 import）
   ↑
guidance.ts           参数/预设 → 段落文本；纯函数，只 import ./presets
   ↑                  （D11：不许引入 node:fs / process.，每轮路径上不许有 I/O）
settings.ts           读写 <agentDir>/pi-web/settings.json 的 fastMode 块；按 mtime 缓存（D10）
   ↑
command.ts            /fast 的参数解析、状态文案、补全；纯函数
   ↑
extension.ts          唯一与 SDK 打交道的地方：before_agent_start 段落 + /fast 命令 + 档位条目
```

`extension.test.mjs` 直接读源码钉住这张图（每个文件允许 import 哪些同目录模块），图与代码不可能各自漂移。
方向只有一个：越往下越认识上面的，反过来不允许——所以 `guidance` 永远不知道设置文件在哪，`presets` 永远不知道段落在说什么。

## 存储

`<agentDir>/pi-web/settings.json` 的 `fastMode`：

```json
{ "fastMode": { "preset": "standard", "switches": { "changeApproach": false } } }
```

- 放 pi-web 自己的文件，不放 pi 的 `settings.json`（pi CLI 也读那个文件，它没有这个面板）：
  复用 `lib/artifact-settings.ts` 的 `readStored` / `updatePiWebSettings`。
- **默认 off**，文件坏掉也读成 off：错的「开」要每轮付提示词字节。
- `switches` 只在调用方显式传进来时才落盘；只发 `{preset}` 时**不冻结**旧档位的开关值
  （否则 `{preset:"standard"}` 会写成四个 `false` 覆盖）。

## 会话里的档位痕迹

每次档位**变化**时写一条 session entry `pi-web:fast-mode`（`{preset, switches}`），
同一个档位连续跑多少轮都不再写。

- 用 `pi.appendEntry`：custom entry **不进 LLM 上下文**，所以不影响请求、不影响缓存，也不占 token。
- 只在变化时写：每轮一条会把会话记录撑成噪音，日志比它描述的东西还难读。
- **`preset` 一个字段说完全部**：`off` 就是「这一轮没发段落」。早期版本还写过一个 `active` 布尔，
  与 `preset` 表达同一件事——两种编码必然漂移，已停写；读侧保留兼容（`active: false` 仍按 `off` 处理）。
- 写入失败只吞掉，不打断回合——丢一条面包屑不值得让一轮失败。


## 路由

`/api/fast-mode`：

- `GET` → `{ preset, switches }`，只读，无守卫（与 `/api/artifacts/settings` 一致）。
- `PUT` → 404 之外的唯一写入口：`isApiRequestAllowed` 403、非 JSON 415、
  `normalizeFastModePatch` 校验失败 400、写失败 500。`{switches}` 可单独发，用于单开关拨动。

## 命令

`/fast` 由同一个扩展注册（`pi.registerCommand`），不用开设置页：

- `/fast` → 当前档位与开着的开关（`Fast mode: standard (brevity, verifyFirst, actFirst, changeApproach). …`）
- `/fast off|conservative|standard` → 直接切换，写的是设置页同一个 store
- 其它参数 → 警告并列出合法值；写入失败 → `error` 通知，不改内存态
- 参数补全只给三个档位 id

`pi.registerCommand?.()` 是可选调用：老 SDK 或没有命令 API 的宿主里，缺命令不能连带把提示词段落一起拖死。
文案是英文，理由同 `lib/agent-guide-extension.ts`——服务端拿不到浏览器 locale。

## 面板

Settings › General › Chat › Server switches 里的 `FastModeSettingRow`：三选一
（关闭 / 保守 / 标准），不是开关——`conservative` 是真实状态（只留 brevity），
并成一个 boolean 会把用户唯一保留的那条规则静默丢掉。写入走 `PUT {preset}`，
乐观更新、失败回滚并显示 `settings.fastModeFailed`。保存序列与回滚**不再各自实现**：
与布尔行共用 `hooks/useServerSetting.ts`（读写/乐观/回滚/单调 gate），规则本体在
`components/server-setting-machine.ts` 里是纯函数、有无渲染器都能测。
预设 id 列表放在 `lib/fast-mode/presets.ts`（client-safe），`guidance.ts` 的类型从它派生，
所以面板、路由、段落三者不会各自漂移。

## 验证

一条命令跑完这层清单（12 个文件）：

```sh
node scripts/check-fast-mode.mjs        # 或 --json
node scripts/check-fast-mode.mjs --live # 这台机器上它到底跑没跑起来
```

`--live` 分得清三件事：**配置**（设置文件说下一次会发什么）、**执行**（会话里有没有 `pi-web:fast-mode` 条目）、
**段落真的进了请求**（transcript 会记录 system 消息，所以最近会话里能不能找到 `Speed rules for this session` / `<fast_mode>`）。
三层按**修复顺序**排列，任一为空时只让你修**最上面那层**：

```
  [ok  ] configure  standard
  [MISS] run        0 条目
  [MISS] prompt     未见段落

未全绿：先修第 2 层（run）
```
三者不一致时它会直说，例如「跑过，但最近会话里没看到段落（可能是开关刚关掉，或那是旧会话）」。
写入的代码不会自动生效——宿主进程要重启才会加载它，所以新写好的扩展在 `--live` 里通常先是「尚无使用证据」，并给出三步：
重启宿主 → 发一轮对话 → 重跑 `--live` 看条目数从 0 变成 ≥1。已经在用时不打这份清单。

**文档里的命令本身也有测试**：`scripts/doc-commands.test.mjs` 把本页列出的每个 flag 都真跑一遍
（空 sessions 根、逐条断言退出码 0 且有输出）。文档给出跑不通的指令，比没有文档更糟。

还有一条**反向**命令，验证这些测试真的会红：

```sh
node scripts/mutation-smoke.mjs         # 破坏 → 跑 → 还原 → 报红绿；--id <name> 只跑一条
```

六条内置变异，跨两个模块：
`chat-branch` / `order`（rpc-manager 接线）、`section-name`（段落 key 字面量）、
`save-stale-ok` / `save-no-rollback` / `row-freezes-on-read-failure`（共享落盘状态机）。每条都必须 **RED**，
跑完自动还原并确认回到绿；锚点失效或留下备份会被判成 harness 错误（退出码 2），不会被当成通过。
`mutation-smoke.test.mjs` 守这份清单本身（锚点仍在、id 唯一、测试文件存在、还原写在 finally 里）。

退出码 0 全绿 / 1 有测试失败 / 2 清单本身坏了（文件不存在）——**清单坏掉不能看起来像通过**。
清单在 `scripts/fast-mode-checks.mjs`，`check-fast-mode.test.mjs` 守它（每个条目存在、是测试、覆盖四层）。

三层，缺一层就有假绿：

| 层 | 文件 | 证明什么 |
|---|---|---|
| 单元 | `lib/fast-mode/extension.test.mjs`、`command.test.mjs` | 段落写/删、档位解析、命令解析、设置往返、接线顺序（读 `rpc-manager.ts` 源码钉住「两个分支都在 purge 之前」）、段落字符预算 |
| 面板 | `components/FastModeSettingRow.test.mjs` + `fast-mode-row-helpers.ts` | 载荷解析（未知/缺失一律 `off`，不能点亮用户没选的档）、三个档各自独立的文案键、按钮来自 id 列表、失败回滚存在 |
| 路由 | `app/api/fast-mode/route.test.mjs` | 补丁校验与落盘、不丢其它 settings 键；**并且**走真实 handler + 真实信任门：200 / 403（外部 Origin）/ 415（非 JSON）/ 400（非法档位），被拒的写入不改文件 |
| **真实 SDK** | `lib/fast-mode/integration.test.mjs` | 用 `createAgentSession` + faux provider 起一个真会话：`standard` 时段落**确实进了拼好的 system prompt**，`off` 时一个字都没有；`/fast standard` 改盘且**不触发模型调用**；`/fast` 与非法参数都被 handler 吃掉（未注册的命令会被当文本发给模型，faux 的 `callCount` 会抓到）；档位变化才写一条 `pi-web:fast-mode`；同条消息里的兄弟调用**确实并发**；**workspace chat** 用自己的 base prompt（`chatWorkspacePrompt`）+ `noContextFiles` 起会话，段落照样进得去且**没有多出任何工具** |
| **整条链** | 同一文件最后一条 | 切开关 → 请求带/不带段落 → 记录按序出现 `off, standard` → 用 `scripts/measure-turns.mjs` 的 `segmentRecords` 读同一份记录结果一致 → 落盘设置也是 `standard`。四段各自单测都绿也可能互相矛盾，这条是唯一能抓到的 |
| **组合顺序** | 同一文件的组合用例 | artifact / agent-guide / fast-mode / force 替身按真实顺序注册：四段都在最终提示词里、治理在最外层；治理放最前时 fast-mode **进不去**——顺序是功能约束 |

段落有字符预算：`FAST_MODE_SECTION_BUDGET = 1350`（`standard` 现在 1,281 字符，≈310 token/请求）。
预算写成测试而不是运行时检查——涨过它应该在 review 里被拦下，而不是悄悄让每一轮都变贵。
本段**不与 `agent-guide` 重复**：通用简洁规则（lead with the answer / no preamble / no closing summary）
由行为指南拥有，这里只说工具工作的叙述与完整性兜底（见决策记录 D6b）。
也**不越过交付物**：被要求产出的整个文件/完整 artifact 永不缩短，简洁只削评论（D6c）。

## 不做什么

- 不改 `thinkingLevel`、不改模型、不改工具集、不改请求体——这些是 `fork-models.md` 的地盘。
- 不给 **chat-only** 会话装：那个分支发的是整段 exact prompt，旁边再插一段会被丢弃或与之打架；
  它也不注册 `/fast`（测试读 `rpc-manager.ts` 源码钉住这一分支没有我们的工厂）。
  workspace chat 与普通会话都装，两者都在 purge 之前。
  代价说清楚：在 chat-only 里打 `/fast` 不会生效——**没有注册的命令会被当作普通文本发给模型**
  （`integration.test.mjs` 有一条专门演示：模型确实收到了 `"/fast off"`，设置没变）。
  想在那里切档，走设置页。
- 不接管系统提示词，因此与 purge、artifacts、agent-guide 三个段落生成器互不覆盖。
- **不做工具输出截短**（fast-mode 上游还有这一块）。用 `node scripts/measure-turns.mjs --tools` 量过本机基线：
  7 个工具结果共 **1,131 字符**，占全部消息字符的 **2.8%**，工具总耗时 **0.7s / 134s**。
  成本不在这里：一条 9,134 token 的回复就占 46% 墙钟。真要做，先等 `--tools` 显示它变了。

## 怎么拿到真实 A/B

体感不算数，按这个顺序跑一遍就有判定：

1. `node scripts/measure-turns.mjs --ab-plan` —— 它会直接说现在该切哪一档、还差几轮
2. 设置页把快速模式拨到 **关闭**，正常干 6 轮以上的活（少于 6 轮会被判 `insufficient`）
3. 拨到 **标准**，再干 6 轮相近的活
4. `node scripts/measure-turns.mjs --ab`

同一份日志还能按档位看细节：`--by-preset`（轮次/输出/中位秒）、`--tools`（工具输出占比）、
`--steps`（并行度、重复调用）——后两个在有档位条目时都会先打一行 `[preset] …`。

注意：档位条目只从有了这段代码之后才写，迁入以前的会话一律 `unrecorded`，不参与比较。

## 度量

真效果按会话日志算，不按体感：`~/.pi/agent/sessions/**/*.jsonl` 里每条 assistant
消息带 `usage.output` 与时间戳，比「同一任务开/关两档的 output token 与墙钟」即可。
基线（2026-11-21，8 轮）：`output 12,360`、`cacheRead 158,464`、墙钟 133s。

三个子命令，各回答一个「要不要做」的问题：

| 命令 | 回答的问题 | 本机基线 |
|---|---|---|
| `--tools` | 工具输出值不值得截短？ | 1,131 字符 / **2.8%** 消息字符，工具 0.7s/134s → 不值得 |
| `--steps` | 往返次数值不值得优化？ | 7 步 7 调用、**并行 0%**、重复 0% → 全串行，每次往返都付一次 prefill |
| `--by-preset` | 开与关到底差多少？ | 按 `pi-web:fast-mode` 条目切分；本次迁入前的会话一律 `unrecorded` |
| `--ab` | 直接给判定 | 两侧都有记录时自动选 `off` 作基线、`standard` 作处理组，调 `--compare` 的判据；缺一侧就说缺什么，样本不够就说**每侧还差几轮** |
| `--ab-plan` | 下一步该干什么 | 先过「真跑过没有」这道闸：没有任何 `pi-web:fast-mode` 条目时只给「重启 → 发一轮 → 复查」三步并停下，避免为一次空跑攒六轮；有证据才给切档与轮次 |
| `--all` | 上面全部一次打完 | 日常只看这一条 |
| `--last` | 最近一次会话 | 「这一档现在怎么样」是单会话问题，池化数字会把新跑的一轮埋进历史 |
| `--compare <ISO>` | 这次改动到底快了没？ | 每侧 <6 轮直接 `insufficient`；判定同时看中位轮次与 `output/turn`：更快但更啰嗦 = `mixed` |

`--steps` 的结果直接改写了一段提示词：`actFirst` 里新增「互不依赖的读取/命令放在同一步一起发」。
pi 会把同一条消息里的兄弟调用并发跑，所以这条规则省的是往返，不是模型时间。
这条前提不是假设：`integration.test.mjs` 用两个各睡 150ms 的自定义工具验证过——第二个调用在
第一个结束前就已开始，整轮 <280ms（串行必然 ≥300ms）。


Files: `lib/fast-mode/guidance.ts`、`lib/fast-mode/presets.ts`、`lib/fast-mode/settings.ts`、
`lib/fast-mode/command.ts`、`lib/fast-mode/extension.ts`、`lib/fast-mode/extension.test.mjs`、
`lib/fast-mode/command.test.mjs`、`lib/fast-mode/integration.test.mjs`、
`app/api/fast-mode/route.ts`、`app/api/fast-mode/route.test.mjs`、`components/FastModeSettingRow.tsx`、
`scripts/measure-turns.mjs`、`scripts/measure-turns.test.mjs`、
`lib/rpc-manager.ts`（普通会话分支接线）。
