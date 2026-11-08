import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * d5-7/d5-8 接线守卫（AppShell.tsx + hooks/useAgentSession.ts）。
 *
 * d5-7：fork 落地时无守卫地把当前 selectedSession 整体展开合并进 fork 会话——
 * await fork 期间用户手动切走后产生 {...别的会话, id: forkId} 混合态，hydrate
 * 失败时被固化（标题/cwd/同项目判定全错）。
 * d5-8：会话打开的 detail fetch 无代际——两次快速点击按完成序落地，过期响应
 * 覆盖最后一次点击。
 */

const shell = (await read("./AppShell.tsx")).replace(/\r\n/g, "\n");
const sessionHook = (await read("../hooks/useAgentSession.ts")).replace(/\r\n/g, "\n");

async function read(file) {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  return readFile(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `找不到起点：${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `找不到终点：${endMarker}`);
  return source.slice(start, end);
}

test("d5-7：fork 落地带来源会话守卫——用户切走则放弃就地合并与跳转", () => {
  const body = sliceBetween(
    shell,
    "const handleSessionForked = useCallback((newSessionId: string, sourceSessionId?: string) => {",
    "const handleAskInNewChat",
  );
  // 渲染期镜像 ref 存在（await 期间用户切换后回调可读到最新值）。
  assert.match(shell, /const selectedSessionIdRef = useRef<string \| null>\(null\);/);
  assert.match(shell, /selectedSessionIdRef\.current = selectedSession\?\.id \?\? null;/);
  // 守卫：来源会话与当前选中不一致 → 放弃合并 + 跳转；hydrate 仍后台回填。
  assert.match(body, /const switchedAway = Boolean\(\s*sourceSessionId/);
  assert.match(body, /if \(!switchedAway\) \{[\s\S]*?setSelectedSession\(\(prev\) => \(\{/);
  assert.match(body, /router\.replace\(`\?session=\$\{encodeURIComponent\(newSessionId\)\}`/);
  assert.match(body.slice(body.indexOf("if (!switchedAway) {")), /hydrateSelectedSession\(newSessionId\);/, "hydrate 必须在守卫之外（两种分支都回填）");
  // handleSessionCreated 的既有代际守卫仍在（不许为修复拆掉参照物）。
  assert.match(shell, /activeNewSessionDraftKeyRef\.current !== sourceDraftKey/);
});

test("d5-7：useAgentSession 的 fork/clone 落地都携带来源会话 id", () => {
  // 类型签名已加宽（可选第二参，向后兼容）。
  assert.match(sessionHook, /onSessionForked\?: \(newSessionId: string, sourceSessionId\?: string\) => void;/);
  const forkBody = sliceBetween(sessionHook, "const handleFork = useCallback", "const handleNavigate = useCallback");
  assert.match(forkBody, /onSessionForked\?\.\(newSessionId, sid\);/);
  const cloneBody = sliceBetween(sessionHook, 'case "clone":', "default:");
  assert.match(cloneBody, /onSessionForked\?\.\(result\.newSessionId, sid\);/);
});

test("d5-8：会话打开与 artifact 继续共用单调请求号，过期响应不落地", () => {
  assert.match(shell, /const openSessionRequestRef = useRef\(0\);/);
  const openBody = sliceBetween(
    shell,
    "const handleOpenSession = useCallback(async (sessionId: string, entryId?: string) => {",
    "const openWorkspaceView",
  );
  // 入口即自增（同步目录命中路径也压制在途 fetch）。
  assert.match(openBody, /const requestId = \+\+openSessionRequestRef\.current;/);
  assert.match(openBody, /if \(requestId !== openSessionRequestRef\.current\) return;\n?\s*handleSelectSession\(data\.info/);
  const continueBody = sliceBetween(
    shell,
    "const handleContinueArtifact = useCallback(async (",
    "const handleInitialRestoreDone",
  );
  assert.match(continueBody, /const requestId = \+\+openSessionRequestRef\.current;/);
  // 过期时不注入引用提示（pendingQuotePrompt）也不选中。
  assert.match(
    continueBody,
    /if \(requestId !== openSessionRequestRef\.current\) return;\s*\n?\s*setPendingQuotePrompt\(/,
  );
});
