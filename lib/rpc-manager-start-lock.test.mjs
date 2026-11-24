import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * rpc-manager 审计 D4（P2）：`startRpcSession` 的互斥槽在 `locks.set` 之前有 await 窗口。
 *
 * 两条 chat 路径在那之间会挂起（新 chat 的 `await createChatFolder()`、已有 chat 的
 * `await ensureChatCwd()`），顺序是「查 registry → 查 locks → 建 session → 最后
 * locks.set」。两个并发 start 都读到空锁、各建 wrapper、各自 `registerRpcWrapper` 同一
 * id：后者覆盖前者，并用 `onDestroy(() => {})` 把前者的注销回调换成空操作——前一个
 * wrapper 不可达、不会被 registry 清理，还要占着同一个 JSONL 文件的写者位直到自己的
 * 10 分钟空闲定时器收掉。旧 `finally` 还是**无条件** `locks.delete`，A 的 finally 会删掉
 * B 刚装的锁，于是能拉出第三个会话。
 *
 * 修法：进函数就占位（deferred ticket），`locks.set` 发生在第一个 await 之前；释放走
 * 归属校验（只删自己那张票），成功路径在 register 之后、settle 之前释放。
 *
 * 这些是时序性质，源级断言钉的是「代码形状不再允许那种交错」——真跑需要桩化整个 SDK
 * 会话（审计报告 R4 亦标注为静态推断）。
 */
// The file is a CRLF checkout; normalise so the anchors below are written once.
const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the start slot is claimed before any await, not after session creation", () => {
  // 占位必须在第一个 await 之前：ticket 与 locks.set 出现在 startOwned 之前。
  const setAt = source.indexOf("locks.set(sessionId, lockTicket)");
  const ownedAt = source.indexOf("async function startOwned(");
  const chatFolderAwait = source.indexOf("await createChatFolder()");
  assert.ok(setAt > 0, "the slot must be claimed via an explicit lock ticket");
  assert.ok(ownedAt > 0, "the body must live in its own function");
  assert.ok(setAt < ownedAt, "claim the slot before entering the body");
  assert.ok(setAt < chatFolderAwait, "…and before the chat-folder await that opened the window");
});

test("releasing the slot is ownership-checked, and the old unconditional delete is gone", () => {
  // 只删自己那张票。
  assert.match(source, /if \(locks\.get\(sessionId\) === lockTicket\) locks\.delete\(sessionId\);/);
  // 旧的 finally 无条件删锁（会把别人刚装的锁删掉）必须消失。
  assert.doesNotMatch(source, /\}\)\(\)\.finally\(\(\) => \{\s*locks\.delete\(sessionId\);/, "the unconditional delete must be gone");
  // 成功路径也释放（否则残留 resolved 票会让下一次 start 直接拿到旧 wrapper）。
  const releaseCalls = source.split("releaseLock();").length - 1;
  assert.ok(releaseCalls >= 2, `release must happen on both paths, found ${releaseCalls}`);
  const settleAt = source.indexOf("settleLock?.({ session: wrapper, realSessionId })");
  const successRelease = source.lastIndexOf("releaseLock();", settleAt);
  assert.ok(successRelease > 0 && successRelease < settleAt, "release before settling the waiters");
});

test("a failed start both rejects the shared ticket and clears the slot", () => {
  const catchBlock = source.slice(source.indexOf("} catch (error) {\n    failLock?.(error);"), source.indexOf("async function startOwned("));
  assert.match(catchBlock, /failLock\?\.\(error\)/, "waiters must see the failure, not hang");
  assert.match(catchBlock, /releaseLock\(\)/, "and the slot must not stay claimed");
  assert.match(catchBlock, /throw error/, "the caller still gets the original error");
  // 启动计数（trackStartingSession）的收尾仍在 finally 里，不因为结构化改造丢失。
  assert.match(source, /finishStartingSession\(\);/);
});