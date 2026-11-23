import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * rpc-manager 审计（2026-11-24）三条缺陷的源级契约。都是「一行写在错的地方」
 * 型缺陷，用可控 Date 重放代价过高，而它们的修法各有可辨认的形状，源级断言足以
 * 防止回退——真正跑通它们需要桩化整个 SDK 会话。
 *
 * D1（P1，进程级）：`inner.dispose()` 抛错不能再成为未处理拒绝。deferred 路径用
 *   `.finally(finishDispose)` 时，finishDispose 抛出会让整条链 rejected 且无人
 *   handle，Node ≥15 默认致命——一次 PTY teardown 失败会带走整个桌面服务与全部会话。
 * D2（P2）：`clearQueue()` 曾写在 try 之外，一抛错 `inner.abort()` 就不执行（Stop
 *   静默失效），而 `forceShutdownOnIdle` 已武装，10 分钟后强卸仍在跑的会话。
 * D3（P2）：`preflightResult` 的 `handled` 表示「命令就地处理、没起 run」，曾无条件
 *   记为「一轮完成」——假完成推送 + 用命令文本生成标题 + **可能自动批准团队计划**。
 */
const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");

test("D1: dispose failure is caught, and the deferred path cannot produce an unhandled rejection", () => {
  // dispose 调用必须在 try 里（此前是裸调用 + finally）。
  assert.match(source, /try \{\s*this\.inner\.dispose\(\);\s*\} catch \(error\) \{/, "inner.dispose() must be guarded");
  // 延迟路径用 then(onBoth) 而不是 finally(handler)。
  assert.match(source, /\.then\(finishDispose, finishDispose\)/, "the deferred dispose must not be a .finally()");
  // 代码里不得再有 `.finally(finishDispose)`（注释里提到旧写法不算）。
  assert.doesNotMatch(source, /^\s*\.finally\(finishDispose\)/m, "the old .finally(finishDispose) must be gone");
  // 回调也不能把 dispose 的失败盖住。
  assert.match(source, /\[pi-web\] session destroy callback failed:/, "onDestroyCallback is guarded too");
});

test("D2: queue recall cannot stop Stop from reaching the abort", () => {
  // clearQueue / recallParkedPrompts 都必须有各自的 try。
  assert.match(source, /try \{\s*cleared = this\.inner\.clearQueue\(\);\s*\} catch \(error\) \{/, "clearQueue is guarded");
  assert.match(source, /try \{\s*recalled = this\.recallParkedPrompts\(\);\s*\} catch \(error\) \{/, "recallParkedPrompts is guarded");
  // 默认值必须存在：失败时清空而不是 undefined。
  assert.match(source, /let cleared: \{ steering: string\[\]; followUp: string\[\] \} = \{ steering: \[\], followUp: \[\] \};/);
  // abort 仍在 try 里被 await（保住「先 abort 再回报」的顺序）。
  assert.match(source, /await this\.withFinalIdleReset\(\(\) => this\.inner\.abort\(\)\)/);
});

test("D3: a `handled` extension command is not recorded as a finished agent run", () => {
  // acceptPreflight 收 disposition，且只在非 handled 时置位完成标志。
  assert.match(source, /acceptPreflight = \(disposition\) => \{/);
  assert.match(source, /if \(disposition !== "handled"\) this\.agentRunNeedsCompletion = true;/);
  // 调用点把 SDK 给的 disposition 透传进来（不是无条件调用）。
  assert.match(source, /preflightResult: \(disposition\) => acceptPreflight\(disposition\)/);
  // 完成判定以「本轮真的开始过」为准，且这个判定发生在 runStartedAt 被清空之前。
  const notify = source.slice(source.indexOf("private notifyAgentRunCompleteIfIdle"), source.indexOf("autoTitleAfterRun(): void"));
  assert.match(notify, /const runHadStarted = this\.runStartedAt !== null;/, "the run-started flag is captured before the reset");
  assert.match(notify, /if \(!runHadStarted\) return;/, "no run → no completion record");
  // 副作用的顺序：判定在 autoTitle / autoApproveTeam 之前。
  assert.ok(
    notify.indexOf("if (!runHadStarted) return;") < notify.indexOf("this.autoApproveTeamAfterRun();"),
    "the guard must precede the team auto-approval",
  );
});