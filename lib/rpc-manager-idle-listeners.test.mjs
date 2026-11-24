import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

/**
 * rpc-manager 审计 D5：10 分钟空闲定时器与 `idleCapCandidate()` 对「在用」的判据
 * 曾经不一致。
 *
 * 定时器只看 `isRunning()` 与 liveness provider，而 cap 判据还排除 `listeners`、
 * `pendingUiRequests`、`activeCustomUis`、`composerQueue`。于是「有 SSE 在流、或
 * 扩展对话框正等人回答」的会话会在 10 分钟静默后被连人带流拆掉：`session_shutdown`
 * → SSE `cleanup(true)` → 重连冷启动重读 JSONL，扩展内存状态与在途 UI 全部重来。
 * 选中会话之所以侥幸没事，靠的是浏览器每 30s 续租——而后台标签页、手机挂起、只连
 * SSE 的消费者都没有那个租约。
 *
 * 修法：定时器回调改用与 cap 同源的判据；`onEvent` 订阅/退订都重新 arm 定时器。
 */
const root = mkdtempSync(join(tmpdir(), "pi-web-idle-listeners-"));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

test("a session with an SSE listener is not reaped by the idle timer", async () => {
  const sessionFile = join(root, "listened.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "s-listen", timestamp: new Date().toISOString(), cwd: root }) + "\n", "utf8");
  process.env.PI_WEB_IDLE_TIMEOUT_MS = "250";
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const wrapper = new AgentSessionWrapper("s-listen", sessionFile, root, { sessionFile });
  const unsubscribe = wrapper.onEvent(() => {});
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(wrapper.isAlive(), true, "a stream is attached; the session is in use");
  unsubscribe();
  wrapper.destroy();
  delete process.env.PI_WEB_IDLE_TIMEOUT_MS;
});

test("the idle timer and the cap agree about what `in use` means", async () => {
  // Source-level: both lists must mention the same four collections. A future edit
  // that teaches one of them a new one and forgets the other is what caused D5.
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const timer = source.slice(source.indexOf("this.idleTimer = setTimeout("), source.indexOf("private persistBashOnlySession"));
  const cap = source.slice(source.indexOf("idleCapCandidate(now"), source.indexOf("onDestroy(cb"));
  for (const guard of ["this.listeners.size > 0", "this.pendingUiRequests.size > 0", "this.activeCustomUis.size > 0", "this.composerQueue.snapshot().length > 0"]) {
    assert.ok(timer.includes(guard), `the idle timer must consider ${guard}`);
    assert.ok(cap.includes(guard), `…and so must the cap (${guard})`);
  }
});