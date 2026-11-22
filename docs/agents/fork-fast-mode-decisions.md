# 快速模式：决策记录

> 给下一个要动这块的人（或 agent）。这里是**为什么**，实现细节在 [fork-fast-mode.md](fork-fast-mode.md)。
> 每条都带当时的实测数字或代码事实；没有数字的写在「未验证」。

## 先看这一节：已经否掉的，不要重做

| 想法 | 为什么否掉 | 证据 | 记录 |
|---|---|---|---|
| 搬上游的「工具输出截短」 | 你的负载里它不是成本 | 1,131 字符 = 消息字符的 **2.8%**，工具耗时 0.7s / 134s | D4 |
| 给段落字符串加缓存 | 1.18 µs 是噪音，缓存只会多一条失效路径 | 20,000 次平均：构建 1.18 µs、解析 0.12 µs（对照：文件读 258 µs，那个才是 D10 修的） | D11 |
| 按「无工具会话」缩短段落 | pi-web 里不存在无工具声明的提示词 | SDK 缺省 `selectedTools = ["read","bash","edit","write"]`；chat 是执行期拦截；清空 active tools 后该字段仍非空 | D12 |
| 删掉关档时写的那条 session 条目 | 它是档位边界，删了会把切换后的轮次算到上一档 | 一条 201 字节；去掉边界后 `standard, off` 两组塌成一组 | D13 |
| 把 DSH 的 Cordis 插件硬塞进 pi | 宿主的插件模型、钩子、UI 挂载点全不同 | 需要整层 Service/Event 适配，成本远超重写 | 见 fork-fast-mode.md 开头 |

**复核方式**：每个数字都能重跑——`--tools`（2.8%）、`--ab`/`--compare`（判定）、`--live`（真的在跑吗）。
想法重新出现时，先跑对应命令，再决定要不要推翻。

**成本数字也有基线**：`node --experimental-strip-types scripts/microbench.mjs`（`--json` 机读）。
四条：段落构建（限 12 µs）、缓存命中读（限 500 µs）、缓存未命中读（仅报告）、`reduceSave` 转换（限 5 µs）。
本机实测 2.02 / 28.37 / 228.09 / 0.15 µs。超限即退出 1——D10、D11 的结论从「文档里的历史」变成「可回归的常量」。

## 已知取舍（接受，不是遗漏）

| 取舍 | 为什么接受 | 证据/兜底 |
|---|---|---|
| chat-only 里没有 `/fast`，输入会当普通文本发给模型 | 那个分支发整段 exact prompt，加第二个扩展会破坏「一段 prompt + 零扩展」的不变量 | 集成测试演示模型确实收到 `"/fast off"` 且设置未变；文档写明走设置页 |
| 关档也写一条 201 字节条目 | 它是档位边界，删了会把切换后的轮次算到上一档 | 去掉边界后 `standard, off` 两组塌成一组（测试） |
| 每轮请求常驻约 1,281 字符段落 | 提速的代价就是这个；比「重新解释一遍任务」便宜 | `FAST_MODE_SECTION_BUDGET` 测试；microbench 2 µs/轮构建 |
| 每轮一次 `stat`（缓存命中 28–45 µs） | 换取外部编辑与多进程写入的即时性 | microbench 限 500 µs，超限即失败 |
| 外部写入若同 mtime 同 size，可能读一轮旧值 | 概率极低，下一轮 stat 自行纠正 | D14 写明；写侧自己清缓存保证 read-your-write |
| 默认 `off`，装好人却没效果 | 错的「开」每轮付 token，错的「关」只是没提速 | D6；`--live` 会直接说「尚无使用证据」 |
| `mutation-smoke` 会临时改产品文件 | 这是「断言真的会红」的唯一可靠办法 | 还原写在 finally、拒绝遗留备份、跑完再绿跑一次 |

## 起点：一次真实会话的账

2026-11-21，`deepseek-v4.1-flash`，`thinkingLevel: off`，8 轮：

| 事实 | 数值 |
|---|---|
| 墙钟 | 134s |
| 输出 token | 12,360 |
| 其中**一条**回复 | 9,134 token / 61s（46% 墙钟） |
| 缓存命中 | cacheRead 158,464 |
| 工具结果总量 | 1,131 字符 = **2.8%** 消息字符，工具耗时 0.7s |
| 步骤 | 7 步 7 调用，**并行 0%**，重复 0% |
| 网关 | TTFB 0.7–1.3s |

结论：慢在**吐字量**和**往返次数**，不在模型本身，也不在工具输出。

## 决策

### D1 只做提示词侧
不改模型、不改 `thinkingLevel`、不改工具集、不写请求体。
**理由**：D0 的账里真正可控的是「写多长」和「几轮」。思考档位属 `fork-models.md`，越界会与那边的设置打架。
**否决的替代**：自动降档（会让复杂任务悄悄变差，且用户无法预期）。

