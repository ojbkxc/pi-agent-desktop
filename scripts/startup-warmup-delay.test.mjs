import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * SDK 预热必须**让开首个请求**。
 *
 * 实测（用新加的启动分段计时抓到的）：桌面壳的首个探针 `GET /api/desktop/identity` 花了
 * **4655ms**，期间事件循环被占 **4431ms**。那条路由本身只读一个环境变量——4.4 秒不是它的，
 * 是 `import("@earendil-works/pi-coding-agent")` 在主线程上解码/编译整棵 SDK。
 *
 * 旧注释的假设是「预热与打开浏览器重叠」，但那次 import 比浏览器快，于是它和首个请求撞在
 * 一起，把「马上返回 204」的探针拖成 4.6 秒，桌面壳还会因此打一条
 * `server is alive but not answering`（误报）。
 *
 * 修法：延后一拍再预热（默认 1.5s，`PI_WEB_WARMUP_DELAY_MS` 可调，设 0 则立刻预热）。
 */
const source = readFileSync(new URL("../instrumentation-node.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the SDK warm-up is deferred instead of racing the first request", () => {
  assert.match(source, /PI_WEB_WARMUP_DELAY_MS/, "延迟要可调");
  assert.match(source, /setTimeout\(warmUp, warmAfterStartupMs\)/, "默认走延迟路径");
  // 旧形态：register() 末尾直接 import()——那正是和首请求抢主线程的写法。
  assert.doesNotMatch(
    source,
    /\n  import\("@earendil-works\/pi-coding-agent"\)\.catch\(\(\) => \{\}\);/,
    "不能再在 register() 末尾直接 import",
  );
});

test("setting the delay to 0 still warms immediately (escape hatch kept)", () => {
  assert.match(source, /warmAfterStartupMs > 0/, "0 要走立即分支");
  assert.match(source, /} else \{\s*\n\s*warmUp\(\);/, "立即分支必须存在");
});

test("the warm-up is timed, so a slow one shows up instead of hiding", () => {
  assert.match(source, /instrumentation: sdk-warmup took/, "预热也要记账");
});

test("the timer does not hold the process open", () => {
  assert.match(source, /\.unref\?\.\(\)/, "延迟定时器必须 unref，否则进程退不出去");
});
