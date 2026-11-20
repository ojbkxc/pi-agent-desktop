import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source-level guard: the unattended-session dialog policy must cover BOTH
// blocking request paths (select/confirm/input/editor AND the custom overlay),
// and must stay off the non-blocking notify/setStatus paths. This is checked by
// reading rpc-manager.ts, because the policy is wiring, not a value the tests
// can execute without a live session.
const source = (await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

/**
 * Slice one class member body: from its signature to the next top-level member
 * (field or method), so an assertion can't accidentally see a line from a
 * neighbouring method. Anchors are full signatures to avoid prefix-substring
 * matches (e.g. `requestExtensionUi(` is a substring of `requestExtensionCustomUi(`).
 */
function methodBody(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing start anchor: ${signature}`);
  const afterSig = start + signature.length;
  const next = source.slice(afterSig).search(/\n {2}(?:private|public|protected|async|get|set|static|readonly) /);
  assert.ok(next >= 0, `no following member after: ${signature}`);
  return source.slice(start, afterSig + next);
}

test("select/confirm/input/editor 与 custom 两条请求路径都接入 autopilot 对话框策略", () => {
  const custom = methodBody("private requestExtensionCustomUi<T>(");
  const dialog = methodBody("private requestExtensionUi<T>(");
  for (const [name, body] of [["requestExtensionCustomUi", custom], ["requestExtensionUi", dialog]]) {
    assert.match(body, /resolveAutopilotDialogTimeout\(/, `${name} 应调用 resolveAutopilotDialogTimeout`);
    assert.match(body, /autopilotSession:\s*this\.isAutopilotSession\(\)/, `${name} 应传入 this.isAutopilotSession()`);
    assert.match(body, /settings:\s*readAutopilotSettings\(\)/, `${name} 应传入 readAutopilotSettings()`);
  }
});

test("custom 覆盖层在无人值守超时后自行关闭并清理定时器", () => {
  const custom = methodBody("private requestExtensionCustomUi<T>(");
  assert.match(custom, /setTimeout\(/, "custom 应设置超时定时器");
  assert.match(custom, /clearTimeout\(closeTimer\)/, "finish 应清理超时定时器");
  assert.match(custom, /done\(undefined as T\)/, "超时应以「未应答」关闭覆盖层");
  assert.match(custom, /\.unref\?\.\(\)/, "定时器应 unref，避免拖住进程退出");
  assert.match(custom, /console\.warn\(/, "超时自动关闭应打一条 warn 日志");
});

test("notify / setStatus 非阻塞路径不接入对话框超时（保持原样）", () => {
  const notify = source.slice(
    source.indexOf("notify: (message, type) => {"),
    source.indexOf("onTerminalInput:"),
  );
  const setStatus = source.slice(
    source.indexOf("setStatus: (key, text) => {"),
    source.indexOf("setWorkingMessage:"),
  );
  assert.ok(notify.includes("notify: (message, type) => {") && notify.includes("extension_ui_request"), "应能定位 notify 处理器");
  assert.ok(setStatus.includes("setStatus: (key, text) => {") && setStatus.includes("extension_ui_request"), "应能定位 setStatus 处理器");
  assert.doesNotMatch(notify, /resolveAutopilotDialogTimeout/, "notify 不应接入对话框超时");
  assert.doesNotMatch(setStatus, /resolveAutopilotDialogTimeout/, "setStatus 不应接入对话框超时");
});