### D2 走 `before_agent_start` 的 `sections`，不返回 `systemPrompt`
**理由**：sections 是增量 seam，SDK 把段落 diff 成一条补丁；未变就零成本、前缀缓存保住。返回 `systemPrompt` 每次都是整段替换 = 每轮一次 cache miss。
**硬约束**：`lib/purge/extension.ts` 用 `forceSystemPrompt` 且**必须最后**注册。本扩展因此必须排在它之前——`extension.test.mjs` 直接读 `rpc-manager.ts` 源码钉顺序，两个分支（普通会话、workspace chat）都管。
**运行期证据**（`integration.test.mjs`）：把 artifact / agent-guide / fast-mode / 一个 force 替身按真实顺序注册，最终 `systemPrompt` 里四段俱在、治理文本在最外层；把治理放在最前、fast-mode 放后面，fast-mode 段落**完全进不了**最终提示词。顺序要求不是风格问题，是功能问题。

### D3 三档而不是布尔开关
`off / conservative / standard`。`conservative` 是「只保留精简输出」的真实状态；并成 boolean 会把用户唯一想要的那条规则静默丢掉。

### D4 不做工具输出截短
上游 fast-mode 有这一块，本机实测它只占 **2.8%** 字符、**0.5%** 墙钟（0.7s/134s）。做了也不会被感知，且要多维护一条 `tool_result` 改写路径。
**复核方式**：`node scripts/measure-turns.mjs --tools`，比例变了再谈。

### D5 加了「互不依赖的调用放在同一步」
因为 `--steps` 显示**并行 0%**：7 次往返每次都付一次 prefill + ~1s 网关。
前提不是假设：集成测试用两个各睡 150ms 的自定义工具证明 pi 会让兄弟调用重叠（整轮 <280ms，串行必然 ≥300ms）。

### D6 默认 `off`
错的「开」每轮都要付提示词字节；错的「关」只是没提速。所以默认关，且设置文件坏掉也读成 `off`。
段落有字符预算（`FAST_MODE_SECTION_BUDGET = 1350`，现 1,281 ≈ 310 token/请求），写成**测试**而不是运行时检查——涨过它应该在 review 被拦。

### D6b 不与行为指南重复
`agent-guide-extension.ts` 的段落默认也在每次请求里，已经写了「lead with the answer, no preamble, no closing summary」。
重复说一遍等于同一条指令付两次 token。所以本段只说指南没说的那半：**工具工作的叙述**（预告调用、复述工具结果、进度日志、最多一行计划）与**完整性兜底**（代码/命令/路径/必要提醒不许缩掉）。
测试会读 `agent-guide-extension.ts` 确认它仍拥有那条规则，并断言本段不再出现 `closing summary` / `no preamble` / `lead with the answer`。
代价：用户把行为指南关掉时，这段不再自带通用简洁规则——那是有意的取舍（关了指南就是不要那套行为约束）。

### D7 会话里只记「变化」，且只记 `preset`
- 每轮一条 entry 会把记录撑成噪音；
- `active` 与 `preset` 表达同一件事（`off` 就是没发段落），两种编码必然漂移 → 停写 `active`，读侧兼容旧条目。

### D8 设置行的竞态规则只有一份
布尔行与三档行共用 `hooks/useServerSetting.ts` + `components/server-setting-machine.ts` 的 reducer：
旧响应不得覆盖新操作、失败回滚到**最后确认值**（`baseline`）而不是另一个乐观值、GET 失败不冻住行（`value === null` = 显示兜底 + 仍可点）。

### D9 度量先行，三个问题三条命令
| 问题 | 命令 | 判据 |
|---|---|---|
| 工具输出值不值得截短 | `--tools` | 占消息字符比例 |
| 往返值不值得合并 | `--steps` | 并行度、重复调用 |
| 这次改动到底快了没 | `--ab` / `--compare` | 每侧 ≥6 轮；中位轮次变化 ≥15% 才算快/慢，且与 `output/turn` 一致才算赢：更快但输出涨 ≥15% = `mixed`，更慢但输出降 ≥15% = `mixed`，中位不变而输出降 ≥15% = `leaner`，其余 `flat` |

`unrecorded`（迁入前的会话）永不计入比较。

**缓存归因**：`cacheReadShare` 变化 ≥20 个百分点时，判定后追加一句——命中掉下来就提示「多出的 prefill 很可能吃掉收益，先看是不是改了提示词前缀」，命中升上去就提示「同样的时间数字更可信」。只在有判定时才说，避免在 `insufficient` 下把未测数字读出结论。

### D6c brevity 不越过交付物
`artifact-guide` 要求「完整 HTML 文件 + 块外一两句说明」。模型只读到「更短」时可能把产物本身摘要掉，
所以本段明确划线：**被要求产出的内容（整个文件、完整 artifact）永不缩短，简洁只削评论**；
同时不复制 artifact 指南自己的一两句评论预算（那是它的地盘）。
测试双向核对：artifact 指南仍要求 `one complete file`，本段必须含 `never shortened` / `deliverables`，且不得出现 `one or two sentences`。

