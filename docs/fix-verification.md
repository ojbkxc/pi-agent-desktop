# pi-agent-desktop 修复与验证报告（2026-11-22）

## 结论

基线中 4 个失败用例全部修好，**无新引入失败**。

| 检查项 | 基线 | 修复后 |
|---|---|---|
| `npm test` 全量 | 4 失败 | **5491 pass / 0 fail**（连跑两次一致，5540 tests） |
| `lib/mcp-host.test.mjs` | 49 pass / 1 fail | **50 pass / 0 fail**（1 skip 为既有的符号链接权限跳过） |
| `lib/relay/connector.test.mjs` | 18 pass / 2 fail | **20 pass / 0 fail** |
| `tsc --noEmit` | exit 0 | exit 0 |
| `npm run lint` | 0 err / 22 warn | 0 err / 22 warn |

> 基线 `npm test` 的 pass 计数（4371）是任务中途采样的部分结果，与当前树的 5540 总量不可直接相减；可比口径是失败集合——基线的 4 个失败全部消失，且没有新增。

## 修复 1：MCP 空闲回收把状态整条删掉（`lib/mcp-host.ts`）

**症状**：`lib/mcp-host.test.mjs:806` `TypeError: Cannot read properties of undefined (reading 'state')`——第二次 `prepareForPrompt` 后 `sessionStatus("docs", docs)` 返回 `undefined`。

**根因**：空闲回收与「连接刚被打开」的竞态。

- `lib/mcp-host.ts:781` `letGo()`：`attempt.state === "connecting"` 时调 `forgetMcpStatus()`，**删除**整条记录（而不是标 `closedAt`）。
- `lib/mcp-host.ts:766` `update()`：`if (attempt.released) return;` —— 记录被删后，连接随后 settle 也不再写回。
- 空闲定时器在连接仍处于 `connecting` 时触发 → `release()` → `unregister()` → `letGo()` → 删记录；随后 handshake 完成，但 `update()` 因 `released` 早退。于是测试 `:800` 的 `"connecting"` 断言能过、`:806` 拿到 `undefined`。

**修法**：

1. `update()` 中连接 settle 时重开空闲窗口（settle 是活动，不是空闲），使上一窗口的 sweep 无法误杀刚报到的连接。
2. 拆出 `idleTimeout()` / `idleOut()`：sweep 遇到「transport 已打开但尚未 settle」的 attempt 时再等一个窗口；`started=false` 的注册仍照旧被 `unregister()` 放弃，不会无限占用。

## 修复 2：relay 两个用例的 `'closed by desktop'`（`lib/relay/connector.test.mjs`）

**症状**：`:350` 与 `:404` 两个用例以未捕获拒绝 `'closed by desktop'` 失败——该文本来自 `relay/server.mjs:247` 关闭手机端 ws 的 reason（4000）。

**根因**：三处**测试侧**时序竞争，产品侧行为正确（已用反证确认：把响应体留空不读再 `close()`，HEAD 版本用例 1 仍通过，说明「未读 body 被 error」不产生未捕获拒绝）。

- **A. `pairThroughTap`（`connector.test.mjs:137`）审批竞争**：`onWaitingForApproval` 里用固定 `setTimeout(20)` 后取 `pendingPairings()[0].id`，但桌面的 `session.pairing` 要晚一个往返才存在（`lib/relay/phone-client.ts:203` 先 `send` 再回调）。机器繁忙时 20ms 不够 → `pending` 为 `undefined`（即全量并发下的偶发失败 `reading 'id'`）→ 审批从未发生 → 桌面 `PhoneSession.timer`（`connector.ts:186`）`handshake timeout` → 4000 关连接。
- **B. 用例 1（`:373`）未等桌面感知手机离开**：`await Promise.all(idle.map(p => p.closed))` 只保证手机侧 socket 关闭；经 tap 多一跳，桌面尚未收到 `KIND_CLOSE`（实测此时 `sessions.size === 2`），新隧道于是成为第 3 个 pending，被 `connector.ts:370` 的握手上限立刻关掉。
- **C. 用例 2 的 `handshakeTimeoutMs: 400` 同时作用于合法配对**，负载高时配对本身被掐死。

