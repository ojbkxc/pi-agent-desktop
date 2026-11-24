import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * server-launcher 的孤儿看门狗必须有三条判据（2026-11-24 实测踩到）。
 *
 * 现象：App 被强杀后留下一个旧 server 进程（17:16 起），新实例又起一个（20:05），
 * 两个同时监听不同端口。旧那个占着内存与端口，用户只能手动清。
 *
 * 根因不是「没有看门狗」——日志里能看到它多次正常触发（`desktop shell (pid N) is
 * gone; server exiting`）。漏的是 **Windows 上父进程死掉后 `process.ppid` 不会变成
 * 1**，而 `kill(pid, 0)` 在 PID 被系统复用时会对一个无关进程返回成功：两条判据同时
 * 放行，server 就留在那儿了。
 *
 * 所以第三条 `process.ppid !== expectedParentPid` 是 Windows 上唯一可靠的「父已换人」
 * 信号，且必须**排在 kill 之前**判。
 */
const source = readFileSync(new URL("../desktop/server-launcher.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const watchdog = source.slice(source.indexOf("const parentWatchdog"), source.indexOf("parentWatchdog.unref()"));

test("the watchdog treats `ppid === 1` as orphaned (the Unix signal)", () => {
  assert.match(watchdog, /process\.ppid === 1/);
});

test("it also treats a changed ppid as orphaned, before asking kill()", () => {
  assert.match(watchdog, /process\.ppid !== expectedParentPid/, "the reparent check must exist");
  const reparentAt = watchdog.indexOf("process.ppid !== expectedParentPid");
  const killAt = watchdog.indexOf("process.kill(expectedParentPid, 0)");
  assert.ok(reparentAt > 0 && killAt > 0);
  assert.ok(reparentAt < killAt, "ppid is the reliable signal on Windows; check it before kill() can lie");
});

test("it still exits when the parent pid is simply gone", () => {
  assert.match(watchdog, /catch \{[\s\S]*?server exiting[\s\S]*?process\.exit\(0\)/);
});

test("the watchdog is unref'd so it never keeps the process alive on its own", () => {
  assert.match(source, /parentWatchdog\.unref\(\)/);
});