### D10 每轮只 stat 一次，不重读设置文件
`readFastModeConfig` 在 `before_agent_start` 里跑，也就是**每一轮**，且跑在服务端事件循环上。
读 4 KB 的 `pi-web/settings.json` 并解析：实测 **258 µs/次**；按 path + mtime + size 缓存后 **45 µs/次**（本机 300/500 次平均）。
写侧（`/api/fast-mode`）同进程写文件 → mtime 变 → 立即失效；外部编辑同理；坏文件**不缓存**，修好就立刻生效。

### D11 不缓存段落字符串（1.18 µs，不值得）
量过才决定不加：`buildFastModeSection()` **1.18 µs/次**、`resolveFastModeConfig()` **0.12 µs/次**（本机 20,000 次平均）。
一轮请求以秒计，这点成本是噪音；加一层按配置 key 的缓存只会带来失效路径和新的 bug 面。
真正值得处理的是 D10 里那次 258 µs 的文件读——那也是唯一一处 I/O。
**保留的不变量**：`guidance.ts` 必须保持纯函数（只 import `./presets`，不许出现 `node:fs` / `process.`），
`extension.test.mjs` 直接读源码钉住这条——防止后人往每轮路径里塞 I/O。

## 测试真的会红吗（变异实验）

2026-11-22 做了三次故意破坏，每次跑完立即还原，最终 137/137 绿：

| 破坏 | 结果 | 结论 |
|---|---|---|
| 删掉 chat 分支的 `createFastModeExtension()` | **RED**（`a normal session wires it after the guides and before purge`） | 双分支注册被真守住了 |
| 把普通会话的注册挪到 `createPurgeExtension` 之后 | **RED**（同一条） | 「必须排在 purge 之前」不是注释，是断言 |
| 把 `FAST_MODE_SECTION` 从 `"fast_mode"` 改成 `"fast-mode"` | **GREEN——漏洞** | 所有引用都跟着常量走，改一处全体自洽，没人发现 |

第三条当场补了「钉住字面量」的测试（`assert.equal(FAST_MODE_SECTION, "fast_mode")`），再跑同一变异 → **RED**。
段落 key 是**对外可见的名字**（SDK 收到的 section、读提示词/转写的人看到的键），不是内部实现细节，必须钉。

### D12 不做「无工具会话」自适应（结论：目标不存在）
想法：chat-only 没工具，段落里「互不依赖的调用放在同一步」在那种会话里是死指令，按 `selectedTools` 缩短。
查证后否掉：`normalizeBuildSystemPromptOptions()` 在 `selectedTools` 缺省时给的是 `["read","bash","edit","write"]`；
pi-web 的 chat 是**执行期拦截**（`tool_call` 策略），chat-only / lean 只裁扩展、技能、上下文文件——**没有一个分支真的没有工具声明**。
实测把 active tools 清空后 `systemPromptOptions.selectedTools` 仍非空。既然没有可优化的目标，就按 D11 的口径不写这层代码：
实现、单测、集成测试一并回滚，只留下这条结论与证据，免得后人重做一遍。

### D13 保留「关档也写一条」——它是边界，不是噪音
怀疑过：`off` 条目等于告诉后来的分析「这里什么都没有」，是否纯浪费。
量完：一条 **201 字节**，且只在**变化时**写（一次开/关 = 2 条）。
更重要的是它**承重**：没有这条边界，切换之后的所有轮次会被算到上一个档位头上。
测试 `scripts/measure-turns.test.mjs` 里有一条专门演示这件事——带边界 → `standard, off` 两组；去掉边界 → 两组变一组、全部记成 `standard`。
结论：留着。真正该省的是「每轮一条」那种写法，那个从第一版就没做。

### D14 写后必读新值；并发命令是安全的
缓存按 mtime + size 判新旧，但**写侧自己清缓存**：否则一次落在同一时间刻度、长度又相同的写入会被当成「没变」，读回旧档位（`writeFastModeConfig` 里 `cachedConfig = undefined`）。测试用 `utimesSync` 把 mtime 改回旧值来复现这个场景。
残留边界（已在测试里写明）：**外部进程**的写入若既改了内容又恰好同 mtime 同 size，可能被读一轮旧值；下一轮 stat 就会纠正。
并发：`/fast` 在回合进行中被调用是安全的——两个 prompt 都 fulfilled、档位落到 `standard`，改动从**下一轮**开始生效（`integration.test.mjs` 里有一条专门跑这个）。

## 与本仓库其它模块的边界
- **不做**：pregenerated prompts、agent preset、per-model 路由——那些是 `fork-models.md` / `fork-tools-subagents.md` 的地盘。
- **不碰**：`prompt-inject.md` 式的用户正文（这是 pi-web，用户指令走 chat instructions / skills）。
- **不接**：成员会话（策略更窄），chat-only 与 workspace chat 已接（纯段落，不加工具）。

## 未验证
- 真实模型上的 A/B：需要用户实际跑够轮次；`--ab` 会报「还差几轮」。
- 长会话下的收益衰减：段落每轮都在，但输出量的变化未按会话长度分层统计。