**修法**（只动测试，+37/−7）：

- 新增 `pendingPairing(env)` 轮询助手（10ms × 300 上限，找不到就明确报错），取代固定 20ms 睡眠。
- 用例 1：闭合 idle 手机后先等 `sessions.size` 归零并新增该断言；响应体在 `close()` 前 `readAll` 并断言 `JSON.parse(...).method === "GET"`，把原来 `length >= 0` 的**恒真断言换成有效断言**。
- 用例 2：`handshakeTimeoutMs` 400 → 2000，附注释说明（重放仍由超时以 4000 关闭，`replay.closed === 4000` 断言未改）。

未删除、未放宽任何既有断言，未 skip。

**为何不改产品侧**：把 `PhoneTunnel.fail()` 对未读流改成 AbortError 会改掉真实手机端依赖的 `RelayClosedError.code`（4000/4001 驱动「重新配对」UI）语义，且修不了 A/B/C；削弱 `connector.ts:370` 的陌生人握手上限更不该做。

## 顺带清理

排查期间发现工作区被并发进程写入过调试代码，已清理：

- `lib/relay/connector.ts` 里的 `appendFileSync` + `dbgLine(...)`（写 `%TEMP%\relay-dbg.log`）
- `lib/relay/phone-client.ts` 里全部 `[DBG]` / `PI_RELAY_DEBUG` / `tagged()` 诊断代码（清理后两文件与 HEAD 一致，`git diff` 为空）
- 临时文件 `lib/relay/.head-probe.mjs`、`relay-dbg.log`

## 最终改动清单

```
 app/api/project-trust/route.test.mjs     |  9 ++++---
 app/api/subagents/runtime-route.test.mjs | 11 ++++++++
 app/api/worktrees/route.test.mjs         |  6 +++--
 lib/chat-file-access.test.mjs            |  5 +++-
 lib/compaction-wiring.test.mjs           | 10 +++++---
 lib/mcp-host.ts                          | 36 ++++++++++++++++++++++----
 lib/relay/connector.test.mjs             | 44 +++++++++++++++++++++++++++-----
 lib/worktree.test.mjs                    | 15 ++++++++---
 scripts/test-platform.mjs                | 28 +++++++++++++++++---
 9 files changed, 137 insertions(+), 27 deletions(-)
```

其中前 6 个（`app/api/*`、`lib/chat-file-access.test.mjs`、`lib/compaction-wiring.test.mjs`、`lib/worktree.test.mjs`、`scripts/test-platform.mjs`）是本次开工前就存在的未提交在途改动（Windows 8.3 短路径 / `realpathSync.native` 相关），未回滚，全程保留。

本次新增的产品/测试改动只有两处：`lib/mcp-host.ts`、`lib/relay/connector.test.mjs`。其余新增为文档。

## 剩余风险

1. `lib/mcp-host.ts` 的 `idleOut()` 在「transport 已打开但服务端永久不应答」时会持续顺延、不回收，直到传输层自身超时。生产默认 `idleMs`（10min）远大于 SDK 请求超时，通常先 settle；属有意取舍。
2. `scripts/test-platform.mjs` 被 5 个测试文件复用，属测试基础设施改动，不改产品行为但改动面较大，建议随提交说明。
3. 未验证 `next build` 产物与 e2e（`AGENTS.md` 明确禁止在 dev 期间跑 `next build`，会污染 `.next`）。

## 另一项未处理：上游分叉

`pi-agent-desktop` 与 `upstream`（`abcwyc/pi-agent-desktop`）已严重分叉：**behind 451 / ahead 323**，merge-base `eaf955fd`。upstream 最新 `2026-11-19 chore(homebrew): update cask to 0.8.7`，本地最新 `2026-11-21 release: v0.8.7 覆盖式重发`。上游同步不在本次范围，需单开一轮（流程见 `docs/fork-sync.zh-CN.md`）。
