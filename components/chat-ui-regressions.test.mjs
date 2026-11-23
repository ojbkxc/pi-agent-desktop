import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * chat-ui 审计 D4/D5/D6 的源级契约回归：
 *
 * D5 内置命令 15s 超时计时器：命令先回来必须 clearTimeout，否则每个快命令
 *   都往事件循环里挂一个 15 秒的孤儿计时器（连发即堆积）。
 * D6 `@` 文件索引 fetch：跨 cwd 交错时 stale 响应不落地——以 cancelled 标志
 *   + fileIndexFetchingRef 当前值双重判。
 * D4 useStreamingSelector 的 select 必须模块级稳定：内联箭头每渲染一新函数，
 *   effect 依赖 [store, select] 每次退订重订。该 hook 自身的文档就写着
 *   "select must be stable (a module-level function)"。
 */
const chatInputSource = readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
const chatWindowSource = readFileSync(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const selectorSource = readFileSync(new URL("../hooks/useStreamingSelector.ts", import.meta.url), "utf8");

test("the builtin-command race clears its timeout timer when the command resolves first", () => {
  // 超时 Promise 里必须把 setTimeout 的句柄存进 timeoutId，race 之后 clearTimeout。
  assert.match(chatInputSource, /timeoutId = setTimeout\(/, "the timer handle must be captured");
  const raceBlock = chatInputSource.slice(chatInputSource.indexOf("timeoutId = setTimeout("));
  assert.match(raceBlock.slice(0, 500), /clearTimeout\(timeoutId\)/, "the race result path must clear it");
  // 旧写法（裸 setTimeout 不接句柄）必须消失。
  assert.doesNotMatch(chatInputSource, /setTimeout\(\(\) => resolve\(timedOut\), BUILTIN_COMMAND_TIMEOUT_MS\)\)/);
});

test("the @-mention file-index fetch refuses to land stale cross-cwd responses", () => {
  // fetch 块必须携带 cancelled 标志与 fetchCwd 的当前值比对。
  const effect = chatInputSource.slice(
    chatInputSource.indexOf("Fetch the file index when the menu opens"),
    chatInputSource.indexOf("const applyAtCompletion"),
  );
  assert.match(effect, /let cancelled = false/, "the effect needs a cancellation flag");
  assert.match(effect, /return \(\) => \{\s*cancelled = true/, "cleanup sets it");
  assert.match(effect, /if \(cancelled \|\| fileIndexFetchingRef\.current !== fetchCwd\) return/, "a late response from another cwd must not land");
  assert.match(effect, /if \(!cancelled\) setFileIndexLoading\(false\)/, "loading is owned by the live request only");
});

test("the streaming artifact selector is module-level, not an inline arrow at the call site", () => {
  assert.match(selectorSource, /export const selectStreamingArtifactMessage = /, "the selector lives in the hook module with its siblings");
  assert.doesNotMatch(chatWindowSource, /useStreamingSelector\(streamingStore, \(state\) =>/, "no inline selectors may remain at the call site");
  assert.match(chatWindowSource, /useStreamingSelector\(streamingStore, selectStreamingArtifactMessage\)/, "ChatWindow consumes the stable one");
});