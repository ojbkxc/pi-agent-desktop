# Fork modules with no topic note

docs-scan（2026-11-23）全量核对后确认：`AGENTS.md` 的 File Map 与
`docs/agents/*.md` 的 `Files:` 段**零失效路径**（132 + 199 条全部存在），
版本号四源一致。真正的债在覆盖面上——下面这些模块代码体量不小、行为不平凡，
却没有任何一篇 topic note 说明它为什么这样设计。

这份清单是它们的入口索引。每一条给出：模块、体量、它解决什么、改动前必须知道的
约束、以及相邻（已存在）的文档。**写在 AGENTS.md 之外**，因为它不是架构总览，
而是一份「还没写文档的地方」的待办与最小上下文。

## 1. `lib/compaction-extension.ts`（20 KB）— 压缩模型的降级链

`session_before_compact` 扩展：按策略里的压缩模型链逐个尝试，全都不行时把这一轮
交还 SDK 自己压缩。

改前必读：

- **必须先于 purge**：purge 用 `forceSystemPrompt` 整体替换提示词，压缩扩展读的是
  同一条 seam；顺序反了，压缩请求会带着破甲后的提示词跑（`docs/agents/fork-fast-mode.md`
  记的是同一条排序约束）。
- 一次失败要能继续试下一个候选，而不是整轮放弃；候选只来自**已存凭据**的模型
  （`lib/compaction-policy.ts` 的 `candidatesFromModels`）。
- 成功时保留 `summary` / `firstKeptEntryId` / `tokensBefore` / `usage` 四个字段；
  丢掉 `usage` 会让成本统计少一笔。

相邻文档：[fork-fast-mode.md](fork-fast-mode.md)（段落顺序）、[fork-sessions.md](fork-sessions.md)（压缩事件）。

## 2. `lib/compaction-policy.ts`（19 KB）— 本仓自己的压缩策略

存在 `~/.pi/agent/pi-web/settings.json` 的 `compactionPolicy` 段，pi CLI 看不到。

改前必读：

- 阈值按**档位占比**算（均衡 50% / 长上下文 80%），不是绝对 token 数——模型窗口
  差异太大，绝对值会让小窗口模型永远触发。
- 候选模型只列**已存凭据**的：列出来却点不动，比不列更糟。
- 设置读取必须容错归一化（`NaN`、负数、未知枚举一律落回默认），写侧不接受越界值。

## 3. `lib/agent-teams-assignments.ts`（27 KB）— 工单派活的判据层

首次分配 / 改派编排（#54 的服务端可测核心）。

改前必读：

- **`expectedUpdatedAt` 是乐观锁**：不匹配就 409，磁盘不变。别把它当提示字段。
- 首次分配遇到「活跃派活」也是 409，不是覆盖。
- `toMember` 不在名册 → 404（不是 400）：调用方靠这个区分「打错名字」与「名册过期」。
- 这里只做判定与写盘，不发会话命令；投递在 `lib/agent-teams-members.ts`。

相邻文档：[agent-teams-design.md](../agent-teams-design.md)。

## 4. `lib/mcp-import-cli.ts`（36 KB）— 从别的 CLI 粘贴命令并解析

把 `claude mcp add` / `codex mcp add` / `pi mcp add` 这类命令解析成 MCP 服务器
配置，并给出可读的「这条命令缺什么」提示。

改前必读：

- 解析目标是**字符串命令**，不是 shell：不执行、不展开变量，只按词法与已注册的
  flag 表解析。任何执行路径都是缺陷。
- 错误码是稳定契约（`cli-usage` / `invalid-uv` 等），前端按码出文案，别改成自由
  文本。
- 三种 CLI 的 flag 语义不同（`--transport`、`--header` 的位置与重复语义），逐家
  对齐上游文档；不要合并成一套「通用」规则。

## 5. 其它（小，但同样零文档）

| 模块 | 一句话 |
| --- | --- |
| `lib/attention.ts` | 「Needs you」收件箱的判定：谁在等、谁完成；跨会话聚合，不持有会话 |
| `lib/model-catalog.ts` | 远程 provider 目录的读写与合并（`fork-models.md` 只覆盖了模型页行为） |
| `lib/agent-teams-unattended.ts` | 无人值守判定，被 `fork-provider-outage-resume.md` 间接提到 |

## 为什么它单独成篇、而不是并进现有 topic note

`AGENTS.md` 是**架构索引**：它回答「这个功能由哪些文件组成」，每篇 topic note 对应
一个功能面。上面这些条目回答的是「这块还没人写文档，改它之前要先知道什么」——
性质不同，混进某个功能篇会让那一篇失焦。所以它作为索引里的一行存在（门禁要求
`docs/agents/` 每篇都可从 AGENTS.md 到达），等其中任何一块长出完整的设计说明，
就把它挪进对应的 topic note 并从这里删掉。
