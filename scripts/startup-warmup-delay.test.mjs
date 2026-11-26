import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * SDK 预热必须**等首个响应发出之后**，而不是靠固定延迟。
 *
 * 两轮实测：
 * 1. 原实现（register 末尾直接 import）：桌面壳首探针 `GET /api/desktop/identity` 4655ms，
 *    期间事件循环被占 4431ms。那 4.4 秒是 SDK 解码/编译在主线程上跑，不是路由自己的
 *    （那条路由只读一个环境变量）。
 * 2. 第一版修法（延后 1.5 秒）：首响应降到 **76ms**（对了），但阻塞**挪到了连接之前**
 *    ——首个连接从 +1.0s 变 +4.6s，总时长没省。等于只是让观察者看到的数字好看。
 *
 * 现在的口径：launcher 在首个响应 `finish` 时置 `globalThis.__piFirstResponseSent`，
 * instrumentation 轮询它（最多等 10 秒，探针不来也不能永远不预热），确认之后才预热。
 */
const instrumentation = readFileSync(new URL("../instrumentation-node.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const launcher = readFileSync(new URL("../desktop/server-launcher.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the launcher publishes a flag when the first response is actually sent", () => {
  assert.match(launcher, /globalThis\.__piFirstResponseSent = true/, "launcher 要在首响应 finish 时置标记");
  // 必须在 first response 日志的同一个 finish 回调里——不能在 request 到达时就置，
  // 那时预热会和「正在处理的这个请求」抢线程。
  const finishAt = launcher.indexOf('response?.once?.("finish"');
  const flagAt = launcher.indexOf("__piFirstResponseSent = true");
  assert.ok(finishAt > 0 && flagAt > finishAt, "标记要落在 finish 回调里");
});

test("the warm-up waits for that flag instead of a fixed delay", () => {
  assert.match(instrumentation, /__piFirstResponseSent/, "预热要轮询标记");
  assert.match(instrumentation, /__piFirstResponseSent === true \|\| Date\.now\(\) >= deadline/, "标记为真或超时才继续");
  assert.match(instrumentation, /10_000/, "要有上限：探针不来也不能永远不预热");
});

test("delay 0 still warms immediately (comparison escape hatch)", () => {
  assert.match(instrumentation, /warmDelayMs <= 0/, "0 走立即分支");
});

test("the fixed-delay version is gone (it only moved the block, did not remove it)", () => {
  assert.doesNotMatch(
    instrumentation,
    /setTimeout\(warmUp, warmAfterStartupMs\)/,
    "固定延迟版本已被实测证伪，不许回来",
  );
  assert.doesNotMatch(
    instrumentation,
    /\n {2}import\("@earendil-works\/pi-coding-agent"\)\.catch\(\(\) => \{\}\);/,
    "register() 末尾直接 import 更不许回来",
  );
});

test("the polling timers are unref'd and the warm-up is timed", () => {
  assert.match(instrumentation, /timer\.unref\?\.\(\)/, "预热定时器要 unref");
  assert.match(instrumentation, /again\.unref\?\.\(\)/, "轮询定时器也要 unref，否则进程退不出去");
  assert.match(instrumentation, /instrumentation: sdk-warmup took/, "预热要记账");
});
