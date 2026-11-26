import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 启动分段计时必须覆盖**每一个**同步子系统。
 *
 * 背景：桌面壳看门狗每次启动都报两条「事件循环被阻塞 3.5–15 秒」，而 Next 的
 * `Ready in 0ms` 之后到 public-access 第一次输出之间有 **2.8 秒零日志**的空档。
 * 那段时间全落在 `registerNodeInstrumentation()` 里那串同步 `start*()` 调用上，但以前
 * 没有任何一处记录自己花了多久——所以只能猜。
 *
 * 这条测试钉住：新增一个启动子系统却忘了包 `timed(...)` 时，这里会红。
 */
const source = readFileSync(new URL("./instrumentation-node.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const body = source.slice(source.indexOf("export function registerNodeInstrumentation"));

/** 每一个已知的启动子系统：调用名 → 它必须在 timed/timedAsync 里被调。 */
const SUBSYSTEMS = [
  ["configureHttpDispatcher", "timed"],
  ["startScheduler", "timed"],
  ["startAutofixSweepLoop", "timed"],
  ["startCampaignSweep", "timed"],
  ["startKeepalive", "timed"],
  ["startUnattendedSweepLoop", "timed"],
  ["restartRelayFromConfig", "timedAsync"],
  ["restartPublicAccessFromConfig", "timedAsync"],
];

test("every startup subsystem is wrapped in a timer", () => {
  for (const [call, wrapper] of SUBSYSTEMS) {
    // 形态是 `timed("名字", () => call(...))`：先匹配包装器 + 一个箭头函数，再要求它调到
    // 那个子系统。不能写成 `timed\([^)]*call\(`——`()` 里的 `)` 会让 [^)]* 提前中断。
    const wrapped = new RegExp(`${wrapper}\\(\\s*"[^"]+"\\s*,\\s*\\(\\)\\s*=>\\s*${call}\\(`);
    assert.match(
      body,
      wrapped,
      `${call} 必须包在 ${wrapper}(...) 里，否则启动慢的时候又只能猜`,
    );
  }
});

test("the timers are silent below the threshold and print above it", () => {
  // 阈值存在的意义：正常启动不该多出 7 行噪声，只有真的慢才值得记。
  assert.match(source, /elapsed >= 50/, "只记 >= 50ms 的段");
  assert.match(source, /instrumentation: \$\{name\} took \$\{elapsed\} ms/, "日志要能看出是哪一段");
});

test("timing never changes behaviour: the wrapped call's value is returned", () => {
  // timed() 是纯包装：`finally` 里记账、`return run()` 原样返回。写反成 `finally { return run() }`
  // 会吞掉异常，那才是真的改行为。
  const timedAt = source.indexOf("function timed<");
  const block = source.slice(timedAt, source.indexOf("function timedAsync"));
  assert.match(block, /return run\(\)/, "要 return run() 的结果");
  assert.doesNotMatch(block, /catch\s*\{/, "不能吞掉同步异常——那会让启动失败变成静默");
});
