import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * SDK 预热必须**等首个响应发出之后**才开始。
 *
 * 三轮实测，每轮都推翻上一轮：
 * 1. 原实现（register 末尾直接 import）：首探针 4655ms，事件循环被占 4431ms。
 * 2. 第一版修法（延后 1.5 秒）：首响应 76ms（对了），但阻塞挪到连接之前（首个连接
 *    +1.0s → +4.6s），总时长没省。
 * 3. 第二版修法（等首响应标记）——**闸门从来没启用**：默认值写成 0，而 0 被解释成
 *    「立即预热」。实测日志里 `sdk-warmup took 154 ms` 出现在首响应**之前**，
 *    4.5 秒阻塞原样存在。
 *
 * 现在：默认 0 = **等首响应就开**（不是立即）；`-1` 才是旧的立即预热（对照用）。
 *
 * 这条测试钉住「默认必须走等待分支」——这是第 3 轮翻车的地方：代码看起来有闸门，但默认
 * 走的是另一条路，光看有没有 `__piFirstResponseSent` 是发现不了的。
 */
const source = readFileSync(new URL("../instrumentation-node.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const launcher = readFileSync(new URL("../desktop/server-launcher.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the DEFAULT env value routes into the waiting branch, not the immediate one", () => {
  // 默认值（env 未设时的 fallback）必须是 0 …
  assert.match(source, /PI_WEB_WARMUP_DELAY_MS \?\? "0"/, "默认值是 0");
  // … 而 0 必须被判成「等待」，不是「立即」。立即分支只留负数。
  assert.match(source, /warmDelayMs < 0/, "只有负值走立即分支");
  assert.doesNotMatch(source, /warmDelayMs <= 0/, "`<= 0` 会让默认值走立即分支 —— 正是第 3 轮翻车的原因");
});

test("zero delay still waits for the flag (zero = `as soon as the response is sent`)", () => {
  assert.match(source, /warmDelayMs > 0 \? warmDelayMs : 0/, "0 要落成「等到标记、再等 0ms」");
  const waitAt = source.indexOf("const waitForFirstResponse");
  // 立即分支（负值）在等待分支**之前**的 if 里；关键是「默认值不能走到它」，
  // 所以断言两侧都在、且等待分支确实被调用。
  assert.ok(waitAt > 0, "等待分支必须存在");
  assert.match(source, /waitForFirstResponse\(\);/, "等待分支必须真的被调用");
  assert.match(source, /\} else \{[\s\S]{0,80}const delay = /, "else 分支里算 delay 并等待");
});

test("the gate polls the flag the launcher sets on the first response's finish", () => {
  assert.match(source, /__piFirstResponseSent === true/, "要轮询标记");
  assert.match(source, /10_000/, "要有 10 秒上限");
  const finishAt = launcher.indexOf('response?.once?.("finish"');
  const flagAt = launcher.indexOf("__piFirstResponseSent = true");
  assert.ok(finishAt > 0 && flagAt > finishAt, "标记必须落在 finish 回调里，不能是 request 到达时");
});

test("the warm-up is timed so a mis-gated build shows up in the log", () => {
  // 这次就是靠这条日志发现闸门没启用的（sdk-warmup 出现在首响应之前）。
  assert.match(source, /instrumentation: sdk-warmup took/, "预热必须记账");
});

test("timers are unref'd", () => {
  assert.match(source, /timer\.unref\?\.\(\)/);
  assert.match(source, /again\.unref\?\.\(\)/);
});