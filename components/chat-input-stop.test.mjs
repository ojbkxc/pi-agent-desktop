import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 流式期间的停止按钮必须**一直可达**（用户报的「停止对话很多会失灵」）。
 *
 * 旧口径：`showStop = isStreaming && !canQueueStreamingMessage`。也就是说——只要输入框里
 * 有字、或者挂了图片/附件，主按钮就变成「排队发送」，**停止入口当场消失**。用户一边打字
 * 一边想停（尤其是启动团队后成员还在跑的时候），看到的就是「点不动 / 没反应」。
 *
 * 停止是不可替代的紧急动作，排队不是：Enter 在流式期间本来就调 `sendQueued`，那条路没断。
 */
const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the primary button is Stop whenever a run is streaming", () => {
  assert.match(source, /const showStop = isStreaming;/, "no content-dependent condition may hide Stop");
  assert.doesNotMatch(
    source,
    /const showStop = isStreaming && !canQueueStreamingMessage/,
    "the old `&& !canQueueStreamingMessage` is what made Stop disappear",
  );
});

test("queueing while streaming still has an entry point (Enter)", () => {
  // keydown 分支里 isStreaming 时走 sendQueued —— 按钮不再承担排队，键盘仍然可以。
  const keydown = source.slice(source.indexOf("if (sendShortcut) {"), source.indexOf("if (sendShortcut) {") + 400);
  assert.match(keydown, /sendQueued\(onFollowUp \? "followup" : "steer"\)/, "Enter still queues while streaming");
});

test("the button wiring still aborts on click when stopping", () => {
  assert.match(source, /onClick=\{showStop \? onAbort :/, "clicking Stop still calls onAbort");
  assert.match(source, /data-action=\{showStop \? "stop"/, "and the DOM still says it is a stop action");
});
